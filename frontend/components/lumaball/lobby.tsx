"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CircleDot,
  Gamepad2,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Users,
  X,
} from "lucide-react";
import PasswordInput from "@/components/password-input";
import type { LumaList, LumaRoom } from "@/types/lumaball";
import { lumaApi, useLumaBall } from "./context";

const statusLabels: Record<LumaRoom["status"], string> = {
  lobby: "Собираем команду",
  playing: "Матч идёт",
  paused: "Пауза",
  finished: "Матч завершён",
};

export default function LumaLobby() {
  const { config, identity, loading: identityLoading, enter } = useLumaBall();
  const router = useRouter();
  const [rooms, setRooms] = useState<LumaRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [create, setCreate] = useState(false);
  const [lockedRoom, setLockedRoom] = useState<LumaRoom | null>(null);
  const [busy, setBusy] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [createError, setCreateError] = useState("");
  const [roomName, setRoomName] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(0);
  const [scoreLimit, setScoreLimit] = useState(0);
  const [timeLimit, setTimeLimit] = useState(0);
  const [password, setPassword] = useState("");
  const modal = useRef<HTMLElement>(null);

  const refreshRooms = useCallback(async () => {
    try {
      const value = await lumaApi<LumaList<LumaRoom>>("/lumaball/rooms");
      setRooms(value.items);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить комнаты.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refreshRooms();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshRooms();
    }, 7000);
    return () => window.clearInterval(timer);
  }, [refreshRooms]);
  useEffect(() => {
    if (!create && !lockedRoom) return;
    const previous = document.body.style.overflow;
    const focused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(
        modal.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
        ) || [],
      );
    const frame = window.requestAnimationFrame(() => {
      const preferred =
        modal.current?.querySelector<HTMLElement>("input,select");
      (preferred || focusable()[0] || modal.current)?.focus();
    });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        setCreate(false);
        setLockedRoom(null);
      }
      if (event.key === "Tab") {
        const controls = focusable();
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !modal.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !modal.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = previous;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", escape);
      if (focused?.isConnected) focused.focus();
    };
  }, [create, lockedRoom, busy]);

  const filtered = rooms.filter((room) =>
    `${room.name} ${room.host_name}`
      .toLocaleLowerCase("ru-RU")
      .includes(query.toLocaleLowerCase("ru-RU")),
  );
  const online = rooms.reduce((count, room) => count + room.players, 0);
  const available = rooms.find(
    (room) => !room.locked && room.players < room.max_players,
  );
  const mayEnter =
    (config.enabled || identity?.is_admin === true) &&
    (identity?.kind === "user" || config.guests_enabled);
  const mayCreate =
    mayEnter && (identity?.kind === "user" || config.guest_create_rooms);

  async function ensureIdentity() {
    if (identity) return identity;
    return enter();
  }
  async function joinRoom(room: LumaRoom, roomPassword = "") {
    if (busy || !mayEnter) return;
    if (room.locked && lockedRoom?.id !== room.id) {
      setLockedRoom(room);
      setJoinPassword("");
      setCreateError("");
      return;
    }
    setBusy(room.id);
    setCreateError("");
    setError("");
    try {
      await ensureIdentity();
      await lumaApi(`/lumaball/rooms/${room.id}/join`, {
        method: "POST",
        body: JSON.stringify({ password: roomPassword }),
      });
      router.push(`/lumaball/room/${encodeURIComponent(room.id)}`);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Не удалось войти в комнату.";
      if (lockedRoom) setCreateError(message);
      else setError(message);
      setBusy("");
    }
  }
  async function createRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy("create");
    setCreateError("");
    try {
      const player = await ensureIdentity();
      const room = await lumaApi<LumaRoom>("/lumaball/rooms", {
        method: "POST",
        body: JSON.stringify({
          name: roomName.trim() || `Комната ${player.name}`,
          password,
          max_players: maxPlayers || config.default_players,
          score_limit: scoreLimit || config.score_limit,
          time_limit: timeLimit || config.time_limit,
        }),
      });
      router.push(`/lumaball/room/${encodeURIComponent(room.id)}`);
    } catch (cause) {
      setCreateError(
        cause instanceof Error ? cause.message : "Не удалось создать комнату.",
      );
      setBusy("");
    }
  }

  return (
    <main className="lb-container lb-lobby">
      <Link className="lb-back-link" href="/lumaball">
        <ArrowLeft size={14} /> О LumaBall
      </Link>
      <div className="lb-lobby-heading">
        <div>
          <p className="lb-eyebrow">ПОЛЕ УЖЕ ЖДЁТ</p>
          <h1>
            Найдите свою <em>команду.</em>
          </h1>
          <p>Присоединяйтесь к матчу или начните собственную историю.</p>
        </div>
        <button
          className="lb-button lb-button-primary"
          onClick={() => {
            setCreate(true);
            setCreateError("");
          }}
          disabled={!mayCreate || identityLoading || Boolean(busy)}
        >
          <Plus size={18} /> Создать комнату
        </button>
      </div>
      <div className="lb-lobby-layout">
        <section className="lb-rooms-panel" aria-labelledby="lb-rooms-title">
          <div className="lb-room-toolbar">
            <div>
              <h2 id="lb-rooms-title">Игровые комнаты</h2>
              <span>
                {rooms.length} комнат · {online} игроков
              </span>
            </div>
            <button
              className="lb-icon-button"
              type="button"
              onClick={refreshRooms}
              aria-label="Обновить комнаты"
            >
              <RefreshCw size={17} />
            </button>
          </div>
          <label className="lb-search">
            <Search size={17} />
            <input
              placeholder="Найти комнату или друга"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Поиск комнаты"
            />
          </label>
          {error && (
            <div className="lb-error" role="alert">
              {error}
              <button onClick={refreshRooms}>Повторить</button>
            </div>
          )}
          {loading ? (
            <div className="lb-empty" role="status">
              <span className="lb-loading-ball">
                <CircleDot size={30} />
              </span>
              <h3>Ищем ваш следующий матч…</h3>
              <p>Получаем список комнат.</p>
            </div>
          ) : filtered.length ? (
            <div className="lb-room-list">
              {filtered.map((room) => (
                <article className="lb-room-card" key={room.id}>
                  <div
                    className={`lb-room-symbol ${room.status === "playing" ? "lb-room-symbol-active" : ""}`}
                  >
                    <Gamepad2 size={23} />
                  </div>
                  <div className="lb-room-card-copy">
                    <h3>
                      {room.name}
                      {room.locked && (
                        <LockKeyhole size={13} aria-label="Комната с паролем" />
                      )}
                    </h3>
                    <p>
                      {room.host_name} <span>·</span> до {room.score_limit}{" "}
                      голов <span>·</span> {room.time_limit} мин
                    </p>
                    <span
                      className={`lb-room-status lb-room-status-${room.status}`}
                    >
                      <i />
                      {statusLabels[room.status]}
                    </span>
                  </div>
                  <div className="lb-room-card-right">
                    <span>
                      <Users size={14} /> {room.players}
                      <small> / {room.max_players}</small>
                    </span>
                    <button
                      className="lb-button lb-button-small lb-button-soft"
                      disabled={
                        !mayEnter ||
                        Boolean(busy) ||
                        room.players >= room.max_players
                      }
                      onClick={() => void joinRoom(room)}
                    >
                      {busy === room.id
                        ? "Входим…"
                        : room.players >= room.max_players
                          ? "Заполнена"
                          : "Войти"}
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="lb-empty">
              <span>
                <CircleDot size={34} />
              </span>
              <h3>
                {query ? "Комната не нашлась" : "Пусть первый матч будет вашим"}
              </h3>
              <p>
                {query
                  ? "Попробуйте другое название или имя игрока."
                  : "Создайте комнату и пригласите друзей. Всё начинается с первого удара."}
              </p>
              {!query && (
                <button
                  className="lb-button lb-button-soft"
                  disabled={!mayCreate || Boolean(busy)}
                  onClick={() => {
                    setCreate(true);
                    setCreateError("");
                  }}
                >
                  <Plus size={16} /> Создать комнату
                </button>
              )}
            </div>
          )}
        </section>
        <aside className="lb-lobby-aside">
          <div className="lb-player-card">
            <span className="lb-player-avatar">
              {identity ? (
                identity.name.slice(0, 1).toUpperCase()
              ) : (
                <Users size={26} />
              )}
            </span>
            <p className="lb-eyebrow">ВАШЕ МЕСТО НА ПОЛЕ</p>
            <h2>{identity?.name || "Игра начинается с вас"}</h2>
            <p>
              {identity?.kind === "user"
                ? "Аккаунт QStudy уже с вами. Можно сразу играть."
                : identity
                  ? "Ваш гостевой номер сохранён в этом браузере."
                  : config.guests_enabled
                    ? "Войдите в комнату — мы выдадим вам гостевой номер. Регистрация не обязательна."
                    : "Для входа на поле нужен аккаунт QStudy."}
            </p>
            {!identity && (
              <Link
                className="lb-button lb-button-outline"
                href="/login?next=%2Flumaball%2Fplay"
              >
                Войти через QStudy <ArrowUpRight size={16} />
              </Link>
            )}
            {identity?.is_admin && (
              <Link href="/dashboard/admin/lumaball" className="lb-text-button">
                Управление игрой <ArrowUpRight size={15} />
              </Link>
            )}
          </div>
          <div className="lb-quick-card">
            <ZapIcon />
            <h3>Не терпится сыграть?</h3>
            <p>
              Зайдите в свободную открытую комнату — команда уже собирается.
            </p>
            <button
              className="lb-button lb-button-primary"
              disabled={!available || !mayEnter || Boolean(busy)}
              onClick={() => {
                if (available) void joinRoom(available);
              }}
            >
              Быстрый вход <ArrowRight size={16} />
            </button>
          </div>
          {!config.enabled && (
            <div className="lb-inline-notice">
              LumaBall временно закрыт администратором.
            </div>
          )}
          {config.enabled && !config.guests_enabled && !identity && (
            <div className="lb-inline-notice">
              Гостевой вход отключён. Войдите с аккаунтом QStudy.
            </div>
          )}
          <p className="lb-lobby-hint">
            WASD или стрелки — движение.
            <br />
            Пробел — удар. На телефоне есть экранные кнопки.
          </p>
        </aside>
      </div>
      {(create || lockedRoom) && (
        <div
          className="lb-modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget && !busy) {
              setCreate(false);
              setLockedRoom(null);
            }
          }}
        >
          <section
            ref={modal}
            className="lb-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lb-modal-title"
          >
            <button
              className="lb-modal-close"
              aria-label="Закрыть"
              disabled={Boolean(busy)}
              onClick={() => {
                setCreate(false);
                setLockedRoom(null);
              }}
            >
              <X size={20} />
            </button>
            <p className="lb-eyebrow">ВАША ИГРА, ВАШ РИТМ</p>
            <h2 id="lb-modal-title">
              {create ? "Создать комнату" : lockedRoom?.name}
            </h2>
            <p className="lb-modal-description">
              {create
                ? "Настройте матч. После входа пригласите друзей ссылкой."
                : "Для входа в эту комнату нужен пароль от её создателя."}
            </p>
            {create ? (
              <form onSubmit={createRoom} className="lb-form">
                <label>
                  <span>Название комнаты</span>
                  <input
                    className="lb-input"
                    autoFocus
                    value={roomName}
                    maxLength={60}
                    placeholder={
                      identity ? `Комната ${identity.name}` : "Вечерний матч"
                    }
                    onChange={(event) => setRoomName(event.target.value)}
                  />
                </label>
                <div className="lb-form-row">
                  <label>
                    <span>Максимум игроков</span>
                    <select
                      className="lb-input"
                      value={maxPlayers || config.default_players}
                      onChange={(event) =>
                        setMaxPlayers(Number(event.target.value))
                      }
                    >
                      {Array.from(
                        { length: config.max_players - 1 },
                        (_, i) => i + 2,
                      ).map((value) => (
                        <option key={value} value={value}>
                          {value} игроков
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>До скольких голов</span>
                    <input
                      className="lb-input"
                      type="number"
                      min={1}
                      max={20}
                      value={scoreLimit || config.score_limit}
                      onChange={(event) =>
                        setScoreLimit(Number(event.target.value))
                      }
                      required
                    />
                  </label>
                </div>
                <label>
                  <span>Время матча, минут</span>
                  <input
                    className="lb-input"
                    type="number"
                    min={1}
                    max={30}
                    value={timeLimit || config.time_limit}
                    onChange={(event) =>
                      setTimeLimit(Number(event.target.value))
                    }
                    required
                  />
                </label>
                <label>
                  <span>
                    Пароль комнаты <small>необязательно</small>
                  </span>
                  <PasswordInput
                    className="lb-input"
                    value={password}
                    maxLength={64}
                    autoComplete="new-password"
                    placeholder="Оставьте пустым для открытой игры"
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <p className="lb-form-note">
                  Комната работает, пока её создатель находится в игре.
                </p>
                {createError && (
                  <div role="alert" className="lb-error">
                    {createError}
                  </div>
                )}
                <button
                  className="lb-button lb-button-primary"
                  type="submit"
                  disabled={Boolean(busy)}
                >
                  {busy ? "Создаём…" : "Создать и выйти на поле"}
                  <ArrowUpRight size={17} />
                </button>
              </form>
            ) : (
              <form
                className="lb-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (lockedRoom) void joinRoom(lockedRoom, joinPassword);
                }}
              >
                <label>
                  <span>Пароль комнаты</span>
                  <PasswordInput
                    className="lb-input"
                    autoFocus
                    value={joinPassword}
                    maxLength={64}
                    autoComplete="off"
                    onChange={(event) => setJoinPassword(event.target.value)}
                    required
                  />
                </label>
                {createError && (
                  <div role="alert" className="lb-error">
                    {createError}
                  </div>
                )}
                <button
                  type="submit"
                  className="lb-button lb-button-primary"
                  disabled={Boolean(busy)}
                >
                  {busy ? "Подключаем…" : "Войти в комнату"}
                  <ArrowUpRight size={17} />
                </button>
              </form>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function ZapIcon() {
  return (
    <span className="lb-quick-symbol" aria-hidden="true">
      ✦
    </span>
  );
}
