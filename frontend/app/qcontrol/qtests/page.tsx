"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ArrowUpRight, FileQuestion, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useResource, ErrorNotice, Loading } from "@/components/academic";
import { LogoUpload } from "@/components/logo-upload";
import {
  useQTestsBranding,
  notifyQTestsBranding,
  type QTestsBranding,
} from "@/components/qtests-brand";
import styles from "@/components/control/control.module.css";

type Settings = {
  enabled: boolean;
  title: string;
  description: string;
  announcement: string;
  default_question_count: number;
};
type Owner = { id: number; name: string; email: string };
type Bank = {
  id: number;
  title: string;
  filename: string;
  status: string;
  error: string;
  question_count: number;
  owner: Owner;
  created_at: string;
};
type Attempt = {
  id: number;
  bank_title: string;
  status: string;
  question_count: number;
  answered_count: number;
  score: number;
  owner: Owner;
};
type Overview = {
  banks: Bank[];
  attempts: Attempt[];
  settings: Settings;
  stats: {
    banks: number;
    questions: number;
    attempts: number;
    finished: number;
    importing: number;
    errors: number;
  };
};
const statuses: Record<string, string> = {
  importing: "Импортируется",
  ready: "Готов",
  error: "Ошибка импорта",
  active: "В процессе",
  finished: "Завершён",
  queued: "В очереди",
};

