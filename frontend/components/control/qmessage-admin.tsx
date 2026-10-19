"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Check,
  MessagesSquare,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sticker,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  ErrorNotice,
  Loading,
  errorMessage,
  useResource,
} from "@/components/academic";
import { LogoUpload } from "@/components/logo-upload";
import {
  notifyQMessageBranding,
  useQMessageBranding,
  type QMessageBranding,
} from "@/components/qmessage-brand";
import control from "./control.module.css";
import styles from "./qmessage-admin.module.css";

type Config = { enabled: boolean; title: string; announcement: string };
type Overview = {
  settings: Config;
  stats: {
    conversations: number;
    messages: number;
    users: number;
    banned_users: number;
    open_reports: number;
    stickers: number;
  };
};
type User = {
  id: number;
  name: string;
  group_name?: string | null;
  role?: string;
  is_active?: boolean;
  banned?: boolean;
  ban_reason?: string;
};
type StickerItem = {
  id: string;
  label: string;
  emoji: string;
  image_url: string | null;
  active: boolean;
  position: number;
  builtin: boolean;
};
type Report = {
  id: number;
  message_id: number;
  reporter: User;
  author: User;
  reason: string;
  status: string;
  created_at: string;
  resolved_at?: string | null;
  message: {
    id: number;
    text: string;
    deleted: boolean;
    sticker: StickerItem | null;
    attachment: { filename: string; url: string } | null;
  } | null;
};
const date = (value: string) =>
  new Date(
    value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`,
  ).toLocaleString("ru-RU");
const safeStickerImage = (sticker: StickerItem) => {
  if (
    sticker.builtin &&
    [
      "wave",
      "heart",
      "spark",
      "party",
      "laugh",
      "study",
      "goal",
      "thanks",
    ].includes(sticker.id) &&
    sticker.image_url === `/qmessage-stickers/${sticker.id}.svg`
  )
    return sticker.image_url;
  return /^[a-z][a-z0-9_-]{0,59}$/.test(sticker.id) &&
    sticker.image_url === `/api/qmessage/stickers/${sticker.id}/image`
    ? sticker.image_url
    : null;
};

function StickerPreview({ sticker }: { sticker: StickerItem }) {
  const source = safeStickerImage(sticker);
  const [failed, setFailed] = useState("");
  return (
    <div className={styles.stickerVisual}>
      {source && failed !== source ? (
        <Image
          src={source}
          alt={sticker.label}
          width={100}
          height={100}
          unoptimized
          onError={() => setFailed(source)}
        />
      ) : (
        sticker.emoji
      )}
    </div>
  );
}

function SettingsPanel({
  initial,
  saved,
}: {
  initial: Config;
  saved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Config>({
    enabled: initial.enabled,
    title: initial.title,
    announcement: initial.announcement || "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/admin/qmessage/settings", {
        method: "PATCH",
        body: JSON.stringify(draft),
      });
      await saved();
      setNotice("Настройки QMessage сохранены.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={styles.section}
      aria-labelledby="message-settings-title"
    >
      <div className={styles.header}>
        <div>
          <h2 id="message-settings-title">Настройки проекта</h2>
          <p>Общий доступ и объявление для участников QMessage.</p>
        </div>
      </div>
      <form onSubmit={submit} aria-label="Настройки QMessage">
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, enabled: event.target.checked })
            }
          />{" "}
          QMessage доступен участникам
        </label>
        <div className={styles.grid}>
          <label className="academic-field">
            Название
            <input
              className="field"
              required
              maxLength={120}
              value={draft.title}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label className={`academic-field ${styles.wide}`}>
            Объявление
            <textarea
              className="field"
              rows={3}
              maxLength={2000}
              value={draft.announcement}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, announcement: event.target.value })
              }
            />
          </label>
        </div>
        <ErrorNotice message={error} />
        {notice && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
        <button
          className="btn btn-primary"
          disabled={busy || !draft.title.trim()}
        >
          {busy ? "Сохраняем…" : "Сохранить настройки"}
        </button>
      </form>
    </section>
  );
}

function AccessPanel({ changed }: { changed: () => Promise<void> }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const resource = useResource<{ items: User[] }>(
    `/admin/qmessage/users?q=${encodeURIComponent(query)}`,
  );
  const [selected, setSelected] = useState<User | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/admin/qmessage/users/${selected.id}/ban`, {
        method: "PATCH",
        body: JSON.stringify({
          banned: !selected.banned,
          reason: reason.trim(),
        }),
      });
      const restored = selected.banned;
      setSelected(null);
      await Promise.all([resource.reload(), changed()]);
      setNotice(
        restored
          ? "Доступ к QMessage восстановлен."
          : "Отправка сообщений для участника ограничена. Аккаунт Q-ID сохранён.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.section} aria-labelledby="message-access-title">
      <div className={styles.header}>
        <div>
          <h2 id="message-access-title">Участники и доступ</h2>
          <p>
            Ограничения действуют в QMessage. Учебные данные и общий аккаунт
            Q-ID остаются в системе.
          </p>
        </div>
        <button
          className="btn btn-secondary"
          disabled={resource.loading}
          onClick={() => void resource.reload()}
          aria-label="Обновить участников QMessage"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <form
        className={styles.search}
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search.trim());
        }}
      >
        <label className="academic-field">
          Найти участника
          <input
            className="field"
            type="search"
            maxLength={100}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Имя или группа"
          />
        </label>
        <button className="btn btn-secondary">
          <Search size={14} /> Найти
        </button>
      </form>
      <ErrorNotice message={resource.error || error} />
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {selected && (
        <form
          className={styles.confirmation}
          onSubmit={save}
          aria-label="Подтверждение ограничения QMessage"
        >
          <h3>
            {selected.banned ? "Восстановить доступ" : "Ограничить сообщения"}:{" "}
            {selected.name}
          </h3>
          <label className="academic-field">
            {selected.banned
              ? "Комментарий · необязательно"
              : "Причина ограничения"}
            <textarea
              className="field"
              required={!selected.banned}
              maxLength={500}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className={styles.actions}>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Сохраняем…" : "Подтвердить"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              Отмена
            </button>
          </div>
        </form>
      )}
      {resource.loading && !resource.data && <Loading />}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Участник</th>
              <th>Группа / роль</th>
              <th>Доступ</th>
              <th>Управление</th>
            </tr>
          </thead>
          <tbody>
            {resource.data?.items.map((user) => (
              <tr key={user.id}>
                <td>
                  <strong>{user.name}</strong>
                  <small>Q-ID #{user.id}</small>
                </td>
                <td>
                  {user.group_name || "Без группы"}
                  <small>
                    {user.role === "admin" ? "Администратор" : "Студент"}
                  </small>
                </td>
                <td>
                  <span className={styles.status}>
                    {user.banned
                      ? "Сообщения ограничены"
                      : user.is_active === false
                        ? "Аккаунт отключён"
                        : "Доступен"}
                  </span>
                  {user.ban_reason && <small>{user.ban_reason}</small>}
                </td>
                <td>
                  <button
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => {
                      setSelected(user);
                      setReason(user.banned ? "" : user.ban_reason || "");
                      setError("");
                    }}
                  >
                    {user.banned ? "Восстановить" : "Ограничить"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {resource.data && !resource.data.items.length && (
        <p className={styles.empty}>
          Участники не найдены. Измените поисковый запрос.
        </p>
      )}
      <p className={styles.muted}>
        Показываются до 100 совпадений. Для остальных участников используйте
        поиск.
      </p>
    </section>
  );
}

function ReportsPanel({ changed }: { changed: () => Promise<void> }) {
  const [status, setStatus] = useState("open");
  const resource = useResource<{ items: Report[] }>(
    `/admin/qmessage/reports?status=${status}`,
  );
  const [confirm, setConfirm] = useState<{
    id: number;
    deleteMessage: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function resolve() {
    if (!confirm || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/admin/qmessage/reports/${confirm.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ delete_message: confirm.deleteMessage }),
      });
      const removed = confirm.deleteMessage;
      setConfirm(null);
      await Promise.all([resource.reload(), changed()]);
      setNotice(
        removed
          ? "Сообщение удалено, жалоба закрыта. Решение записано в журнал."
          : "Жалоба закрыта. Решение записано в журнал.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.section} aria-labelledby="message-reports-title">
      <div className={styles.header}>
        <div>
          <h2 id="message-reports-title">Жалобы и модерация</h2>
          <p>
            Здесь видны только сообщения, на которые поступила жалоба. Личные
            диалоги целиком администратору не открываются.
          </p>
        </div>
        <label className="academic-field">
          Показать
          <select
            className="field"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setConfirm(null);
            }}
          >
            <option value="open">Открытые</option>
            <option value="resolved">Закрытые</option>
            <option value="all">Все</option>
          </select>
        </label>
      </div>
      <ErrorNotice message={resource.error || error} />
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {resource.error && (
        <button
          className="btn btn-secondary"
          onClick={() => void resource.reload()}
        >
          Повторить загрузку жалоб
        </button>
      )}
      {resource.loading && !resource.data && <Loading />}
      <div className={styles.reportList}>
        {resource.data?.items.map((report) => (
          <article className={styles.report} key={report.id}>
            <h3>
              Жалоба #{report.id} ·{" "}
              {report.status === "resolved" ? "Закрыта" : "Открыта"}
            </h3>
            <p className={styles.muted}>
              {report.reporter.name} · {date(report.created_at)}
              <br />
              Автор сообщения: {report.author.name}
            </p>
            <p>
              <strong>Причина: </strong>
              {report.reason}
            </p>
            <div className={styles.quote}>
              {!report.message || report.message.deleted ? (
                "Сообщение удалено"
              ) : (
                <>
                  {report.message.text}
                  {report.message.sticker && (
                    <p>
                      Стикер: {report.message.sticker.emoji}{" "}
                      {report.message.sticker.label}
                    </p>
                  )}
                  {report.message.attachment && (
                    <div className={styles.attachment}>
                      Вложение: {report.message.attachment.filename}
                      {new RegExp(
                        `^/api/admin/qmessage/reports/${report.id}/attachment$`,
                      ).test(report.message.attachment.url) && (
                        <Image
                          src={report.message.attachment.url}
                          alt="Вложение сообщения из жалобы"
                          width={400}
                          height={250}
                          unoptimized
                        />
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            {report.status === "open" && (
              <div className={styles.actions}>
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    setConfirm({ id: report.id, deleteMessage: false })
                  }
                >
                  <Check size={14} /> Закрыть жалобу
                </button>
                <button
                  className="btn btn-danger"
                  disabled={busy || !report.message || report.message.deleted}
                  onClick={() =>
                    setConfirm({ id: report.id, deleteMessage: true })
                  }
                >
                  <Trash2 size={14} /> Удалить сообщение
                </button>
              </div>
            )}
            {confirm?.id === report.id && (
              <div className={styles.confirmation} role="alert">
                <h3>
                  {confirm.deleteMessage
                    ? "Удалить это сообщение и закрыть жалобу?"
                    : "Закрыть жалобу без удаления сообщения?"}
                </h3>
                <p>
                  {confirm.deleteMessage
                    ? "Текст и вложение этого сообщения станут недоступны участникам. Остальной диалог сохранится."
                    : "Сообщение останется у участников. Жалоба будет отмечена как рассмотренная."}
                </p>
                <div className={styles.actions}>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void resolve()}
                  >
                    {busy ? "Сохраняем…" : "Подтвердить решение"}
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => setConfirm(null)}
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
      {resource.data && !resource.data.items.length && (
        <p className={styles.empty}>Жалоб с выбранным статусом нет.</p>
      )}
    </section>
  );
}

type StickerDraft = {
  id: string;
  label: string;
  emoji: string;
  active: boolean;
  position: number;
};
function StickerEditor({
  initial,
  saved,
  cancel,
}: {
  initial?: StickerItem;
  saved: () => Promise<void>;
  cancel: () => void;
}) {
  const [draft, setDraft] = useState<StickerDraft>({
    id: initial?.id || "",
    label: initial?.label || "",
    emoji: initial?.emoji || "✨",
    active: initial?.active ?? true,
    position: initial?.position || 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { id: _id, ...fields } = draft;
      await api(
        `/admin/qmessage/stickers${initial ? `/${encodeURIComponent(initial.id)}` : ""}`,
        {
          method: initial ? "PATCH" : "POST",
          body: JSON.stringify(initial ? fields : draft),
        },
      );
      await saved();
      cancel();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className={styles.stickerForm}
      onSubmit={submit}
      aria-label={initial ? "Редактирование стикера" : "Новый стикер"}
    >
      <h3>{initial ? "Изменить стикер" : "Добавить стикер"}</h3>
      <div className={styles.grid}>
        <label className="academic-field">
          Код
          <input
            className="field"
            required
            pattern="[a-z][a-z0-9_-]{0,59}"
            maxLength={60}
            title="Строчная латинская буква в начале; затем буквы, цифры, дефис и подчёркивание. До 60 символов."
            value={draft.id}
            disabled={busy || !!initial}
            onChange={(event) => setDraft({ ...draft, id: event.target.value })}
            placeholder="например, qforce-wave"
          />
        </label>
        <label className="academic-field">
          Название
          <input
            className="field"
            required
            maxLength={80}
            value={draft.label}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, label: event.target.value })
            }
          />
        </label>
        <label className="academic-field">
          Эмодзи
          <input
            className="field"
            required
            maxLength={16}
            value={draft.emoji}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, emoji: event.target.value })
            }
          />
        </label>
        <label className="academic-field">
          Порядок
          <input
            className="field"
            type="number"
            required
            min={0}
            max={10000}
            value={draft.position}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, position: Number(event.target.value) })
            }
          />
        </label>
      </div>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={draft.active}
          disabled={busy}
          onChange={(event) =>
            setDraft({ ...draft, active: event.target.checked })
          }
        />{" "}
        Доступен для новых сообщений
      </label>
      <ErrorNotice message={error} />
      <div className={styles.actions}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Сохраняем…" : "Сохранить стикер"}
        </button>
        <button
          className="btn btn-secondary"
          type="button"
          disabled={busy}
          onClick={cancel}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}

