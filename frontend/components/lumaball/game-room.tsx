"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleHelp,
  Copy,
  Menu,
  Expand,
  Flag,
  LoaderCircle,
  LockKeyhole,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Send,
  ShieldCheck,
  Square,
  Users,
  Wifi,
  X,
} from "lucide-react";
import {
  FootballEngine,
  normalizeInput,
  validFrame,
  type GameFrame,
  type Input,
  type Team,
} from "@/lib/lumaball/engine";
import { GamePeers } from "@/lib/lumaball/peers";
import { SnapshotInterpolator } from "@/lib/lumaball/snapshot-interpolator";
import { requestGameSession } from "@/lib/lumaball/session-queue";
import {
  MatchResultDelivery,
  roomInvitationUrl,
  teamsReady,
} from "@/lib/lumaball/room-state";
import { FootballRenderer } from "@/lib/lumaball/render";
import {
  gameRequest,
  type ChatMessage,
  type Command,
  type Identity,
  type Room,
  type Session,
} from "@/lib/lumaball/types";
import styles from "./game-room.module.css";
import { useQBall } from "./context";

type RoomView = Room & { is_member?: boolean };
const zero = (): Input => ({ x: 0, y: 0, kick: false });
const timeLabel = (seconds: number) =>
  `${Math.floor(Math.max(0, seconds) / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(Math.max(0, seconds) % 60)
    .toString()
    .padStart(2, "0")}`;
const statusLabels: Record<Room["status"], string> = {
  lobby: "Сбор игроков",
  playing: "Матч идёт",
  paused: "Пауза",
  finished: "Матч завершён",
  closed: "Комната закрыта",
};