function SettingsForm({
  initial,
  saved,
}: {
  initial: Settings;
  saved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Settings>({
    enabled: initial.enabled,
    title: initial.title,
    description: initial.description,
    announcement: initial.announcement || "",
    default_question_count: initial.default_question_count || 40,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/admin/qtests/settings", {
        method: "PATCH",
        body: JSON.stringify(draft),
      });
      await saved();
      setNotice("Настройки QTests сохранены.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить настройки",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="panel" style={{ padding: 24 }}>
      <h2>Настройки проекта</h2>
      <p className="muted">
        Общий доступ и содержание главной страницы QTests.
      </p>
      <label
        className="academic-field"
        style={{ display: "flex", gap: 10, marginBlock: 18 }}
      >
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />{" "}
        QTests доступен участникам
      </label>
      <div className="academic-form-grid">
        <label className="academic-field">
          Название
          <input
            className="field"
            required
            maxLength={100}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <label className="academic-field">
          Вопросов по умолчанию
          <input
            className="field"
            type="number"
            min={1}
            max={200}
            value={draft.default_question_count}
            onChange={(e) =>
              setDraft({
                ...draft,
                default_question_count: Number(e.target.value) || 1,
              })
            }
          />
        </label>
        <label className="academic-field">
          Описание
          <textarea
            className="field"
            rows={3}
            maxLength={2000}
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
        </label>
        <label className="academic-field">
          Объявление
          <textarea
            className="field"
            rows={3}
            maxLength={2000}
            value={draft.announcement}
            onChange={(e) =>
              setDraft({ ...draft, announcement: e.target.value })
            }
          />
        </label>
      </div>
      <ErrorNotice message={error} />
      {notice && <p role="status">{notice}</p>}
      <button className="btn btn-primary" disabled={busy} type="submit">
        {busy ? "Сохраняем…" : "Сохранить настройки"}
      </button>
    </form>
  );
}

export default function QTestsControl() {
  const resource = useResource<Overview>("/admin/qtests/overview");
  const logo = useQTestsBranding();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const data = resource.data;
  async function remove(kind: "banks" | "attempts", id: number) {
    const message =
      kind === "banks"
        ? "Удалить этот банк? Уже созданные попытки и их результаты сохранятся."
        : "Удалить эту попытку и её ответы без возможности восстановления?";
    if (!window.confirm(message)) return;
    setBusy(`${kind}-${id}`);
    setError("");
    setNotice("");
    try {
      await api(`/qtests/${kind}/${id}`, { method: "DELETE" });
      await resource.reload();
      setNotice(
        kind === "banks"
          ? "Банк удалён; история попыток сохранена."
          : "Попытка удалена.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось удалить запись",
      );
    } finally {
      setBusy("");
    }
  }
  const matches = (text: string) =>
    text
      .toLocaleLowerCase("ru")
      .includes(search.trim().toLocaleLowerCase("ru"));
  const banks = (data?.banks || []).filter((bank) =>
    matches(
      `${bank.title} ${bank.filename} ${bank.owner?.name} ${bank.owner?.email}`,
    ),
  );
  return (
    <div>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>QTESTS / УПРАВЛЕНИЕ</p>
          <h1>Знания в вопросах.</h1>
          <p>
            Банки из Word, вопросы, попытки и параметры проекта в общей базе
            Q-ID.
          </p>
        </div>
        <button
          className={styles.refresh}
          onClick={() => void resource.reload()}
          disabled={resource.loading}
        >
          <RefreshCw size={14} />
          Обновить
        </button>
      </div>
      <ErrorNotice message={resource.error || error} />
      {notice && <p role="status">{notice}</p>}
      <div className="academic-actions" style={{ marginBottom: 22 }}>
        <Link className="btn btn-primary" href="/qtests/library">
          Загрузить Word / создать банк <ArrowUpRight size={15} />
        </Link>
        <Link className="btn btn-secondary" href="/qtests">
          Открыть QTests
        </Link>
      </div>
      {resource.loading && !data && <Loading />}
      {data && (
        <>
          <section className={styles.stats} aria-label="Показатели QTests">
            {(
              [
                ["Банков вопросов", data.stats.banks],
                ["Вопросов в базе", data.stats.questions],
                ["Попыток", data.stats.attempts],
                ["Завершено", data.stats.finished],
              ] as const
            ).map(([label, count]) => (
              <article className={styles.stat} key={label}>
                <div className={styles.statTop}>
                  <span>{label}</span>
                  <FileQuestion size={17} />
                </div>
                <strong>{count.toLocaleString("ru-RU")}</strong>
              </article>
            ))}
          </section>
          <SettingsForm initial={data.settings} saved={resource.reload} />
        </>
      )}
      <div className="panel" style={{ padding: 24, marginTop: 20 }}>
        <LogoUpload<QTestsBranding>
          title="Логотип QTests"
          currentUrl={logo.branding.logo_url}
          custom={logo.branding.logo_custom}
          endpoint="/branding/tests-logo"
          onSaved={notifyQTestsBranding}
        />
        <ErrorNotice message={logo.error} />
      </div>
      <div className={styles.sectionHeading} style={{ marginTop: 30 }}>
        <h2>Все банки вопросов</h2>
        <span>Содержимое доступно владельцу и администратору</span>
      </div>
      <label className="academic-field" style={{ marginBottom: 15 }}>
        Поиск по названию или владельцу
        <input
          className="field"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Название, имя или email"
        />
      </label>
      <div className={`panel academic-table-wrap ${styles.table}`}>
        <table className="academic-table">
          <thead>
            <tr>
              <th>Банк</th>
              <th>Владелец</th>
              <th>Вопросы</th>
              <th>Состояние</th>
              <th>Управление</th>
            </tr>
          </thead>
          <tbody>
            {banks.map((bank) => (
              <tr key={bank.id}>
                <td>
                  <strong>{bank.title}</strong>
                  <br />
                  <small>{bank.filename}</small>
                </td>
                <td>
                  {bank.owner?.name || "Участник"}
                  <br />
                  <small>{bank.owner?.email}</small>
                </td>
                <td>{bank.question_count}</td>
                <td>
                  {statuses[bank.status] || bank.status}
                  {bank.error && <p role="alert">{bank.error}</p>}
                </td>
                <td>
                  <div className="academic-actions">
                    <Link
                      className="btn btn-secondary"
                      href={`/qtests/banks/${bank.id}`}
                    >
                      Вопросы и редактирование
                    </Link>
                    <button
                      className="btn btn-danger"
                      disabled={Boolean(busy)}
                      onClick={() => void remove("banks", bank.id)}
                      aria-label={`Удалить банк ${bank.title}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {data && !banks.length && (
              <tr>
                <td colSpan={5}>
                  Банки не найдены. Загрузите Word или измените поиск.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className={styles.sectionHeading} style={{ marginTop: 30 }}>
        <h2>Последние попытки</h2>
        <span>История и результаты участников</span>
      </div>
      <div className={`panel academic-table-wrap ${styles.table}`}>
        <table className="academic-table">
          <thead>
            <tr>
              <th>Банк / участник</th>
              <th>Состояние</th>
              <th>Ответов</th>
              <th>Результат</th>
              <th>Управление</th>
            </tr>
          </thead>
          <tbody>
            {(data?.attempts || []).map((attempt) => (
              <tr key={attempt.id}>
                <td>
                  <strong>{attempt.bank_title}</strong>
                  <br />
                  <small>
                    {attempt.owner?.name} · {attempt.owner?.email}
                  </small>
                </td>
                <td>{statuses[attempt.status] || attempt.status}</td>
                <td>
                  {attempt.answered_count} / {attempt.question_count}
                </td>
                <td>
                  {attempt.status === "finished"
                    ? `${attempt.score}%`
                    : "В процессе"}
                </td>
                <td>
                  <div className="academic-actions">
                    <Link
                      className="btn btn-secondary"
                      href={`/qtests/attempts/${attempt.id}`}
                    >
                      Открыть
                    </Link>
                    <button
                      className="btn btn-danger"
                      disabled={Boolean(busy)}
                      onClick={() => void remove("attempts", attempt.id)}
                      aria-label={`Удалить попытку ${attempt.id}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {data && !data.attempts.length && (
              <tr>
                <td colSpan={5}>Попыток пока нет.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
