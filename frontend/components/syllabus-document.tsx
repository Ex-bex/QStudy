"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  Download,
  FileText,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { api, API_URL, formatBytes } from "@/lib/api";
import { normalizeSyllabusDraft } from "@/lib/syllabus-draft";
import { useAuth } from "@/lib/auth";
import {
  DeleteButton,
  RecordEditor,
  ErrorNotice,
  Modal,
  Loading,
  DetailBlock,
  errorMessage,
  weekFields,
  workFields,
  type FieldDefinition,
} from "@/components/academic";
import type {
  DraftWeek,
  DraftWork,
  Syllabus,
  SyllabusDraft,
} from "@/types/academic";

const statuses: Record<string, string> = {
  extracted: "Текст извлечён",
  needs_ocr: "Нужно распознавание текста",
  needs_configuration: "Нужна настройка ИИ",
  queued: "В очереди ИИ",
  running: "ИИ готовит программу",
  import_error: "Импорт не завершён",
  review: "На проверке",
  published: "Опубликован",
};
const blankWeek: DraftWeek = {
  week_number: 1,
  title: "",
  module: "",
  hours: 0,
  content: "",
  tasks: "",
  assessment: "",
  resources: "",
};
const blankWork: DraftWork = {
  title: "",
  description: "",
  module: "",
  week_number: null,
  max_score: 100,
  kind: "assignment",
};
function DraftFields({
  fields,
  value,
  change,
}: {
  fields: FieldDefinition[];
  value: Record<string, unknown>;
  change: (key: string, value: unknown) => void;
}) {
  return (
    <div className="academic-fields">
      {fields.map((field) => (
        <label className="academic-field" key={field.name}>
          <span>{field.label}</span>
          {field.type === "textarea" ? (
            <textarea
              className="field"
              rows={3}
              required={field.required}
              value={String(value[field.name] ?? "")}
              onChange={(e) => change(field.name, e.target.value)}
            />
          ) : field.type === "select" ? (
            <select
              className="field"
              value={String(value[field.name] ?? "")}
              onChange={(e) => change(field.name, e.target.value)}
            >
              {field.options?.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="field"
              type={field.type || "text"}
              min={field.min}
              max={field.max}
              required={field.required}
              value={String(value[field.name] ?? "")}
              onChange={(e) =>
                change(
                  field.name,
                  field.type === "number"
                    ? e.target.value === ""
                      ? null
                      : Number(e.target.value)
                    : e.target.value,
                )
              }
            />
          )}
        </label>
      ))}
    </div>
  );
}
export default function SyllabusDocument({
  document,
  onChanged,
}: {
  document: Syllabus;
  onChanged: () => void | Promise<void>;
}) {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Syllabus | null>(null);
  const [draft, setDraft] = useState<SyllabusDraft>(() =>
    normalizeSyllabusDraft(null),
  );
  const [title, setTitle] = useState(document.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editing, setEditing] = useState(false);
  const [publish, setPublish] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  function markDirty() {
    dirtyRef.current = true;
    setDirty(true);
  }
  const current = detail || document;
  const facts = draft.course_facts;
  const factItems = facts
    ? [
        { label: "Преподаватель", value: facts.teacher },
        {
          label: "Кредиты",
          value:
            facts.credits === null ? "" : facts.credits.toLocaleString("ru-RU"),
        },
        {
          label: "Общий объём",
          value:
            facts.total_hours === null
              ? ""
              : `${facts.total_hours.toLocaleString("ru-RU")} ч.`,
        },
        {
          label: "Семестр",
          value: facts.semester === null ? "" : String(facts.semester),
        },
        { label: "Группа в документе", value: facts.source_group },
      ].filter((item) => item.value)
    : [];
  const visibleWeeks = draft.weeks.length
    ? draft.weeks
    : normalizeSyllabusDraft(null, current).weeks;
  const warnings = Array.isArray(current.warnings)
    ? current.warnings.filter((warning) => typeof warning === "string")
    : [];
  const detailStatus = detail?.status;
  const importing = ["queued", "running"].includes(current.status);
  const requiresOcr =
    typeof current.filename === "string" &&
    current.filename.toLowerCase().endsWith(".pdf") &&
    !(
      typeof current.extracted_text === "string" &&
      current.extracted_text.trim().length >= 30
    );
  const load = useCallback(async () => {
    const data = await api<Syllabus>(`/syllabi/${document.id}`);
    setDetail(data);
    setTitle(data.title);
    setDraft(normalizeSyllabusDraft(data.draft, data));
    dirtyRef.current = false;
    setDirty(false);
    return data;
  }, [document.id]);
  useEffect(() => {
    if ((!open && (!detailStatus || document.status === detailStatus)) || dirty)
      return;
    let active = true;
    const refresh = async () => {
      try {
        const data = await api<Syllabus>(`/syllabi/${document.id}`);
        if (!active || dirtyRef.current) return;
        setDetail(data);
        setTitle(data.title);
        setDraft(normalizeSyllabusDraft(data.draft, data));
      } catch (e) {
        if (active) setError(errorMessage(e));
      }
    };
    void refresh();
    const timer = importing
      ? window.setInterval(() => void refresh(), 4000)
      : null;
    return () => {
      active = false;
      if (timer) window.clearInterval(timer);
    };
  }, [
    document.id,
    document.status,
    document.import_job?.status,
    open,
    dirty,
    importing,
    detailStatus,
  ]);
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      setBusy(true);
      setError("");
      try {
        await load();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    }
  }
  async function analyze() {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await api<Syllabus>(`/syllabi/${document.id}/analyze`, {
        method: "POST",
      });
      await load();
      setEditing(false);
      setSuccess(
        result.status === "needs_configuration"
          ? "Документ сохранён. Добавьте ключ ИИ в настройки сервера и повторите импорт."
          : "Автоматический импорт поставлен в очередь. Можно закрыть страницу: задача сохранена и продолжится после перезапуска.",
      );
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/syllabi/${document.id}`, {
        method: "PUT",
        body: JSON.stringify({ title, summary: draft.summary, draft }),
      });
      await load();
      await onChanged();
      setSuccess("Изменения сохранены. Черновик готов к проверке.");
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function publishDraft() {
    setBusy(true);
    setError("");
    try {
      await api(`/syllabi/${document.id}/publish`, {
        method: "POST",
        body: JSON.stringify({ replace_existing: false }),
      });
      await load();
      await onChanged();
      setPublish(false);
      setSuccess(
        "Программа опубликована. Недели и работы доступны на странице дисциплины.",
      );
    } catch (e) {
      setError(errorMessage(e));
      setPublish(false);
    } finally {
      setBusy(false);
    }
  }
  function updateWeek(index: number, key: string, value: unknown) {
    setDraft((previous) => ({
      ...previous,
      weeks: previous.weeks.map((week, i) =>
        i === index ? { ...week, [key]: value } : week,
      ),
    }));
    markDirty();
  }
  function updateWork(index: number, key: string, value: unknown) {
    setDraft((previous) => ({
      ...previous,
      works: previous.works.map((work, i) =>
        i === index ? { ...work, [key]: value } : work,
      ),
    }));
    markDirty();
  }
  return (
    <article className="panel academic-card" style={{ marginBottom: 16 }}>
      <div className="academic-card-top">
        <div className="academic-actions">
          <div className="academic-card-icon">
            <FileText size={21} />
          </div>
          <div>
            <h3>{current.title}</h3>
            <p className="muted" style={{ fontSize: 12, marginTop: 5 }}>
              {current.course_title} · {formatBytes(current.size)}
            </p>
          </div>
        </div>
        <div className="academic-actions">
          <span className="badge">
            {statuses[current.status] || current.status}
          </span>
          {admin && (
            <DeleteButton
              disabled={busy}
              title="Удалить силабус?"
              description="Документ будет удалён. Уже опубликованные недели и работы останутся в дисциплине."
              endpoint={`/syllabi/${document.id}`}
              onDeleted={onChanged}
            />
          )}
        </div>
      </div>
      <button
        type="button"
        className="academic-card-link"
        style={{
          width: "100%",
          background: "none",
          borderRight: 0,
          borderLeft: 0,
          borderBottom: 0,
          cursor: "pointer",
        }}
        onClick={toggle}
      >
        {open ? "Свернуть" : "Открыть документ"}
        <ChevronDown
          size={16}
          style={{ transform: open ? "rotate(180deg)" : undefined }}
        />
      </button>
      {open && (
        <div className="academic-stack">
          <ErrorNotice message={error} />
          {success && (
            <p className="academic-success" role="status">
              {success}
            </p>
          )}
          {busy && <Loading />}
          {detail && (
            <>
              <div className="academic-actions">
                {["published", "review"].includes(current.status) &&
                  current.group_id && (
                    <Link
                      className={
                        current.status === "published"
                          ? "btn btn-primary"
                          : "btn btn-secondary"
                      }
                      href={`/dashboard/groups/${current.group_id}/courses/${current.course_id}`}
                    >
                      {current.status === "published"
                        ? "Открыть учебный план"
                        : "Сравнить с действующим планом"}
                    </Link>
                  )}
                {(admin || !current.source_restricted) && (
                  <a
                    className="btn btn-secondary"
                    href={`${API_URL}/syllabi/${document.id}/download`}
                    download
                  >
                    <Download size={15} /> Скачать оригинал
                  </a>
                )}
                {admin && current.status === "published" && (
                  <RecordEditor
                    title="Изменить описание"
                    fields={[
                      {
                        name: "title",
                        label: "Название документа",
                        required: true,
                      },
                      {
                        name: "summary",
                        label: "Описание программы",
                        type: "textarea",
                      },
                    ]}
                    initial={{ title: current.title, summary: current.summary }}
                    endpoint={`/syllabi/${document.id}`}
                    method="PUT"
                    onSaved={async () => {
                      await load();
                      await onChanged();
                    }}
                  />
                )}
                {admin && current.status !== "published" && (
                  <>
                    <button
                      className="btn btn-primary"
                      disabled={
                        busy ||
                        importing ||
                        (current.status === "needs_ocr" && !requiresOcr) ||
                        dirty
                      }
                      onClick={analyze}
                    >
                      <Sparkles size={15} />
                      {importing
                        ? requiresOcr
                          ? "Распознавание и импорт выполняются"
                          : "Автоматический импорт выполняется"
                        : requiresOcr
                          ? "Распознать и импортировать"
                          : "Повторить автоматический импорт"}
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={busy || importing}
                      onClick={() => setEditing(!editing)}
                    >
                      {editing ? "Предпросмотр" : "Редактировать программу"}
                    </button>
                  </>
                )}
              </div>
              {importing && (
                <p className="academic-success" role="status">
                  {requiresOcr
                    ? "Распознаём страницы PDF и готовим учебные недели и работы. Задача сохранена в базе и продолжится после перезапуска сервера."
                    : "ИИ читает документ и готовит учебные недели и работы. Задача сохранена в базе и продолжится после перезапуска сервера."}
                </p>
              )}
              {warnings.map((warning, index) => (
                <p className="academic-error" key={index}>
                  {warning}
                </p>
              ))}
              {factItems.length > 0 && (
                <section
                  className="academic-feedback"
                  aria-label="Сведения из силабуса"
                >
                  <strong>Сведения из силабуса</strong>
                  <dl
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(140px, 1fr))",
                      gap: 16,
                      marginTop: 14,
                    }}
                  >
                    {factItems.map((item) => (
                      <div key={item.label} style={{ minWidth: 0 }}>
                        <dt
                          className="muted"
                          style={{ fontSize: 12, marginBottom: 5 }}
                        >
                          {item.label}
                        </dt>
                        <dd style={{ fontSize: 14, overflowWrap: "anywhere" }}>
                          {item.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
              {admin && current.extracted_text && (
                <details>
                  <summary
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      marginBottom: 12,
                    }}
                  >
                    Исходный текст документа
                  </summary>
                  <div className="academic-syllabus-text">
                    {current.extracted_text}
                  </div>
                </details>
              )}
              {editing && admin && current.status !== "published" ? (
                <form onSubmit={save} className="academic-stack">
                  <label className="academic-field">
                    <span>Название документа</span>
                    <input
                      className="field"
                      required
                      maxLength={200}
                      value={title}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        markDirty();
                      }}
                    />
                  </label>
                  <label className="academic-field">
                    <span>Цели, результаты и правила оценивания</span>
                    <textarea
                      className="field"
                      rows={5}
                      maxLength={20000}
                      value={draft.summary}
                      onChange={(e) => {
                        setDraft({ ...draft, summary: e.target.value });
                        markDirty();
                      }}
                    />
                  </label>
                  <div
                    className="academic-section-heading"
                    style={{ marginBottom: 0 }}
                  >
                    <h3>Учебные недели · {draft.weeks.length}</h3>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={draft.weeks.length >= 52}
                      onClick={() => {
                        setDraft({
                          ...draft,
                          weeks: [
                            ...draft.weeks,
                            {
                              ...blankWeek,
                              week_number: Math.min(
                                52,
                                Math.max(
                                  0,
                                  ...draft.weeks.map(
                                    (week) => week.week_number,
                                  ),
                                ) + 1,
                              ),
                            },
                          ],
                        });
                        markDirty();
                      }}
                    >
                      <Plus size={15} /> Неделя
                    </button>
                  </div>
                  {draft.weeks.map((week, index) => (
                    <details
                      className="panel academic-week"
                      key={index}
                      open={!week.title}
                    >
                      <summary>
                        <span className="academic-week-number">
                          {week.week_number || "—"}
                        </span>
                        <div>
                          <h3>{week.title || "Новая тема"}</h3>
                          <p>{week.module || "Учебная неделя"}</p>
                        </div>
                        <ChevronDown size={16} />
                      </summary>
                      <div className="academic-week-content">
                        <DraftFields
                          fields={weekFields}
                          value={{ ...week }}
                          change={(key, value) => updateWeek(index, key, value)}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            setDraft({
                              ...draft,
                              weeks: draft.weeks.filter((_, i) => i !== index),
                            });
                            markDirty();
                          }}
                        >
                          <Trash2 size={14} /> Удалить из черновика
                        </button>
                      </div>
                    </details>
                  ))}
                  <div
                    className="academic-section-heading"
                    style={{ marginBottom: 0 }}
                  >
                    <h3>Работы · {draft.works.length}</h3>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={draft.works.length >= 200}
                      onClick={() => {
                        setDraft({
                          ...draft,
                          works: [...draft.works, { ...blankWork }],
                        });
                        markDirty();
                      }}
                    >
                      <Plus size={15} /> Работа
                    </button>
                  </div>
                  {draft.works.map((work, index) => (
                    <details
                      className="panel academic-week"
                      key={index}
                      open={!work.title}
                    >
                      <summary>
                        <div>
                          <h3>{work.title || "Новая работа"}</h3>
                          <p>{work.max_score} баллов</p>
                        </div>
                        <ChevronDown size={16} />
                      </summary>
                      <div className="academic-week-content">
                        <DraftFields
                          fields={workFields.filter(
                            (field) => field.name !== "due_date",
                          )}
                          value={{ ...work }}
                          change={(key, value) => updateWork(index, key, value)}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            setDraft({
                              ...draft,
                              works: draft.works.filter((_, i) => i !== index),
                            });
                            markDirty();
                          }}
                        >
                          <Trash2 size={14} /> Удалить из черновика
                        </button>
                      </div>
                    </details>
                  ))}
                  <div className="academic-actions">
                    <button className="btn btn-primary" disabled={busy}>
                      <Save size={15} />
                      {busy ? "Сохраняем…" : "Сохранить черновик"}
                    </button>
                    {dirty && (
                      <small className="muted">
                        Есть несохранённые изменения
                      </small>
                    )}
                  </div>
                </form>
              ) : (
                <>
                  <DetailBlock label="О программе">
                    {current.status === "published"
                      ? current.summary
                      : draft.summary || current.summary}
                  </DetailBlock>
                  {visibleWeeks.map((week, index) => (
                    <details className="panel academic-week" key={index}>
                      <summary>
                        <span className="academic-week-number">
                          {week.week_number || "—"}
                        </span>
                        <div>
                          <h3>{week.title}</h3>
                          <p>
                            {week.module}
                            {week.hours ? ` · ${week.hours} ч.` : ""}
                          </p>
                        </div>
                        <ChevronDown size={16} />
                      </summary>
                      <div className="academic-week-content">
                        <DetailBlock label="Содержание">
                          {week.content}
                        </DetailBlock>
                        <DetailBlock label="Задания">{week.tasks}</DetailBlock>
                        <DetailBlock label="Оценивание">
                          {week.assessment}
                        </DetailBlock>
                        <DetailBlock label="Материалы">
                          {week.resources}
                        </DetailBlock>
                      </div>
                    </details>
                  ))}
                  {draft.works.map((work, index) => (
                    <div key={index} className="academic-feedback">
                      <strong>
                        {work.title} · {work.max_score} баллов
                      </strong>
                      <div className="academic-prose">{work.description}</div>
                    </div>
                  ))}
                  {admin &&
                    current.status !== "published" &&
                    (draft.weeks.length > 0 || draft.works.length > 0) && (
                      <button
                        className="btn btn-primary"
                        style={{ justifySelf: "start" }}
                        disabled={busy || dirty || importing}
                        onClick={() => setPublish(true)}
                      >
                        <Check size={16} /> Опубликовать программу
                      </button>
                    )}
                  {admin && dirty && (
                    <p className="muted" style={{ fontSize: 12 }}>
                      Сохраните изменения в редакторе перед публикацией.
                    </p>
                  )}
                  {!draft.weeks.length &&
                    !draft.works.length &&
                    current.status !== "published" && (
                      <p
                        className="muted"
                        style={{ fontSize: 13, lineHeight: 1.7 }}
                      >
                        {importing
                          ? "Учебные недели и задания появятся здесь после автоматического импорта."
                          : requiresOcr
                            ? "Этот PDF содержит сканы. Нажмите «Распознать и импортировать», чтобы извлечь текст и подготовить программу."
                            : "Повторите автоматический импорт или добавьте программу вручную. Если план дисциплины уже заполнен, сравните черновик с существующей программой перед публикацией."}
                      </p>
                    )}
                </>
              )}
            </>
          )}
        </div>
      )}
      {publish && (
        <Modal
          title="Опубликовать учебную программу?"
          close={() => setPublish(false)}
          busy={busy}
        >
          <p className="muted" style={{ lineHeight: 1.8, fontSize: 14 }}>
            В дисциплину «{current.course_title}» будут добавлены недели (
            {draft.weeks.length}) и работы ({draft.works.length}). Они станут
            доступны студентам. Убедитесь, что темы, задания и критерии
            соответствуют оригиналу силабуса.
          </p>
          <div className="academic-form-actions">
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setPublish(false)}
            >
              Вернуться к проверке
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={publishDraft}
            >
              {busy ? "Публикуем…" : "Подтвердить публикацию"}
            </button>
          </div>
        </Modal>
      )}
    </article>
  );
}
