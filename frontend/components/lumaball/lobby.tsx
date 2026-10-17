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
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Users,
  X,
} from "lucide-react";
import PasswordInput from "@/components/password-input";
import type { LumaList, LumaRoom } from "@/types/lumaball";
import { normalizeMapSettings } from "@/lib/lumaball/maps";
import { lumaApi, useQBall } from "./context";
import { MapSettings, mapSummary } from "./map-settings";
import "./original-lobby.css";

const statusLabels: Record<LumaRoom["status"], string> = {
  lobby: "Собираем команду",
  playing: "Матч идёт",
  paused: "Пауза",
  finished: "Матч завершён",
};

export default function LumaLobby() {
  const { config, identity, loading: identityLoading, enter } = useQBall();
  const router = useRouter();
  const [rooms, setRooms] = useState<LumaRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [lockedRoom, setLockedRoom] = useState<LumaRoom | null>(null);
  const [busy, setBusy] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [createError, setCreateError] = useState("");
  const [roomName, setRoomName] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(0);
  const [scoreLimit, setScoreLimit] = useState<number | null>(null);
  const [timeLimit, setTimeLimit] = useState<number | null>(null);
  const [password, setPassword] = useState("");
  const [map, setMap] = useState(() => normalizeMapSettings());
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
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId);
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
      router.push(`/qball/room/${encodeURIComponent(room.id)}`);
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
          score_limit: scoreLimit ?? config.score_limit,
          time_limit: timeLimit ?? config.time_limit,
          ...map,
        }),
      });
      router.push(`/qball/room/${encodeURIComponent(room.id)}`);
    } catch (cause) {
      setCreateError(
        cause instanceof Error ? cause.message : "Не удалось создать комнату.",
      );
      setBusy("");
    }
  }

  return (
    <main className="lb-container lb-lobby lb-lobby-original">
      <div className="lb-original-heading">
        <Link className="lb-back-link" href="/qball">
          <ArrowLeft size={15} /> QBall
        </Link>
        <h1>Список комнат</h1>
        <span>Онлайн-футбол с друзьями</span>
      </div>
      <div className="lb-original-browser">
        <section
          className="lb-original-room-panel"
          aria-label="Игровые комнаты"
        >
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
          <div className="lb-original-table-scroll">
            <table className="lb-original-room-table">
              <thead>
                <tr>
                  <th scope="col">Индекс</th>
                  <th scope="col">Название комнаты</th>
                  <th scope="col">Пароль</th>
                  <th scope="col">Игроки</th>
                </tr>
              </thead>
              <tbody>
                {!loading &&
                  filtered.map((room, index) => (
                    <tr
                      key={room.id}
                      tabIndex={0}
                      aria-selected={selectedRoomId === room.id}
                      className={
                        selectedRoomId === room.id ? "lb-original-selected" : ""
                      }
                      onClick={() =>
                        setSelectedRoomId((current) =>
                          current === room.id ? null : room.id,
                        )
                      }
                      onDoubleClick={() => {
                        if (room.players < room.max_players)
                          void joinRoom(room);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedRoomId(room.id);
                        }
                      }}
                    >
                      <td>{index + 1}</td>
                      <td>
                        <strong>{room.name}</strong>
                        <small>
                          {room.host_name} · {statusLabels[room.status]} ·{" "}
                          {mapSummary(room)} ·{" "}
                          {room.score_limit
                            ? `${room.score_limit} голов`
                            : "Без лимита голов"}{" "}
                          /{" "}
                          {room.time_limit
                            ? `${room.time_limit} мин`
                            : "без лимита времени"}
                        </small>
                      </td>
                      <td>
                        {room.locked ? (
                          <>
                            <LockKeyhole size={13} /> Да
                          </>
                        ) : (
                          "Нет"
                        )}
                      </td>
                      <td>
                        <Users size={13} /> {room.players} / {room.max_players}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {loading ? (
              <div className="lb-empty" role="status">
                <CircleDot size={32} />
                <h3>Загружаем комнаты…</h3>
              </div>
            ) : filtered.length === 0 ? (
              <div className="lb-empty">
                <CircleDot size={42} />
                <h3>{query ? "Комната не найдена" : "Список комнат пуст"}</h3>
                <p>
                  {query
                    ? "Попробуйте другое название."
                    : "Создайте комнату и пригласите друзей."}
                </p>
              </div>
            ) : null}
          </div>
          <p className="lb-original-list-hint">
            Выберите комнату в списке и нажмите «Войти». Двойной щелчок сразу
            открывает вход.
          </p>
        </section>
        <aside className="lb-original-room-controls">
          <button
            className="lb-original-control lb-original-control-enter"
            disabled={
              !selectedRoom ||
              !mayEnter ||
              Boolean(busy) ||
              (selectedRoom?.players ?? 0) >= (selectedRoom?.max_players ?? 0)
            }
            onClick={() => {
              if (selectedRoom) void joinRoom(selectedRoom);
            }}
          >
            <ArrowUpRight size={19} />
            {busy && busy !== "create" ? "Входим…" : "Войти в комнату"}
          </button>
          <button
            className="lb-original-control lb-original-control-create"
            disabled={!mayCreate || identityLoading || Boolean(busy)}
            onClick={() => {
              setCreate(true);
              setCreateError("");
            }}
          >
            <Plus size={19} />
            Создать комнату
          </button>
          <button
            className="lb-original-control lb-original-control-refresh"
            onClick={refreshRooms}
          >
            <RefreshCw size={18} />
            Обновить список
          </button>
          <div className="lb-original-room-stats">
            <p>
              Количество комнат: <strong>{rooms.length}</strong>
            </p>
            <p>
              Количество игроков: <strong>{online}</strong>
            </p>
          </div>
          {selectedRoom && (
            <div className="lb-original-selection">
              <span>Выбрана комната</span>
              <strong>{selectedRoom.name}</strong>
              <small>
                {selectedRoom.players >= selectedRoom.max_players
                  ? "Комната заполнена"
                  : statusLabels[selectedRoom.status]}
              </small>
            </div>
          )}
          <div className="lb-original-account">
            <span className="lb-original-account-icon">
              {identity?.name.slice(0, 1).toUpperCase() || <Users size={25} />}
            </span>
            <strong>{identity?.name || "Гостевой вход"}</strong>
            <p>
              {identity?.kind === "user"
                ? "Аккаунт QStudy подключён."
                : identity
                  ? "Ваш случайный номер сохранён в этом браузере."
                  : "При входе в комнату вы получите имя guest# со случайным номером."}
            </p>
            {!identity && (
              <Link href="/login?next=%2Fqball%2Fplay">
                Войти через QStudy <ArrowUpRight size={14} />
              </Link>
            )}
            {identity?.is_admin && (
              <Link href="/qcontrol/qball">
                Управление игрой <ArrowUpRight size={14} />
              </Link>
            )}
          </div>
          <button
            className="lb-original-quick"
            disabled={!available || !mayEnter || Boolean(busy)}
            onClick={() => {
              if (available) void joinRoom(available);
            }}
          >
            Быстрый вход <ArrowRight size={14} />
          </button>
          {!config.enabled && (
            <p className="lb-inline-notice">
              QBall временно закрыт администратором.
            </p>
          )}
          {config.enabled && !config.guests_enabled && !identity && (
            <p className="lb-inline-notice">
              Гостевой вход отключён. Войдите через QStudy.
            </p>
          )}
          <p className="lb-lobby-hint">
            WASD / стрелки — движение.
            <br />
            Пробел / Shift — удар.
            <br />
            На телефоне — джойстик и кнопка.
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
                      min={0}
                      max={20}
                      value={scoreLimit ?? config.score_limit}
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
                    min={0}
                    max={30}
                    value={timeLimit ?? config.time_limit}
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
                <MapSettings
                  value={map}
                  onChange={setMap}
                  disabled={Boolean(busy)}
                />
                <p className="lb-form-note">
                  0 голов и 0 минут — без лимитов, как в оригинале. Комната
                  работает, пока её создатель находится в игре.
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
