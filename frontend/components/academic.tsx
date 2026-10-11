"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import PasswordInput from "./password-input";
import "./academic.css";

export const weekdays = [
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
  "Воскресенье",
];
export const errorMessage = (e: unknown) =>
  e instanceof Error
    ? e.message
    : "Не удалось выполнить действие. Попробуйте ещё раз.";
export function localDateTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const currentPath = useRef(path);
  const reload = useCallback(async () => {
    if (currentPath.current !== path) return;
    if (!path) {
      setLoading(false);
      return;
    }
    setError("");
    try {
      const result = await api<T>(path);
      if (currentPath.current !== path) return;
      setData(result);
    } catch (e) {
      if (currentPath.current !== path) return;
      setData(null);
      setError(errorMessage(e));
    } finally {
      if (currentPath.current === path) {
        setResolvedPath(path);
        setLoading(false);
      }
    }
  }, [path]);
  useEffect(() => {
    currentPath.current = path;
    let active = true;
    if (!path) return;
    api<T>(path)
      .then((value) => {
        if (active) {
          setData(value);
          setError("");
          setResolvedPath(path);
        }
      })
      .catch((e) => {
        if (active) {
          setData(null);
          setError(errorMessage(e));
          setResolvedPath(path);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path]);
  return {
    data: resolvedPath === path ? data : null,
    error: resolvedPath === path ? error : "",
    loading: path !== null && (loading || resolvedPath !== path),
    reload,
    setData,
  };
}
export function PageTitle({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="academic-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 className="page-heading">{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {children && <div className="academic-actions">{children}</div>}
    </header>
  );
}
export function ErrorNotice({ message }: { message: string }) {
  return message ? (
    <div className="alert academic-error" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div className="academic-loading" role="status">
      <LoaderCircle className="academic-spin" size={22} /> Загружаем данные…
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}
export function Modal({
  title,
  children,
  close,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="academic-modal"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="academic-modal-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="academic-icon-button"
          disabled={busy}
          aria-label="Закрыть"
          onClick={close}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export type FieldDefinition = {
  name: string;
  label: string;
  type?:
    | "text"
    | "textarea"
    | "number"
    | "email"
    | "password"
    | "select"
    | "time"
    | "times"
    | "datetime-local"
    | "checkbox";
  required?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  options?: { value: string | number; label: string }[];
  hint?: string;
  nullable?: boolean;
  omitWhenEmpty?: boolean;
};
export function RecordEditor({
  title,
  fields,
  initial = {},
  endpoint,
  method = "POST",
  onSaved,
  label,
  compact = false,
  disabled = false,
}: {
  title: string;
  fields: FieldDefinition[];
  initial?: Record<string, unknown>;
  endpoint: string;
  method?: string;
  onSaved: () => void | Promise<void>;
  label?: string;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {};
    for (const field of fields) {
      const value = form.get(field.name);
      if (field.type === "times") {
        const times = String(value ?? "")
          .split(/[\s,;/]+/)
          .filter(Boolean);
        if (
          !times.length ||
          times.length > 12 ||
          times.some((time) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
        ) {
          setError(
            "Укажите от 1 до 12 начал занятий в формате ЧЧ:ММ, разделяя их символом /.",
          );
          return;
        }
        body[field.name] = [...new Set(times)].sort();
        body.start_time = (body[field.name] as string[])[0];
        continue;
      }
      if (value === "" && field.omitWhenEmpty) continue;
      if (
        field.type === "datetime-local" &&
        typeof value === "string" &&
        value
      ) {
        body[field.name] = new Date(value).toISOString();
        continue;
      }
      body[field.name] =
        field.type === "checkbox"
          ? value === "on"
          : value === "" && field.nullable
            ? null
            : field.type === "number" ||
                (field.type === "select" &&
                  field.options?.some((x) => typeof x.value === "number"))
              ? value === ""
                ? null
                : Number(value)
              : value;
    }
    setBusy(true);
    setError("");
    try {
      await api(endpoint, { method, body: JSON.stringify(body) });
      await onSaved();
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className={
          compact
            ? "academic-icon-button"
            : `btn ${method === "POST" ? "btn-primary" : "btn-secondary"}`
        }
        title={title}
        aria-label={title}
        disabled={disabled}
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        {method === "POST" ? <Plus size={17} /> : <Pencil size={16} />}{" "}
        {!compact && (label || title)}
      </button>
      {open && (
        <Modal title={title} close={() => setOpen(false)} busy={busy}>
          <form onSubmit={submit}>
            <div className="academic-fields">
              {fields.map((field) => (
                <label className="academic-field" key={field.name}>
                  <span>
                    {field.label}
                    {field.required && <span aria-hidden="true"> *</span>}
                  </span>
                  {field.type === "textarea" ? (
                    <textarea
                      name={field.name}
                      className="field"
                      rows={4}
                      required={field.required}
                      defaultValue={String(initial[field.name] ?? "")}
                      placeholder={field.placeholder}
                    />
                  ) : field.type === "select" ? (
                    <select
                      name={field.name}
                      className="field"
                      required={field.required}
                      defaultValue={String(
                        initial[field.name] ?? field.options?.[0]?.value ?? "",
                      )}
                    >
                      {field.options?.map((option) => (
                        <option value={option.value} key={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : field.type === "checkbox" ? (
                    <input
                      type="checkbox"
                      name={field.name}
                      defaultChecked={Boolean(initial[field.name])}
                    />
                  ) : field.type === "password" ? (
                    <PasswordInput
                      name={field.name}
                      className="field"
                      required={field.required}
                      minLength={10}
                      maxLength={128}
                      defaultValue={String(initial[field.name] ?? "")}
                      placeholder={field.placeholder}
                      autoComplete="new-password"
                    />
                  ) : (
                    <input
                      name={field.name}
                      className="field"
                      type={
                        field.type === "times" ? "text" : field.type || "text"
                      }
                      required={field.required}
                      min={field.min}
                      max={field.max}
                      maxLength={500}
                      defaultValue={
                        field.type === "times" &&
                        Array.isArray(initial[field.name])
                          ? (initial[field.name] as string[]).join(" / ")
                          : String(initial[field.name] ?? "")
                      }
                      placeholder={field.placeholder}
                    />
                  )}{" "}
                  {field.hint && <small className="muted">{field.hint}</small>}
                </label>
              ))}
            </div>
            <ErrorNotice message={error} />
            <div className="academic-form-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Отмена
              </button>
              <button className="btn btn-primary" disabled={busy}>
                {busy ? "Сохраняем…" : "Сохранить"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export function DeleteButton({
  endpoint,
  title,
  description,
  onDeleted,
  disabled = false,
}: {
  endpoint: string;
  title: string;
  description?: string;
  onDeleted: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    setBusy(true);
    try {
      await api(endpoint, { method: "DELETE" });
      await onDeleted();
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="academic-icon-button academic-danger"
        disabled={disabled}
        type="button"
        title={title}
        aria-label={title}
        onClick={() => {
          setOpen(true);
          setError("");
        }}
      >
        <Trash2 size={16} />
      </button>
      {open && (
        <Modal title={title} close={() => setOpen(false)} busy={busy}>
          <p className="muted">
            {description || "Это действие нельзя отменить. Продолжить?"}
          </p>
          <ErrorNotice message={error} />
          <div className="academic-form-actions">
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Отмена
            </button>
            <button
              className="btn academic-delete-button"
              disabled={busy}
              onClick={remove}
            >
              {busy ? "Удаляем…" : "Удалить"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function DetailBlock({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}) {
  return children ? (
    <div className="academic-detail">
      <h4>{label}</h4>
      <div className="academic-prose">{children}</div>
    </div>
  ) : null;
}
export const courseFields: FieldDefinition[] = [
  { name: "title", label: "Название дисциплины", required: true },
  { name: "teacher", label: "Преподаватель" },
  { name: "description", label: "Описание", type: "textarea" },
  { name: "credits", label: "Кредиты", type: "number", min: 0, max: 60 },
];
export const groupFields: FieldDefinition[] = [
  {
    name: "name",
    label: "Название группы",
    required: true,
    placeholder: "ИП-26-3кс",
  },
  { name: "academic_year", label: "Учебный год", placeholder: "2026–2027" },
  { name: "program", label: "Образовательная программа" },
  {
    name: "study_year",
    label: "Курс обучения",
    type: "number",
    min: 1,
    max: 8,
    nullable: true,
    hint: "Оставьте пустым, если курс не подтверждён источником.",
  },
  {
    name: "semester",
    label: "Семестр",
    type: "number",
    min: 1,
    max: 16,
    nullable: true,
  },
  { name: "curator", label: "Куратор" },
  { name: "description", label: "О группе", type: "textarea" },
];
export const weekFields: FieldDefinition[] = [
  {
    name: "week_number",
    label: "Номер недели",
    type: "number",
    required: true,
    min: 1,
    max: 52,
  },
  { name: "title", label: "Тема недели", required: true },
  { name: "module", label: "Модуль" },
  { name: "hours", label: "Учебные часы", type: "number", min: 0, max: 200 },
  { name: "content", label: "Содержание занятий", type: "textarea" },
  { name: "tasks", label: "Что нужно сделать", type: "textarea" },
  { name: "assessment", label: "Критерии оценивания", type: "textarea" },
  { name: "resources", label: "Материалы и литература", type: "textarea" },
];
export const workFields: FieldDefinition[] = [
  { name: "title", label: "Название работы", required: true },
  {
    name: "kind",
    label: "Тип работы",
    type: "select",
    options: [
      { value: "assignment", label: "Задание" },
      { value: "module", label: "Модульная работа" },
      { value: "exam", label: "Экзамен" },
      { value: "practice", label: "Практика" },
    ],
  },
  { name: "module", label: "Модуль" },
  {
    name: "week_number",
    label: "Неделя",
    type: "number",
    min: 1,
    max: 52,
    nullable: true,
  },
  {
    name: "due_date",
    label: "Срок сдачи",
    type: "datetime-local",
    nullable: true,
  },
  {
    name: "max_score",
    label: "Максимальный балл",
    type: "number",
    min: 1,
    max: 1000,
    required: true,
  },
  {
    name: "description",
    label: "Задание и требования",
    type: "textarea",
    required: true,
  },
];