function StickerImage({
  sticker,
  saved,
}: {
  sticker: StickerItem;
  saved: () => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const customImage =
    sticker.image_url === `/api/qmessage/stickers/${sticker.id}/image`;
  function choose(next: File | undefined) {
    setError("");
    setNotice("");
    setFile(null);
    if (!next) return;
    if (
      !/\.(png|jpe?g)$/i.test(next.name) ||
      !next.size ||
      next.size > 2 * 1024 * 1024
    ) {
      setError("Выберите непустой PNG или JPEG до 2 МБ.");
      if (input.current) input.current.value = "";
      return;
    }
    setFile(next);
  }
  async function mutate(remove = false) {
    if (busy || (!remove && !file)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = new FormData();
      if (file) body.set("file", file);
      await api(
        `/admin/qmessage/stickers/${encodeURIComponent(sticker.id)}/image`,
        { method: remove ? "DELETE" : "PUT", ...(remove ? {} : { body }) },
      );
      await saved();
      setFile(null);
      setConfirm(false);
      if (input.current) input.current.value = "";
      setNotice(
        remove
          ? sticker.builtin
            ? "Стандартное изображение восстановлено."
            : "Изображение убрано."
          : "Изображение стикера сохранено.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.imageForm}>
      <label className="academic-field">
        Изображение · PNG / JPEG до 2 МБ
        <input
          ref={input}
          className="field"
          type="file"
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          disabled={busy}
          onChange={(event) => choose(event.target.files?.[0])}
        />
      </label>
      <div className={styles.actions}>
        <button
          className="btn btn-secondary"
          type="button"
          disabled={busy || !file}
          onClick={() => void mutate()}
        >
          <Upload size={14} /> {busy ? "Сохраняем…" : "Загрузить картинку"}
        </button>
        {customImage && (
          <button
            className="btn btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => setConfirm(!confirm)}
          >
            Убрать картинку
          </button>
        )}
      </div>
      {confirm && (
        <div className={styles.confirmation} role="alert">
          <p>
            {sticker.builtin
              ? "Восстановить стандартное изображение этого стикера? Загруженная вами картинка будет убрана."
              : "Убрать изображение этого стикера? Вместо него будет показан эмодзи."}
          </p>
          <div className={styles.actions}>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void mutate(true)}
            >
              Да, убрать
            </button>
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
      <ErrorNotice message={error} />
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

function StickersPanel({ changed }: { changed: () => Promise<void> }) {
  const resource = useResource<{ items: StickerItem[] }>(
    "/admin/qmessage/stickers",
  );
  const [editing, setEditing] = useState<StickerItem | "new" | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function reload() {
    await Promise.all([resource.reload(), changed()]);
  }
  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/admin/qmessage/stickers/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      setConfirm(null);
      await reload();
      setNotice(
        "Стикер скрыт из каталога для новых сообщений. Отправленные ранее сообщения сохраняются.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={styles.section}
      aria-labelledby="message-stickers-title"
    >
      <div className={styles.header}>
        <div>
          <h2 id="message-stickers-title">Каталог стикеров</h2>
          <p>
            Создавайте стикеры, меняйте подписи, порядок и изображения.
            Неактивные стикеры скрываются для новых сообщений.
          </p>
        </div>
        <button
          className="btn btn-secondary"
          disabled={editing !== null}
          onClick={() => setEditing("new")}
        >
          <Plus size={14} /> Добавить стикер
        </button>
      </div>
      <ErrorNotice message={resource.error || error} />
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {resource.error && (
        <button
          className="btn btn-secondary"
          onClick={() => void resource.reload()}
        >
          Повторить загрузку стикеров
        </button>
      )}
      {resource.loading && !resource.data && <Loading />}
      {editing && (
        <StickerEditor
          key={typeof editing === "string" ? editing : editing.id}
          initial={editing === "new" ? undefined : editing}
          saved={reload}
          cancel={() => setEditing(null)}
        />
      )}
      <div className={styles.stickerGrid}>
        {resource.data?.items.map((sticker) => (
          <article className={styles.sticker} key={sticker.id}>
            <StickerPreview sticker={sticker} />
            <h3>{sticker.label}</h3>
            <p className={styles.muted}>
              {sticker.id} · порядок {sticker.position}
              <br />
              {sticker.active ? "Доступен" : "Скрыт"}
              {sticker.builtin && " · встроенный"}
            </p>
            <div className={styles.actions}>
              <button
                className="btn btn-secondary"
                disabled={busy || editing !== null}
                onClick={() => setEditing(sticker)}
              >
                Изменить
              </button>
              <button
                className="btn btn-secondary"
                disabled={busy || !sticker.active}
                onClick={() =>
                  setConfirm(confirm === sticker.id ? null : sticker.id)
                }
              >
                <X size={14} /> Скрыть
              </button>
            </div>
            {confirm === sticker.id && (
              <div className={styles.confirmation} role="alert">
                <p>Скрыть стикер «{sticker.label}» из новых сообщений?</p>
                <div className={styles.actions}>
                  <button
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => void remove(sticker.id)}
                  >
                    Да, скрыть
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => setConfirm(null)}
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}
            <StickerImage sticker={sticker} saved={reload} />
          </article>
        ))}
      </div>
      {resource.data && !resource.data.items.length && (
        <p className={styles.empty}>Добавьте первый стикер.</p>
      )}
    </section>
  );
}

export default function QMessageAdmin() {
  const { user } = useAuth();
  const resource = useResource<Overview>(
    user.role === "admin" ? "/admin/qmessage/overview" : null,
  );
  const logo = useQMessageBranding();
  if (user.role !== "admin")
    return <p role="alert">Управление QMessage доступно администратору.</p>;
  return (
    <div>
      <div className={control.heading}>
        <div>
          <p className={control.eyebrow}>QMESSAGE / УПРАВЛЕНИЕ</p>
          <h1>Общение под контролем.</h1>
          <p>Доступ к проекту, жалобы участников, стикеры и фирменный знак.</p>
        </div>
        <button
          className={control.refresh}
          disabled={resource.loading}
          onClick={() => void resource.reload()}
        >
          <RefreshCw size={14} /> Обновить
        </button>
      </div>
      <div className="academic-actions">
        <Link className="btn btn-primary" href="/qmessage">
          <MessagesSquare size={15} /> Открыть QMessage{" "}
          <ArrowUpRight size={15} />
        </Link>
      </div>
      <ErrorNotice message={resource.error} />
      {resource.error && (
        <button
          className="btn btn-secondary"
          onClick={() => void resource.reload()}
        >
          Повторить загрузку статистики
        </button>
      )}
      {resource.loading && !resource.data && <Loading />}
      {resource.data && (
        <>
          <section className={control.stats} aria-label="Показатели QMessage">
            {(
              [
                ["Участников", resource.data.stats.users, MessagesSquare],
                ["Сообщений", resource.data.stats.messages, MessagesSquare],
                [
                  "Открытых жалоб",
                  resource.data.stats.open_reports,
                  ShieldCheck,
                ],
                ["Стикеров", resource.data.stats.stickers, Sticker],
              ] as const
            ).map(([label, count, Icon]) => (
              <article className={control.stat} key={label}>
                <div className={control.statTop}>
                  <span>{label}</span>
                  <Icon size={17} />
                </div>
                <strong>{count.toLocaleString("ru-RU")}</strong>
              </article>
            ))}
          </section>
          <SettingsPanel
            initial={resource.data.settings}
            saved={resource.reload}
          />
        </>
      )}
      <section className={styles.section} aria-label="Брендинг QMessage">
        <LogoUpload<QMessageBranding>
          title="Логотип QMessage"
          currentUrl={logo.branding.logo_url}
          custom={logo.branding.logo_custom}
          endpoint="/branding/message-logo"
          onSaved={notifyQMessageBranding}
        />
        <ErrorNotice message={logo.error} />
        {logo.error && (
          <button
            className="btn btn-secondary"
            onClick={() => void logo.refresh()}
          >
            Повторить загрузку логотипа
          </button>
        )}
      </section>
      <ReportsPanel changed={resource.reload} />
      <AccessPanel changed={resource.reload} />
      <StickersPanel changed={resource.reload} />
    </div>
  );
}
