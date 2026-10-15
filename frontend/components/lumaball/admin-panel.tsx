"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  CircleDot,
  Clock3,
  Gamepad2,
  Pause,
  Play,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Square,
  Trophy,
  Users,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  DeleteButton,
  ErrorNotice,
  RecordEditor,
  type FieldDefinition,
} from "@/components/academic";
import { LogoUpload } from "@/components/logo-upload";
import type {
  LumaConfig,
  LumaList,
  LumaMatch,
  LumaPlayer,
  LumaRoom,
} from "@/types/lumaball";
import styles from "./admin.module.css";

type AdminSettings = LumaConfig & { ice_servers: RTCIceServer[] };
type Stats = {
  rooms_active: number;
  players_online: number;
  matches_total: number;
  guests_total: number;
  members_total: number;
};
type Team = "red" | "blue" | "spectator";
type Member = { id: string; name: string; team: Team; is_host?: boolean };
type RoomFull = LumaRoom & { members: Member[] };
type Tab = "settings" | "rooms" | "players" | "matches";
const date = (value?: string) =>
  value
    ? new Date(value).toLocaleString("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
const fail = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Не удалось выполнить действие.";

export default function LumaAdminPanel() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("settings");
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [rooms, setRooms] = useState<RoomFull[]>([]);
  const [players, setPlayers] = useState<LumaList<LumaPlayer>>({
    items: [],
    total: 0,
  });
  const [matches, setMatches] = useState<LumaList<LumaMatch>>({
    items: [],
    total: 0,
  });
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [matchOffset, setMatchOffset] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [expandedRoom, setExpandedRoom] = useState<RoomFull | null>(null);

  const refresh = useCallback(async () => {
    if (user.role !== "admin") return;
    try {
      const [nextSettings, nextStats, nextRooms] = await Promise.all([
        api<AdminSettings>("/admin/lumaball/settings"),
        api<Stats>("/admin/lumaball/stats"),
        api<LumaList<RoomFull>>("/admin/lumaball/rooms?limit=100"),
      ]);
      setSettings(nextSettings);
      setStats(nextStats);
      setRooms(nextRooms.items);
      setError("");
    } catch (cause) {
      setError(fail(cause));
    } finally {
      setLoading(false);
    }
  }, [user.role]);
  const refreshPlayers = useCallback(async () => {
    try {
      setPlayers(
        await api<LumaList<LumaPlayer>>(
          `/admin/lumaball/players?q=${encodeURIComponent(query)}&offset=${offset}&limit=20`,
        ),
      );
    } catch (cause) {
      setError(fail(cause));
    }
  }, [query, offset]);
  const refreshMatches = useCallback(async () => {
    try {
      setMatches(
        await api<LumaList<LumaMatch>>(
          `/admin/lumaball/matches?offset=${matchOffset}&limit=20`,
        ),
      );
    } catch (cause) {
      setError(fail(cause));
    }
  }, [matchOffset]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (tab === "players") void refreshPlayers();
  }, [tab, refreshPlayers]);
  useEffect(() => {
    if (tab === "matches") void refreshMatches();
  }, [tab, refreshMatches]);
  useEffect(() => {
    if (tab !== "rooms") return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 7000);
    return () => window.clearInterval(timer);
  }, [tab, refresh]);

  async function command(
    roomId: string,
    action: string,
    target?: string,
    team?: Team,
  ) {
    setBusy(`${roomId}-${action}`);
    setError("");
    setNotice("");
    try {
      await api(`/admin/lumaball/rooms/${roomId}/command`, {
        method: "POST",
        body: JSON.stringify({
          action,
          ...(target ? { target } : {}),
          ...(team !== undefined ? { team } : {}),
        }),
      });
      setNotice("Команда выполнена.");
      await refresh();
      if (expandedRoom?.id === roomId) {
        const updated = await api<LumaList<RoomFull>>(
          "/admin/lumaball/rooms?limit=100",
        );
        setExpandedRoom(
          updated.items.find((room) => room.id === roomId) || null,
        );
      }
    } catch (cause) {
      setError(fail(cause));
    } finally {
      setBusy("");
    }
  }
  async function inspect(roomId: string) {
    if (expandedRoom?.id === roomId) {
      setExpandedRoom(null);
      return;
    }
    setBusy(`${roomId}-inspect`);
    try {
      const updated = await api<LumaList<RoomFull>>(
        "/admin/lumaball/rooms?limit=100",
      );
      setExpandedRoom(updated.items.find((room) => room.id === roomId) || null);
    } catch (cause) {
      setError(fail(cause));
    } finally {
      setBusy("");
    }
  }
  async function updateRoom(roomId: string, payload: Record<string, unknown>) {
    setBusy(`${roomId}-update`);
    setError("");
    try {
      await api(`/admin/lumaball/rooms/${roomId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setNotice("Настройки комнаты обновлены.");
      await refresh();
    } catch (cause) {
      setError(fail(cause));
    } finally {
      setBusy("");
    }
  }
  async function clearChat(roomId: string) {
    setBusy(`${roomId}-chat`);
    setError("");
    try {
      await api(`/admin/lumaball/rooms/${roomId}/chat`, { method: "DELETE" });
      setNotice("Чат комнаты очищен.");
    } catch (cause) {
      setError(fail(cause));
    } finally {
      setBusy("");
    }
  }
  const playerFields: FieldDefinition[] = [
    { name: "name", label: "Игровое имя", required: true },
    {
      name: "banned",
      label: "Заблокировать доступ к LumaBall",
      type: "checkbox",
    },
    { name: "ban_reason", label: "Причина блокировки", type: "textarea" },
  ];
  if (user.role !== "admin")
    return (
      <p className="muted">
        Управление LumaBall доступно администратору QStudy.
      </p>
    );

  return (
    <div className={styles.admin}>
      <header className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>QSTUDY × LUMABALL</p>
          <h1>Центр игрового притяжения</h1>
          <p>Оформление, комнаты, игроки и история матчей в одном месте.</p>
        </div>
        <Link className={styles.primary} href="/lumaball">
          Открыть LumaBall <ArrowUpRight size={17} />
        </Link>
      </header>
      <div className={styles.stats}>
        {[
          {
            label: "Комнаты сейчас",
            value: stats?.rooms_active,
            Icon: Gamepad2,
          },
          { label: "Игроки в сети", value: stats?.players_online, Icon: Users },
          {
            label: "Сыграно матчей",
            value: stats?.matches_total,
            Icon: Trophy,
          },
          {
            label: "Игровые профили",
            value: stats ? stats.guests_total + stats.members_total : undefined,
            Icon: ShieldCheck,
          },
        ].map(({ label, value, Icon }) => (
          <div key={label}>
            <span>
              {label}
              <Icon size={17} />
            </span>
            <strong>{value ?? "—"}</strong>
          </div>
        ))}
      </div>
      <nav className={styles.tabs} aria-label="Управление LumaBall">
        {(
          [
            { id: "settings", label: "Площадка", Icon: CircleDot },
            { id: "rooms", label: "Комнаты", Icon: Gamepad2 },
            { id: "players", label: "Игроки", Icon: Users },
            { id: "matches", label: "История матчей", Icon: Clock3 },
          ] as const
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            className={tab === id ? styles.activeTab : ""}
            onClick={() => {
              setTab(id);
              setNotice("");
              setError("");
            }}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
        <button
          className={styles.refresh}
          onClick={() => {
            void refresh();
            if (tab === "players") void refreshPlayers();
            if (tab === "matches") void refreshMatches();
          }}
          aria-label="Обновить данные"
        >
          <RefreshCw size={16} />
        </button>
      </nav>
      <ErrorNotice message={error} />
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <div className={styles.empty} role="status">
          Загружаем игровую площадку…
        </div>
      ) : tab === "settings" ? (
        settings && (
          <SettingsForm
            initial={settings}
            onSaved={(value) => {
              setSettings(value);
              setNotice("Настройки LumaBall сохранены.");
              window.dispatchEvent(new Event("lumaball:updated"));
            }}
          />
        )
      ) : tab === "rooms" ? (
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <h2>Комнаты в реальном времени</h2>
            <span>Изменения сразу видны игрокам</span>
          </div>
          {rooms.length === 0 ? (
            <div className={styles.empty}>
              <Gamepad2 size={28} />
              <h3>Пока никто не вышел на поле</h3>
              <p>Новые комнаты появятся здесь автоматически.</p>
            </div>
          ) : (
            <div className={styles.roomList}>
              {rooms.map((room) => (
                <article key={room.id} className={styles.room}>
                  <div className={styles.roomMain}>
                    <div>
                      <h3>{room.name}</h3>
                      <p>
                        {room.host_name} · {room.players}/{room.max_players}{" "}
                        игроков · {room.time_limit} мин · до {room.score_limit}{" "}
                        голов
                      </p>
                      <span className={styles.status}>
                        {
                          {
                            lobby: "Ожидание игроков",
                            playing: "Матч идёт",
                            paused: "Пауза",
                            finished: "Завершён",
                          }[room.status]
                        }
                      </span>
                    </div>
                    <div className={styles.roomActions}>
                      <RecordEditor
                        compact
                        title="Настройки комнаты"
                        endpoint={`/admin/lumaball/rooms/${room.id}`}
                        method="PATCH"
                        initial={room}
                        fields={[
                          { name: "name", label: "Название", required: true },
                          ...(room.status === "playing" ||
                          room.status === "paused"
                            ? []
                            : [
                                {
                                  name: "max_players",
                                  label: "Максимум игроков",
                                  type: "number" as const,
                                  min: Math.max(2, room.players),
                                  max: settings?.max_players || 16,
                                },
                                {
                                  name: "score_limit",
                                  label: "До скольких голов",
                                  type: "number" as const,
                                  min: 1,
                                  max: 20,
                                },
                                {
                                  name: "time_limit",
                                  label: "Минут в матче",
                                  type: "number" as const,
                                  min: 1,
                                  max: 30,
                                },
                                {
                                  name: "password",
                                  label: "Новый пароль комнаты",
                                  type: "password" as const,
                                  omitWhenEmpty: true,
                                  hint: "Оставьте пустым, чтобы сохранить текущий пароль.",
                                },
                              ]),
                        ]}
                        onSaved={refresh}
                      />
                      <DeleteButton
                        title={`Закрыть комнату «${room.name}»?`}
                        description="Все участники выйдут в список комнат. Сохранённые результаты останутся в истории."
                        endpoint={`/admin/lumaball/rooms/${room.id}`}
                        onDeleted={() => {
                          setExpandedRoom(null);
                          void refresh();
                        }}
                      />
                    </div>
                  </div>
                  <div className={styles.commandBar}>
                    {room.status === "playing" ? (
                      <button
                        disabled={Boolean(busy)}
                        onClick={() => void command(room.id, "pause")}
                      >
                        <Pause size={13} /> Пауза
                      </button>
                    ) : (
                      <button
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void command(
                            room.id,
                            room.status === "paused" ? "resume" : "start",
                          )
                        }
                      >
                        <Play size={13} />
                        {room.status === "paused" ? "Продолжить" : "Начать"}
                      </button>
                    )}
                    <button
                      disabled={Boolean(busy) || room.status === "lobby"}
                      onClick={() => void command(room.id, "stop")}
                    >
                      <Square size={12} /> Завершить
                    </button>
                    <button
                      disabled={Boolean(busy)}
                      onClick={() => void command(room.id, "reset")}
                    >
                      <RefreshCw size={12} /> Сбросить счёт
                    </button>
                    <button
                      disabled={Boolean(busy)}
                      onClick={() => void inspect(room.id)}
                    >
                      <Users size={13} /> Участники
                    </button>
                    <button
                      disabled={Boolean(busy)}
                      onClick={() => void clearChat(room.id)}
                    >
                      Очистить чат
                    </button>
                    {room.locked &&
                      room.status !== "playing" &&
                      room.status !== "paused" && (
                        <button
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void updateRoom(room.id, { password: "" })
                          }
                        >
                          Убрать пароль
                        </button>
                      )}
                    <Link href={`/lumaball/room/${room.id}`}>
                      Открыть <ArrowUpRight size={13} />
                    </Link>
                  </div>
                  {expandedRoom?.id === room.id && (
                    <div className={styles.members}>
                      {expandedRoom.members.map((member) => (
                        <div key={member.id}>
                          <span>
                            {member.name}
                            {member.is_host && <small>Создатель</small>}
                          </span>
                          <select
                            className={styles.select}
                            value={member.team}
                            aria-label={`Команда ${member.name}`}
                            disabled={Boolean(busy)}
                            onChange={(event) =>
                              void command(
                                room.id,
                                "team",
                                member.id,
                                event.target.value as Team,
                              )
                            }
                          >
                            <option value="spectator">Зрители</option>
                            <option value="red">Красные</option>
                            <option value="blue">Синие</option>
                          </select>
                          <button
                            disabled={Boolean(busy) || member.is_host}
                            onClick={() =>
                              void command(room.id, "kick", member.id)
                            }
                            aria-label={`Исключить ${member.name}`}
                          >
                            <X size={15} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      ) : tab === "players" ? (
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>Игровые профили</h2>
              <p>
                Ограничения действуют в LumaBall. Учебные аккаунты управляются в
                основном центре.
              </p>
            </div>
            <Link href="/dashboard/admin">
              Аккаунты QStudy <ArrowUpRight size={13} />
            </Link>
          </div>
          <label className={styles.search}>
            <Search size={16} />
            <input
              placeholder="Найти игрока"
              aria-label="Найти игрока"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
            />
          </label>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Игрок</th>
                  <th>Доступ</th>
                  <th>Последний вход</th>
                  <th>Управление</th>
                </tr>
              </thead>
              <tbody>
                {players.items.map((player) => (
                  <tr key={player.id}>
                    <td>
                      <strong>{player.name}</strong>
                      <small>
                        {player.kind === "guest"
                          ? "Гостевой профиль"
                          : player.is_admin
                            ? "Администратор QStudy"
                            : "Аккаунт QStudy"}
                      </small>
                    </td>
                    <td>
                      <span
                        className={
                          player.banned ? styles.banned : styles.allowed
                        }
                      >
                        {player.banned ? "Заблокирован" : "Разрешён"}
                      </span>
                      {player.ban_reason && <small>{player.ban_reason}</small>}
                    </td>
                    <td>{date(player.last_seen_at)}</td>
                    <td>
                      <div className={styles.rowActions}>
                        <RecordEditor
                          compact
                          title={`Игровой профиль ${player.name}`}
                          endpoint={`/admin/lumaball/players/${player.id}`}
                          method="PATCH"
                          initial={player}
                          fields={playerFields.filter((field) =>
                            player.kind === "guest"
                              ? field.name !== "name"
                              : player.is_admin
                                ? field.name === "name"
                                : true,
                          )}
                          onSaved={refreshPlayers}
                        />
                        {player.user_id !== user.id && !player.is_admin && (
                          <DeleteButton
                            title={`Удалить игровой профиль ${player.name}?`}
                            description="Удалятся только игровой профиль и гостевые ключи LumaBall. Аккаунт QStudy, пароль и учебные данные сохранятся."
                            endpoint={`/admin/lumaball/players/${player.id}`}
                            onDeleted={() => {
                              void refreshPlayers();
                              void refresh();
                            }}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {players.items.length === 0 && (
            <div className={styles.empty}>Игроки не найдены.</div>
          )}
          <Pagination
            offset={offset}
            total={players.total}
            onChange={setOffset}
          />
        </section>
      ) : (
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <h2>Завершённые матчи</h2>
            <span>Всего {matches.total}</span>
          </div>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Комната</th>
                  <th>Счёт</th>
                  <th>Завершён</th>
                  <th>Управление</th>
                </tr>
              </thead>
              <tbody>
                {matches.items.map((match) => (
                  <tr key={match.id}>
                    <td>
                      <strong>{match.room_name}</strong>
                    </td>
                    <td>
                      <span className={styles.matchScore}>
                        {match.red_score} <i>:</i> {match.blue_score}
                      </span>
                    </td>
                    <td>{date(match.finished_at)}</td>
                    <td>
                      <DeleteButton
                        title="Удалить запись матча?"
                        description="Запись будет удалена из истории. Игровые профили и аккаунты сохранятся."
                        endpoint={`/admin/lumaball/matches/${match.id}`}
                        onDeleted={() => {
                          void refreshMatches();
                          void refresh();
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {matches.items.length === 0 && (
            <div className={styles.empty}>
              <Trophy size={28} />
              <h3>История ещё впереди</h3>
              <p>Результаты завершённых матчей появятся здесь.</p>
            </div>
          )}
          <Pagination
            offset={matchOffset}
            total={matches.total}
            onChange={setMatchOffset}
          />
        </section>
      )}
    </div>
  );
}

function Pagination({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (value: number) => void;
}) {
  if (total <= 20) return null;
  return (
    <div className={styles.pagination}>
      <span>
        {offset + 1}–{Math.min(offset + 20, total)} из {total}
      </span>
      <button
        disabled={offset === 0}
        onClick={() => onChange(Math.max(offset - 20, 0))}
      >
        Назад
      </button>
      <button
        disabled={offset + 20 >= total}
        onClick={() => onChange(offset + 20)}
      >
        Далее
      </button>
    </div>
  );
}

function SettingsForm({
  initial,
  onSaved,
}: {
  initial: AdminSettings;
  onSaved: (settings: AdminSettings) => void;
}) {
  const [form, setForm] = useState(initial);
  const [ice, setIce] = useState(
    JSON.stringify(initial.ice_servers || [], null, 2),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function update<K extends keyof AdminSettings>(
    key: K,
    value: AdminSettings[K],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let servers: RTCIceServer[];
      try {
        servers = JSON.parse(ice) as RTCIceServer[];
      } catch {
        throw new Error("Проверьте JSON в настройках серверов соединения.");
      }
      if (!Array.isArray(servers))
        throw new Error("Серверы соединения должны быть массивом JSON.");
      if (form.default_players > form.max_players)
        throw new Error(
          "Число игроков по умолчанию не должно превышать максимум для площадки.",
        );
      const { logo_url: _logo, ...payload } = form;
      const result = await api<AdminSettings>("/admin/lumaball/settings", {
        method: "PATCH",
        body: JSON.stringify({ ...payload, ice_servers: servers }),
      });
      setForm(result);
      setIce(JSON.stringify(result.ice_servers || [], null, 2));
      onSaved(result);
    } catch (cause) {
      setError(fail(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.settingsLayout}>
      <form onSubmit={save} className={styles.settingsForm}>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>Лицо LumaBall</h2>
              <p>Тексты главной страницы и правила сообщества.</p>
            </div>
          </div>
          <div className={styles.fields}>
            <label>
              <span>Название проекта</span>
              <input
                value={form.title}
                maxLength={60}
                required
                onChange={(event) => update("title", event.target.value)}
              />
            </label>
            <label>
              <span>О проекте</span>
              <textarea
                value={form.description}
                rows={3}
                maxLength={500}
                onChange={(event) => update("description", event.target.value)}
              />
            </label>
            <label>
              <span>Объявление для игроков</span>
              <input
                value={form.announcement}
                maxLength={300}
                placeholder="Пусто — объявление не показывается"
                onChange={(event) => update("announcement", event.target.value)}
              />
            </label>
            <label>
              <span>Правила игры</span>
              <textarea
                value={form.rules}
                rows={5}
                maxLength={5000}
                onChange={(event) => update("rules", event.target.value)}
              />
            </label>
          </div>
        </section>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>Доступ и общение</h2>
              <p>Управляйте площадкой без изменения аккаунтов QStudy.</p>
            </div>
          </div>
          <div className={styles.switches}>
            {(
              [
                {
                  key: "enabled",
                  label: "Площадка открыта",
                  hint: "Игроки могут создавать комнаты и заходить на поле.",
                },
                {
                  key: "guests_enabled",
                  label: "Разрешить гостей",
                  hint: "Игра без регистрации с именем guest# и личным номером.",
                },
                {
                  key: "guest_create_rooms",
                  label: "Гости могут создавать комнаты",
                  hint: "При отключении гости играют в комнатах зарегистрированных пользователей.",
                },
                {
                  key: "chat_enabled",
                  label: "Чат в комнатах",
                  hint: "Сообщения между участниками матча.",
                },
              ] as const
            ).map((item) => (
              <label key={item.key}>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </span>
                <input
                  type="checkbox"
                  checked={form[item.key]}
                  onChange={(event) => update(item.key, event.target.checked)}
                />
              </label>
            ))}
          </div>
        </section>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>Параметры матчей</h2>
              <p>
                Новые комнаты получают эти значения. Текущие комнаты управляются
                отдельно.
              </p>
            </div>
          </div>
          <div className={styles.numberGrid}>
            {(
              [
                {
                  key: "max_rooms",
                  label: "Комнат на площадке",
                  min: 1,
                  max: 100,
                },
                {
                  key: "max_players",
                  label: "Максимум игроков в комнате",
                  min: 2,
                  max: 16,
                },
                {
                  key: "default_players",
                  label: "Игроков по умолчанию",
                  min: 2,
                  max: form.max_players,
                },
                {
                  key: "score_limit",
                  label: "Голов для победы",
                  min: 1,
                  max: 20,
                },
                {
                  key: "time_limit",
                  label: "Время матча, минут",
                  min: 1,
                  max: 30,
                },
              ] as const
            ).map((field) => (
              <label key={field.key}>
                <span>{field.label}</span>
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  required
                  value={form[field.key]}
                  onChange={(event) =>
                    update(field.key, Number(event.target.value))
                  }
                />
              </label>
            ))}
          </div>
        </section>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>Соединение WebRTC</h2>
              <p>
                Серверы STUN/TURN помогают игрокам соединяться из разных сетей.
              </p>
            </div>
          </div>
          <details className={styles.advanced}>
            <summary>Настройки серверов соединения</summary>
            <label>
              <span>ICE-серверы, JSON</span>
              <textarea
                rows={7}
                value={ice}
                spellCheck={false}
                onChange={(event) => setIce(event.target.value)}
              />
            </label>
            <p>
              Если прямое соединение недоступно, игра использует соединение с
              сервером сайта. Для TURN укажите свои действующие параметры.
            </p>
          </details>
        </section>
        <ErrorNotice message={error} />
        <button type="submit" className={styles.primary} disabled={busy}>
          <Save size={16} />
          {busy ? "Сохраняем…" : "Сохранить настройки"}
        </button>
      </form>
      <aside className={styles.logoAside}>
        <div className={styles.panel}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>Логотип LumaBall</h2>
              <p>Прозрачный PNG. Можно заменить в любое время.</p>
            </div>
          </div>
          <LogoUpload<LumaConfig>
            title="Логотип LumaBall"
            currentUrl={form.logo_url || "/branding/lumaball-mark.svg"}
            custom={Boolean(form.logo_url)}
            endpoint="/admin/lumaball/logo"
            onSaved={(result) => {
              setForm((current) => ({ ...current, logo_url: result.logo_url }));
              window.dispatchEvent(new Event("lumaball:updated"));
            }}
          />
        </div>
        <div className={styles.tip}>
          <ShieldCheck size={20} />
          <h3>Один аккаунт — два пространства</h3>
          <p>
            Игроки QStudy входят без повторной регистрации. Блокировка игрового
            профиля ограничивает доступ только к LumaBall.
          </p>
          <Link href="/dashboard/admin">
            Управлять аккаунтами <ArrowUpRight size={14} />
          </Link>
        </div>
      </aside>
    </div>
  );
}