export default function GameRoom({ roomId }: { roomId: string }) {
  const router = useRouter();
  const { setRoomActive } = useQBall();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [connection, setConnection] = useState<
    "connecting" | "online" | "reconnecting" | "closed"
  >("connecting");
  const [error, setError] = useState("");
  const [needsJoin, setNeedsJoin] = useState(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [joining, setJoining] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [sessionConfig, setSessionConfig] = useState<Session["config"] | null>(
    null,
  );
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [score, setScore] = useState({ red: 0, blue: 0 });
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [directCount, setDirectCount] = useState(0);
  const [help, setHelp] = useState(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState(true);
  const [stick, setStick] = useState({ x: 0, y: 0 });
  const [kicking, setKicking] = useState(false);
  const [retry, setRetry] = useState(0);
  const [inviteNotice, setInviteNotice] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const roomRef = useRef<RoomView | null>(null);
  const identityRef = useRef<Identity | null>(null);
  const engineRef = useRef<FootballEngine | null>(null);
  const peersRef = useRef<GamePeers | null>(null);
  const frameRef = useRef<GameFrame | null>(null);
  const snapshotsRef = useRef(new SnapshotInterpolator());
  const inputRef = useRef(zero());
  const kickSequenceRef = useRef(0);
  const keysRef = useRef(new Set<string>());
  const touchRef = useRef(zero());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const arenaRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const invitationRef = useRef<HTMLInputElement>(null);

  const send = useCallback((value: unknown) => {
    const socket = socketRef.current;
    if (
      socket?.readyState === WebSocket.OPEN &&
      socket.bufferedAmount < 128 * 1024
    ) {
      try {
        socket.send(JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, []);

  useEffect(() => {
    setRoomActive(connection === "online");
    return () => setRoomActive(false);
  }, [connection, setRoomActive]);

  useEffect(() => {
    const snapshots = snapshotsRef.current;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnects = 0;
    let lastMatch = "";
    let permanent = false;
    setConnection("connecting");
    setError("");
    setNeedsJoin(false);
    const acceptRoom = (value: RoomView) => {
      if (disposed) return;
      if (roomRef.current?.match_id !== value.match_id) {
        frameRef.current = null;
        snapshots.reset();
      }
      roomRef.current = value;
      setRoom(value);
      if (Array.isArray(value.chat)) setChat(value.chat.slice(-80));
      peersRef.current?.sync(value);
      if (
        value.host_id === identityRef.current?.id &&
        ["playing", "paused"].includes(value.status)
      ) {
        const key = value.match_id || value.id;
        if (!engineRef.current || lastMatch !== key) {
          engineRef.current = new FootballEngine(
            value.members,
            value.score_limit,
            value.time_limit,
          );
          lastMatch = key;
        } else engineRef.current.syncMembers(value.members);
      } else if (value.status === "lobby") {
        engineRef.current = null;
        lastMatch = "";
        frameRef.current = new FootballEngine(
          value.members,
          value.score_limit,
          value.time_limit,
        ).frame();
        frameRef.current.kickoff = 0;
        frameRef.current.score = value.score || { red: 0, blue: 0 };
        setScore(value.score || { red: 0, blue: 0 });
        setElapsedSeconds(0);
      } else if (value.status === "finished") {
        setScore(value.score);
        {
          const preview =
            frameRef.current ||
            new FootballEngine(
              value.members,
              value.score_limit,
              value.time_limit,
            ).frame();
          preview.match_id = value.match_id || "";
          preview.score = value.score;
          preview.remaining = 0;
          preview.kickoff = 0;
          preview.finished = true;
          preview.winner =
            value.score.red === value.score.blue
              ? "draw"
              : value.score.red > value.score.blue
                ? "red"
                : "blue";
          frameRef.current = preview;
          snapshots.reset();
          setElapsedSeconds(Math.floor(preview.elapsed));
        }
      }
    };
    const acceptFrame = (frame: GameFrame) => {
      const current = roomRef.current;
      if (
        disposed ||
        !current ||
        current.host_id === identityRef.current?.id ||
        frame.match_id !== current.match_id ||
        current.status === "finished" ||
        (frameRef.current && frame.seq <= frameRef.current.seq)
      )
        return;
      frameRef.current = frame;
      snapshots.enqueue(frame, performance.now());
    };
    const connect = async (initial = false) => {
      try {
        const session = await requestGameSession<Session>();
        if (disposed) return;
        identityRef.current = session.identity;
        setIdentity(session.identity);
        setSessionConfig(session.config);
        if (initial) window.dispatchEvent(new Event("lumaball:updated"));
        if (initial) {
          const info = await gameRequest<RoomView>(
            "/rooms/" + encodeURIComponent(roomId),
          );
          if (disposed) return;
          acceptRoom(info);
          if (
            info.is_member === false ||
            !info.members.some((m) => m.id === session.identity.id)
          ) {
            setNeedsJoin(true);
            setConnection("closed");
            return;
          }
        }
        peersRef.current?.close();
        peersRef.current = new GamePeers(
          session.identity.id,
          session.ice_servers || [],
          {
            signal: (target, payload) =>
              send({ type: "signal", target, payload }),
            input: (from, input) => engineRef.current?.input(from, input),
            frame: acceptFrame,
            state: () => {
              if (!disposed) setDirectCount(peersRef.current?.connected() || 0);
            },
          },
        );
        const url = new URL("/api/lumaball/ws", window.location.href);
        url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        url.search = new URLSearchParams({
          ticket: session.ws_ticket,
          room: roomId,
        }).toString();
        const socket = new WebSocket(url);
        socketRef.current = socket;
        socket.onmessage = (event) => {
          if (
            disposed ||
            typeof event.data !== "string" ||
            event.data.length > 64 * 1024
          )
            return;
          try {
            const data = JSON.parse(event.data);
            if (data.type === "welcome") {
              reconnects = 0;
              setConnection("online");
              setError("");
              frameRef.current = null;
              snapshots.reset();
              acceptRoom(data.room);
            } else if (data.type === "room") acceptRoom(data.room);
            else if (data.type === "signal")
              void peersRef.current?.signal(data.from, data.payload);
            else if (
              data.type === "input" &&
              roomRef.current?.host_id === identityRef.current?.id
            )
              engineRef.current?.input(data.from, data.input);
            else if (
              data.type === "frame" &&
              roomRef.current?.host_id !== identityRef.current?.id &&
              validFrame(data.frame) &&
              data.frame.match_id === roomRef.current?.match_id
            ) {
              acceptFrame(data.frame);
            } else if (data.type === "chat")
              setChat((before) => [...before, data.message].slice(-80));
            else if (data.type === "error")
              setError(
                typeof data.detail === "string"
                  ? data.detail
                  : "Не удалось выполнить действие",
              );
            else if (data.type === "closed") {
              permanent = true;
              setConnection("closed");
              const reasons: Record<string, string> = {
                host_left:
                  "Создатель комнаты вышел. Выберите другую комнату или создайте свою.",
                host_already_connected:
                  "Матч уже открыт в другой вкладке. Продолжите игру в ней, чтобы сохранить текущий счёт.",
                another_tab:
                  "Комната открыта в другой вкладке. Игра продолжается там.",
                access_revoked:
                  "Доступ к игре изменён. Проверьте свой аккаунт или обратитесь к администратору.",
                administrator: "Администратор закрыл эту комнату.",
                removed:
                  "Вы больше не участвуете в этой комнате. Выберите другую игру.",
                server_stopped:
                  "Сайт перезапускается. Вернитесь к комнатам после запуска.",
                left_room: "Вы вышли из комнаты.",
              };
              setError(
                reasons[data.reason] ||
                  "Комната закрыта. Выберите другую игру или создайте свою.",
              );
              engineRef.current = null;
              peersRef.current?.close();
            }
          } catch {
            /* Bad game packets never interrupt rendering or navigation. */
          }
        };
        socket.onclose = () => {
          peersRef.current?.close();
          if (disposed || permanent) return;
          setConnection("reconnecting");
          inputRef.current = zero();
          if (reconnects++ < 4)
            reconnectTimer = setTimeout(
              () => void connect(),
              Math.min(5000, 800 * 2 ** reconnects),
            );
          else {
            setConnection("closed");
            setError(
              "Связь с комнатой прервалась. Вернитесь в список комнат или попробуйте подключиться снова.",
            );
          }
        };
        socket.onerror = () => {
          /* onclose owns a bounded reconnect with a fresh one-use ticket. */
        };
      } catch (cause) {
        if (!disposed) {
          setConnection("closed");
          setError(
            cause instanceof Error
              ? cause.message
              : "Не удалось открыть комнату",
          );
        }
      }
    };
    void connect(true);
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      socketRef.current = null;
      peersRef.current?.close();
      peersRef.current = null;
      engineRef.current = null;
      roomRef.current = null;
      frameRef.current = null;
      snapshots.reset();
      inputRef.current = zero();
    };
  }, [roomId, retry, send]);

  useEffect(() => {
    let animation = 0;
    let previous = performance.now();
    let lastFrame = previous;
    let lastHud = previous;
    let terminalPublished = "";
    let renderer: FootballRenderer | null = null;
    let renderedCanvas: HTMLCanvasElement | null = null;
    const networkInterval = 1000 / 30;
    const results = new MatchResultDelivery();
    const tick = (now: number) => {
      const elapsed = Math.min((now - previous) / 1000, 0.2);
      previous = now;
      const room = roomRef.current,
        identity = identityRef.current;
      const engine = engineRef.current;
      const host = room?.host_id === identity?.id;
      if (
        host &&
        engine &&
        room &&
        (room.status === "playing" || room.status === "paused")
      ) {
        engine.input(identity!.id, inputRef.current);
        engine.advance(
          elapsed,
          room.status === "playing" &&
            socketRef.current?.readyState === WebSocket.OPEN,
        );
        // Render the current simulation on every animation frame. Publishing
        // snapshots has its own cadence and must never cap the host's display.
        const frame = engine.frame();
        frame.match_id = room.match_id || "";
        frameRef.current = frame;
        if (
          now - lastFrame >= networkInterval ||
          (frame.finished && terminalPublished !== frame.match_id)
        ) {
          if (room.status === "playing" || room.status === "paused") {
            peersRef.current?.frame(frame);
            send({ type: "frame", frame });
          }
          if (frame.finished) terminalPublished = frame.match_id;
          lastFrame = now - ((now - lastFrame) % networkInterval);
        }
        results.report(room, frame, now, send);
      }
      const frame = frameRef.current;
      if (frame && canvasRef.current) {
        if (renderedCanvas !== canvasRef.current) {
          renderer?.destroy();
          renderedCanvas = canvasRef.current;
          renderer = new FootballRenderer(renderedCanvas);
        }
        const display = host
          ? frame
          : snapshotsRef.current.sample(now, room?.status === "playing") ||
            frame;
        renderer?.draw(display, identity?.id || "");
        if (now - lastHud > 150) {
          setScore((current) =>
            current.red === frame.score.red && current.blue === frame.score.blue
              ? current
              : frame.score,
          );
          setElapsedSeconds(Math.floor(frame.elapsed));
          lastHud = now;
        }
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(animation);
      renderer?.destroy();
    };
  }, [send]);

  useEffect(() => {
    const update = () => {
      const keys = keysRef.current;
      inputRef.current = normalizeInput({
        x:
          touchRef.current.x +
          Number(keys.has("KeyD") || keys.has("ArrowRight")) -
          Number(keys.has("KeyA") || keys.has("ArrowLeft")),
        y:
          touchRef.current.y +
          Number(keys.has("KeyS") || keys.has("ArrowDown")) -
          Number(keys.has("KeyW") || keys.has("ArrowUp")),
        kick:
          touchRef.current.kick ||
          keys.has("Space") ||
          keys.has("ShiftLeft") ||
          keys.has("ShiftRight"),
        kick_seq: kickSequenceRef.current,
      });
      const currentRoom = roomRef.current;
      const ownId = identityRef.current?.id;
      if (
        currentRoom?.status === "playing" &&
        currentRoom.host_id !== ownId &&
        currentRoom.members.some(
          (member) => member.id === ownId && member.team !== "spectator",
        )
      ) {
        peersRef.current?.input(inputRef.current);
        send({ type: "input", input: inputRef.current });
      }
    };
    const allowed = new Set([
      "KeyW",
      "KeyS",
      "KeyA",
      "KeyD",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Space",
      "ShiftLeft",
      "ShiftRight",
    ]);
    const key = (event: KeyboardEvent, pressed: boolean) => {
      const target = event.target as HTMLElement | null;
      if (
        pressed &&
        target?.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
      if (event.code === "Space" && target?.closest("button,a,[role=button]")) {
        keysRef.current.delete(event.code);
        update();
        return;
      }
      if (!allowed.has(event.code)) return;
      event.preventDefault();
      const kickKey = ["Space", "ShiftLeft", "ShiftRight"].includes(event.code);
      if (pressed && kickKey)
        kickSequenceRef.current = Math.max(
          kickSequenceRef.current + 1,
          Date.now(),
        );
      else if (pressed && keysRef.current.has(event.code)) return;
      if (pressed) keysRef.current.add(event.code);
      else keysRef.current.delete(event.code);
      update();
    };
    const down = (event: KeyboardEvent) => key(event, true),
      up = (event: KeyboardEvent) => key(event, false);
    const release = () => {
      keysRef.current.clear();
      touchRef.current = zero();
      inputRef.current = zero();
      setStick({ x: 0, y: 0 });
      setKicking(false);
      update();
    };
    const visibility = () => {
      if (document.hidden) release();
    };
    const focus = (event: FocusEvent) => {
      if (
        (event.target as HTMLElement | null)?.closest(
          "input,textarea,select,[contenteditable=true]",
        )
      )
        release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("focusin", focus);
    const interval = setInterval(update, 1000 / 30);
    const heartbeat = setInterval(() => send({ type: "ping" }), 15000);
    return () => {
      clearInterval(interval);
      clearInterval(heartbeat);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("focusin", focus);
    };
  }, [send]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [chat.length]);

  const command = (action: Command["action"], target?: string, team?: Team) => {
    setError("");
    if (!send({ type: "command", action, target, team }))
      setError("Соединение занято. Повторите действие через несколько секунд.");
    else canvasRef.current?.focus({ preventScroll: true });
  };
  const join = async () => {
    setJoining(true);
    setError("");
    try {
      await gameRequest("/rooms/" + encodeURIComponent(roomId) + "/join", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      setRetry((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось войти");
    } finally {
      setJoining(false);
    }
  };
  const moveStick = (event: PointerEvent<HTMLDivElement>) => {
    if (event.type === "pointerdown")
      event.currentTarget.setPointerCapture(event.pointerId);
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left - box.width / 2) / (box.width * 0.35),
      y = (event.clientY - box.top - box.height / 2) / (box.height * 0.35);
    const input = normalizeInput({ x, y, kick: touchRef.current.kick });
    touchRef.current = input;
    setStick({ x: input.x, y: input.y });
  };
  const endStick = () => {
    touchRef.current.x = 0;
    touchRef.current.y = 0;
    setStick({ x: 0, y: 0 });
  };
  const kick = (event: PointerEvent<HTMLButtonElement>, active: boolean) => {
    if (active) {
      event.currentTarget.setPointerCapture(event.pointerId);
      kickSequenceRef.current = Math.max(
        kickSequenceRef.current + 1,
        Date.now(),
      );
    }
    touchRef.current.kick = active;
    setKicking(active);
  };
  const me = room?.members.find((m) => m.id === identity?.id);
  const manage = identity?.is_admin || room?.host_id === identity?.id;
  const readyToStart = !!room && teamsReady(room.members);
  const invitation =
    typeof window === "undefined"
      ? ""
      : roomInvitationUrl(
          sessionConfig?.public_base_url,
          window.location.origin,
          roomId,
        );
  const copyInvitation = async () => {
    if (!invitation) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("manual-copy");
      await navigator.clipboard.writeText(invitation);
      setInviteNotice("Ссылка скопирована. Отправьте её другу.");
    } catch {
      invitationRef.current?.focus();
      invitationRef.current?.select();
      setInviteNotice(
        "Ссылка выделена. Скопируйте её через Ctrl+C или меню телефона.",
      );
    }
  };
  const online = connection === "online";
  const leave = async () => {
    if (leaving) return;
    if (
      room?.host_id === identity?.id &&
      !window.confirm(
        "Вы создатель комнаты. При выходе комната закроется для всех игроков. Выйти?",
      )
    )
      return;
    setLeaving(true);
    try {
      await gameRequest(`/rooms/${encodeURIComponent(roomId)}/leave`, {
        method: "POST",
        body: "{}",
      });
      setRoomActive(false);
      router.push("/qball/play");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось выйти из комнаты. Повторите попытку.",
      );
    } finally {
      setLeaving(false);
    }
  };
  const showOverlay = !online || room?.status !== "playing";
  const connectionLabel =
    connection === "online"
      ? directCount > 0
        ? "WebRTC + резервный канал"
        : "Серверный канал"
      : connection === "reconnecting"
        ? "Восстанавливаем связь…"
        : connection === "closed"
          ? "Соединение завершено"
          : "Подключаемся…";
  const teams: { team: Team; title: string }[] = [
    { team: "red", title: "Красная команда" },
    { team: "spectator", title: "Наблюдатели" },
    { team: "blue", title: "Синяя команда" },
  ];

  return (
    <section className={styles.room}>
      <div className={styles.topline}>
        <Link
          href="/qball/play"
          className={styles.back}
          target={online ? "_blank" : undefined}
          rel={online ? "noopener noreferrer" : undefined}
          title={
            online
              ? "Список откроется в новой вкладке, игра продолжит работать"
              : undefined
          }
        >
          <ArrowLeft size={16} /> Все комнаты
        </Link>
        <span className={styles.transport}>
          <span className={online ? styles.onlineDot : styles.offlineDot} />
          {connectionLabel}
        </span>
      </div>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>QBALL · LIVE ARENA</span>
          <h1>{room?.name || "Футбол начинается здесь"}</h1>
          <p>
            {room
              ? `${room.members.filter((m) => m.connected).length} / ${room.max_players} игроков · ${room.score_limit ? `до ${room.score_limit} голов` : "без лимита голов"} · ${room.time_limit ? `${room.time_limit} мин` : "без лимита времени"}`
              : "Готовим поле и подключаем игроков"}
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            className={styles.iconButton}
            onClick={() => setRoomMenuOpen((value) => !value)}
            aria-label="Меню комнаты"
            aria-expanded={roomMenuOpen}
            aria-controls="qball-room-menu"
            title="Меню комнаты"
          >
            <Menu size={20} />
          </button>
          <button
            className={styles.iconButton}
            onClick={() => setHelp((v) => !v)}
            aria-label="Управление и правила"
            title="Управление и правила"
          >
            <CircleHelp size={19} />
          </button>
          <span className={styles.playerBadge}>
            {identity?.kind === "guest" ? (
              <Users size={16} />
            ) : (
              <ShieldCheck size={16} />
            )}
            {identity?.name || "Игрок"}
          </span>
        </div>
      </header>
      {room && !needsJoin && online && (
        <details className={styles.invitation} aria-label="Пригласить друга">
          <summary>
            <Copy size={14} /> Пригласить друга
          </summary>
          <label htmlFor="qball-invitation">Пригласить друга</label>
          <div>
            <input
              id="qball-invitation"
              ref={invitationRef}
              value={invitation}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
              aria-label="Ссылка на комнату"
            />
            <button onClick={() => void copyInvitation()}>
              <Copy size={15} /> Скопировать
            </button>
          </div>
          <p role="status">
            {inviteNotice ||
              (room.locked
                ? "Отправьте ссылку другу, а пароль комнаты сообщите отдельно."
                : "Друг сможет войти по ссылке как гость, если гостевой вход разрешён.")}
          </p>
          {room.host_id === identity?.id && (
            <p>
              Эта вкладка держит комнату. Не закрывайте её; список комнат и
              страницы сайта открываются отдельно.
            </p>
          )}
        </details>
      )}
      {help && (
        <div className={styles.help}>
          <strong>Как играть</strong>
          <p>
            WASD или стрелки — движение. Пробел или Shift — удар, когда мяч
            рядом. На телефоне используйте джойстик и кнопку удара. Можно
            тренироваться одному. Нулевые лимиты голов и времени означают игру
            до остановки создателем комнаты.
          </p>
          <button
            className={styles.iconButton}
            aria-label="Закрыть подсказку"
            onClick={() => setHelp(false)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
          {connection === "closed" && !needsJoin && (
            <button onClick={() => setRetry((n) => n + 1)}>
              Подключиться снова
            </button>
          )}
        </div>
      )}
      {needsJoin ? (
        <div className={styles.joinCard}>
          <div className={styles.joinIcon}>
            {room?.locked ? <LockKeyhole size={25} /> : <Flag size={25} />}
          </div>
          <h2>Присоединиться к игре</h2>
          <p>
            {room?.locked
              ? "Создатель защитил эту комнату паролем."
              : "Выберите команду после входа и выходите на поле."}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void join();
            }}
          >
            {room?.locked && (
              <label>
                Пароль комнаты
                <div className={styles.passwordField}>
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    maxLength={64}
                    autoComplete="off"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                  >
                    {showPassword ? "Скрыть" : "Показать"}
                  </button>
                </div>
              </label>
            )}
            <button className={styles.primary} disabled={joining}>
              {joining ? (
                <LoaderCircle size={17} className={styles.spin} />
              ) : (
                <Play size={17} />
              )}
              Войти в комнату
            </button>
          </form>
        </div>
      ) : (
        <div className={styles.layout}>
          <main className={styles.main}>
            <div className={styles.arena} ref={arenaRef}>
              <div className={styles.scoreboard}>
                <span className={styles.pink}>
                  Красные <b>{score.red}</b>
                </span>
                <span className={styles.clock}>
                  {timeLabel(elapsedSeconds)}
                  <small>
                    {room ? statusLabels[room.status] : "Подключение"}
                  </small>
                </span>
                <span className={styles.blue}>
                  <b>{score.blue}</b> Синие
                </span>
              </div>
              <div className={styles.pitch}>
                <canvas
                  ref={canvasRef}
                  tabIndex={0}
                  aria-label="Футбольное поле QBall"
                />
                {showOverlay && (
                  <div className={styles.overlay}>
                    <div className={styles.overlayCard}>
                      {!online ? (
                        <>
                          <Radio
                            size={28}
                            className={
                              connection === "closed" ? undefined : styles.pulse
                            }
                          />
                          <h2>
                            {connection === "closed"
                              ? "Матч недоступен"
                              : "Соединяем игроков"}
                          </h2>
                          <p>
                            {connection === "closed"
                              ? "Вернитесь к комнатам и начните новую игру."
                              : "Связь работает через тот же адрес, что и QStudy."}
                          </p>
                        </>
                      ) : (
                        <>
                          <Flag size={28} />
                          <h2>
                            {room?.status === "paused"
                              ? "Небольшой перерыв"
                              : room?.status === "finished"
                                ? score.red === score.blue
                                  ? "Боевая ничья"
                                  : score.red > score.blue
                                    ? "Победа красных"
                                    : "Победа синих"
                                : "Команды, на поле"}
                          </h2>
                          <p>
                            {room?.status === "paused"
                              ? "Создатель комнаты продолжит матч."
                              : room?.status === "finished"
                                ? "Хорошая игра. Готовы сыграть ещё?"
                                : "Выберите команду. Создатель комнаты запустит матч."}
                          </p>
                          {manage && (
                            <button
                              className={styles.primary}
                              disabled={
                                room?.status !== "paused" && !readyToStart
                              }
                              onClick={() => {
                                command(
                                  room?.status === "paused"
                                    ? "resume"
                                    : "start",
                                );
                                setRoomMenuOpen(false);
                              }}
                            >
                              <Play size={16} />
                              {room?.status === "paused"
                                ? "Продолжить"
                                : room?.status === "finished"
                                  ? "Новый матч"
                                  : "Начать матч"}
                            </button>
                          )}
                          {manage &&
                            room?.status !== "paused" &&
                            !readyToStart && (
                              <p>
                                Дождитесь подключения создателя комнаты.
                              </p>
                            )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className={styles.arenaFooter}>
                <span>
                  <Wifi size={14} />
                  {directCount > 0
                    ? `${directCount} прямых соединений`
                    : "Резервный канал готов"}
                </span>
                <button
                  onClick={() => {
                    if (!document.fullscreenElement)
                      void arenaRef.current
                        ?.requestFullscreen?.()
                        .catch(() => {});
                    else void document.exitFullscreen();
                  }}
                >
                  <Expand size={15} />
                  Развернуть
                </button>
              </div>
            </div>
            <div className={styles.controls}>
              <div className={styles.controlCopy}>
                <span className={styles.eyebrow}>ВАШЕ УПРАВЛЕНИЕ</span>
                <p>
                  <kbd>W</kbd>
                  <kbd>A</kbd>
                  <kbd>S</kbd>
                  <kbd>D</kbd>
                  <span>или стрелки</span>
                  <kbd>Space</kbd>
                  <span>удар</span>
                </p>
              </div>
              <div className={styles.teamPick}>
                <span>Вы в игре:</span>
                {teams.map(({ team, title }) => (
                  <button
                    key={team}
                    className={`${styles.teamButton} ${me?.team === team ? styles.teamSelected : ""}`}
                    disabled={
                      !online ||
                      (!manage &&
                        room?.status !== "lobby" &&
                        room?.status !== "finished")
                    }
                    onClick={() => command("team", identity?.id, team)}
                    title={title}
                  >
                    {team === "red"
                      ? "Красные"
                      : team === "blue"
                        ? "Синие"
                        : "Наблюдать"}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.touchControls}>
              <div
                className={styles.joystick}
                role="application"
                aria-label="Джойстик движения"
                tabIndex={0}
                onPointerDown={moveStick}
                onPointerMove={moveStick}
                onPointerUp={endStick}
                onPointerCancel={endStick}
                onLostPointerCapture={endStick}
              >
                <span className={styles.joystickCross}>+</span>
                <span
                  className={styles.stick}
                  style={
                    {
                      "--stick-x": stick.x * 26 + "px",
                      "--stick-y": stick.y * 26 + "px",
                    } as CSSProperties
                  }
                />
              </div>
              <p>
                Двигайтесь и бейте
                <br />
                одновременно
              </p>
              <button
                className={`${styles.kick} ${kicking ? styles.kickActive : ""}`}
                aria-label="Ударить по мячу"
                onPointerDown={(e) => kick(e, true)}
                onPointerUp={(e) => kick(e, false)}
                onPointerCancel={(e) => kick(e, false)}
                onLostPointerCapture={(e) => kick(e, false)}
              >
                <Flag size={24} />
                УДАР
              </button>
            </div>
          </main>
          <aside
            id="qball-room-menu"
            className={`${styles.sidebar} ${roomMenuOpen ? "" : styles.menuClosed}`}
            aria-label="Меню комнаты"
          >
            <section className={styles.people}>
              <h2>
                <Users size={17} />
                Состав комнаты<span>{room?.members.length || 0}</span>
                <button
                  className={styles.iconButton}
                  onClick={() => setRoomMenuOpen(false)}
                  aria-label="Скрыть меню комнаты"
                >
                  <X size={17} />
                </button>
              </h2>
              <div className={styles.playerColumns}>
                {teams.map(({ team, title }) => (
                  <div key={team} className={styles.teamSection}>
                    <h3
                      className={
                        team === "red"
                          ? styles.pink
                          : team === "blue"
                            ? styles.blue
                            : undefined
                      }
                    >
                      {title}
                    </h3>
                    {room?.members
                      .filter((m) => m.team === team)
                      .map((m) => (
                        <div className={styles.member} key={m.id}>
                          <span
                            className={`${styles.avatar} ${team === "red" ? styles.pinkAvatar : team === "blue" ? styles.blueAvatar : ""}`}
                          >
                            {m.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className={styles.memberName}>
                            {m.name}
                            {m.id === identity?.id && <small>вы</small>}
                            <em>
                              {m.is_host || m.id === room.host_id
                                ? "Создатель"
                                : m.connected
                                  ? "На связи"
                                  : "Подключается"}
                            </em>
                          </span>
                          {manage && m.id !== identity?.id ? (
                            <div className={styles.memberActions}>
                              <select
                                aria-label={`Команда игрока ${m.name}`}
                                value={m.team}
                                onChange={(e) =>
                                  command("team", m.id, e.target.value as Team)
                                }
                                disabled={!online}
                              >
                                <option value="red">Красные</option>
                                <option value="blue">Синие</option>
                                <option value="spectator">Зритель</option>
                              </select>
                              <button
                                aria-label={`Исключить ${m.name}`}
                                title="Исключить игрока"
                                onClick={() => command("kick", m.id)}
                                disabled={!online}
                              >
                                <X size={13} />
                              </button>
                            </div>
                          ) : (
                            <span
                              className={
                                m.connected
                                  ? styles.onlineDot
                                  : styles.offlineDot
                              }
                            />
                          )}
                        </div>
                      ))}
                    {!room?.members.some((m) => m.team === team) && (
                      <p className={styles.emptyTeam}>
                        Место для вашей команды
                      </p>
                    )}
                  </div>
                ))}
              </div>
              {manage && (
                <div className={styles.hostControls}>
                  <span>
                    <ShieldCheck size={15} /> Управление матчем
                  </span>
                  <div>
                    {room?.status === "playing" ? (
                      <button
                        disabled={!online}
                        onClick={() => command("pause")}
                      >
                        <Pause size={15} />
                        Пауза
                      </button>
                    ) : (
                      <button
                        disabled={
                          !online ||
                          (room?.status !== "paused" && !readyToStart)
                        }
                        onClick={() => {
                          command(
                            room?.status === "paused" ? "resume" : "start",
                          );
                          setRoomMenuOpen(false);
                        }}
                      >
                        <Play size={15} />
                        {room?.status === "paused" ? "Продолжить" : "Начать"}
                      </button>
                    )}
                    <button
                      disabled={!online || room?.status === "lobby"}
                      onClick={() => command("stop")}
                    >
                      <Square size={14} />
                      Стоп
                    </button>
                    <button
                      disabled={!online || room?.status === "playing"}
                      onClick={() => command("reset")}
                    >
                      <RotateCcw size={14} />
                      Сбросить
                    </button>
                  </div>
                </div>
              )}
              {!readyToStart &&
                room?.status !== "playing" &&
                room?.status !== "paused" && (
                  <p className={styles.emptyTeam}>
                    Для старта дождитесь подключения создателя комнаты.
                  </p>
                )}
            </section>
            {sessionConfig?.chat_enabled !== false && (
              <details className={styles.chat}>
                <summary>
                  Чат комнаты<span>LIVE</span>
                </summary>
                <div className={styles.messages} aria-live="polite">
                  {chat.length === 0 && (
                    <p className={styles.emptyChat}>
                      Поздоровайтесь с соперниками.
                      <br />
                      Хорошая игра начинается с уважения.
                    </p>
                  )}
                  {chat.map((m, index) => (
                    <div className={styles.message} key={`${m.id}-${index}`}>
                      <strong>{m.name}</strong>
                      <p>{m.text}</p>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
                <form
                  className={styles.chatForm}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (
                      text.trim() &&
                      online &&
                      send({ type: "chat", text: text.trim() })
                    ) {
                      setText("");
                    }
                  }}
                >
                  <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Написать игрокам…"
                    aria-label="Сообщение в чат комнаты"
                    maxLength={280}
                    disabled={!online}
                  />
                  <button
                    disabled={!online || !text.trim()}
                    aria-label="Отправить сообщение"
                  >
                    <Send size={17} />
                  </button>
                </form>
              </details>
            )}
          </aside>
        </div>
      )}
      <div className={styles.bottomNote}>
        <span>
          {online && room?.host_id === identity?.id
            ? "Вы держите комнату. Не закрывайте эту вкладку."
            : "Играйте честно. Уважайте соперников."}
        </span>
        {online ? (
          <button
            className={styles.leaveButton}
            onClick={() => void leave()}
            disabled={leaving}
          >
            {leaving ? "Выходим…" : "Выйти из комнаты"}
            <ArrowRight size={14} />
          </button>
        ) : (
          <Link href="/qball/play">
            Найти другую игру
            <ArrowRight size={14} />
          </Link>
        )}
      </div>
    </section>
  );
}
