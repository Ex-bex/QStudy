"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Compass,
  Plus,
  Pencil,
  X,
  RefreshCw,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import {
  DeleteButton,
  Empty,
  ErrorNotice,
  Loading,
  Modal,
  RecordEditor,
  errorMessage,
  localDateTime,
  useResource,
  type FieldDefinition,
} from "@/components/academic";
import { LogoUpload } from "@/components/logo-upload";
import styles from "./admin.module.css";

function notifyCareerChanged() {
  window.dispatchEvent(new Event("qcareer:updated"));
  try {
    localStorage.setItem("qcareer:updated", String(Date.now()));
  } catch {}
}

type List<T> = { items: T[] };
type Config = {
  enabled: boolean;
  title: string;
  description: string;
  announcement: string;
  logo_url: string;
  logo_custom?: boolean;
};
type Skill = {
  id: number;
  slug: string;
  name: string;
  description: string;
  category: string;
  is_active: boolean;
};
type Requirement = { skill_id: number; level: number; skill_name?: string };
type Direction = {
  id: number;
  slug: string;
  title: string;
  description: string;
  category: string;
  study_paths: string[];
  career_paths: string[];
  is_active: boolean;
  requirements: Requirement[];
};
type LearningLink = {
  id: number;
  skill_id: number;
  skill_name: string;
  course_id: number;
  course_title: string;
  group_name: string;
  module: string;
  week_number: number | null;
  work_id: number | null;
  syllabus_id: number | null;
  title: string;
  description: string;
  target_level: number;
  min_score: number;
  prerequisites: Requirement[];
  is_active: boolean;
  href: string | null;
  test_href: string;
  source_available?: boolean;
};
type Opportunity = {
  id: number;
  title: string;
  organization: string;
  description: string;
  kind: string;
  url: string;
  location: string;
  direction_id: number | null;
  direction_title?: string;
  published_at: string | null;
  expires_at: string | null;
  is_active: boolean;
};
type LearningSuggestion = {
  course_id: number;
  course_title: string;
  group_name: string;
  skill_id: number;
  skill_name: string;
  title: string;
  target_level: number;
  min_score: number;
  reason: string;
};
type CourseSource = {
  id: number;
  title: string;
  group_id: number;
  group_name: string;
  modules: string[];
  weeks: {
    id: number;
    week_number: number;
    title: string;
    module: string;
    source_syllabus_id: number | null;
  }[];
  works: {
    id: number;
    title: string;
    module: string;
    week_number: number | null;
    source_syllabus_id: number | null;
  }[];
  syllabi: { id: number; title: string }[];
};
type Student = {
  id: number;
  name: string;
  email: string;
  group_id: number | null;
  group_name: string | null;
  target_direction_title: string | null;
  demonstrated_skills: number;
  evidence_count: number;
  readiness: number | null;
};
type Overview = {
  students_count: number;
  active_skills: number;
  active_directions: number;
  active_links: number;
  active_opportunities: number;
  groups: {
    id: number;
    name: string;
    students_count: number;
    demonstrated_skills: number;
    evidence_count: number;
  }[];
};
type StudentDetail = {
  profile: {
    user_id: number;
    name: string;
    group_name: string | null;
    interests: string[];
    about: string;
  };
  summary: {
    demonstrated_skills: number;
    evidence_count: number;
    readiness: number | null;
    target_direction_title: string | null;
  };
  activity: {
    completed_weeks: number;
    finished_tests: number;
    graded_works: number;
  };
  skills: (Skill & {
    level: number;
    evidence: {
      kind: string;
      title: string;
      score: number;
      level: number;
      href: string;
      verified_at: string;
    }[];
  })[];
  recommendations: {
    reason: string;
    steps: {
      id: number;
      title: string;
      skill_name: string;
      from_level: number;
      to_level: number;
      href: string;
      reason: string;
    }[];
  };
  disclaimer: string;
};
type Tab =
  | "overview"
  | "skills"
  | "directions"
  | "links"
  | "opportunities"
  | "students"
  | "settings";
const kindLabels: Record<string, string> = {
  job: "Работа",
  internship: "Стажировка",
  study: "Продолжение учёбы",
  course: "Курс",
};
const date = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("ru-RU") : "Без срока";
const lines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
const optionalId = (value: string) => (value ? Number(value) : null);
const activeBadge = (active: boolean) => (
  <span className={`${styles.badge} ${active ? "" : styles.inactive}`}>
    {active ? "Опубликовано" : "Скрыто"}
  </span>
);

function RequirementFields({
  value,
  onChange,
  skills,
  title,
  hint,
}: {
  value: Requirement[];
  onChange: (value: Requirement[]) => void;
  skills: Skill[];
  title: string;
  hint: string;
}) {
  const available = skills.filter(
    (skill) =>
      skill.is_active && !value.some((row) => row.skill_id === skill.id),
  );
  return (
    <div className={styles.requirementsEditor}>
      <h3>{title}</h3>
      <p>{hint}</p>
      {value.map((row, index) => (
        <div className={styles.requirementRow} key={index}>
          <select
            className="field"
            aria-label={`${title}: навык ${index + 1}`}
            value={row.skill_id}
            onChange={(event) =>
              onChange(
                value.map((entry, at) =>
                  at === index
                    ? { ...entry, skill_id: Number(event.target.value) }
                    : entry,
                ),
              )
            }
            required
          >
            {skills
              .filter(
                (skill) =>
                  skill.id === row.skill_id ||
                  (skill.is_active &&
                    !value.some((entry) => entry.skill_id === skill.id)),
              )
              .map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.name}
                  {skill.is_active ? "" : " · скрыт"}
                </option>
              ))}
          </select>
          <select
            className="field"
            aria-label={`${title}: уровень ${index + 1}`}
            value={row.level}
            onChange={(event) =>
              onChange(
                value.map((entry, at) =>
                  at === index
                    ? { ...entry, level: Number(event.target.value) }
                    : entry,
                ),
              )
            }
          >
            {[1, 2, 3, 4, 5].map((level) => (
              <option key={level} value={level}>
                {level} из 5
              </option>
            ))}
          </select>
          <button
            type="button"
            className="academic-icon-button academic-danger"
            aria-label={`Убрать навык ${index + 1}`}
            onClick={() => onChange(value.filter((_, at) => at !== index))}
          >
            <X size={15} />
          </button>
        </div>
      ))}
      {!value.length && <p>Требования пока не заданы.</p>}
      <button
        type="button"
        className="btn btn-secondary"
        disabled={!available.length}
        onClick={() =>
          available[0] &&
          onChange([...value, { skill_id: available[0].id, level: 1 }])
        }
      >
        <Plus size={15} /> Добавить навык
      </button>
    </div>
  );
}

function DirectionEditor({
  initial,
  skills,
  onSaved,
}: {
  initial?: Direction;
  skills: Skill[];
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(`/admin/career/directions${initial ? `/${initial.id}` : ""}`, {
        method: initial ? "PATCH" : "POST",
        body: JSON.stringify({
          slug: form.get("slug"),
          title: form.get("title"),
          category: form.get("category"),
          description: form.get("description"),
          study_paths: lines(String(form.get("study_paths") || "")),
          career_paths: lines(String(form.get("career_paths") || "")),
          is_active: form.get("is_active") === "on",
          requirements: requirements.map(({ skill_id, level }) => ({
            skill_id,
            level,
          })),
        }),
      });
      await onSaved();
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className={initial ? "academic-icon-button" : "btn btn-primary"}
        type="button"
        aria-label={
          initial
            ? `Редактировать направление ${initial.title}`
            : "Создать направление"
        }
        title={initial ? "Редактировать направление" : undefined}
        onClick={() => {
          setRequirements(
            initial?.requirements.map(({ skill_id, level }) => ({
              skill_id,
              level,
            })) || [],
          );
          setError("");
          setOpen(true);
        }}
      >
        {initial ? (
          <Pencil size={16} />
        ) : (
          <>
            <Plus size={17} /> Создать направление
          </>
        )}
      </button>
      {open && (
        <Modal
          title={initial ? "Редактировать направление" : "Новое направление"}
          close={() => setOpen(false)}
          busy={busy}
        >
          <form onSubmit={submit}>
            <div className={styles.fields}>
              <label className="academic-field">
                <span>Название *</span>
                <input
                  className="field"
                  name="title"
                  required
                  maxLength={160}
                  defaultValue={initial?.title || ""}
                  placeholder="Например, разработка программного обеспечения"
                />
              </label>
              <label className="academic-field">
                <span>Код направления *</span>
                <input
                  className="field"
                  name="slug"
                  required
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  maxLength={100}
                  defaultValue={initial?.slug || ""}
                  placeholder="software-development"
                />
                <small className="muted">
                  Латинские строчные буквы, цифры и дефис.
                </small>
              </label>
              <label className={`academic-field ${styles.full}`}>
                <span>Область</span>
                <input
                  className="field"
                  name="category"
                  maxLength={120}
                  defaultValue={initial?.category || ""}
                  placeholder="Информационные технологии"
                />
              </label>
              <label className={`academic-field ${styles.full}`}>
                <span>Описание</span>
                <textarea
                  className="field"
                  rows={4}
                  name="description"
                  maxLength={6000}
                  defaultValue={initial?.description || ""}
                />
              </label>
              <label className="academic-field">
                <span>Куда продолжить учиться</span>
                <textarea
                  className="field"
                  rows={4}
                  name="study_paths"
                  maxLength={10000}
                  defaultValue={initial?.study_paths.join("\n") || ""}
                />
                <small className="muted">Один вариант на строку.</small>
              </label>
              <label className="academic-field">
                <span>Кем и где работать</span>
                <textarea
                  className="field"
                  rows={4}
                  name="career_paths"
                  maxLength={10000}
                  defaultValue={initial?.career_paths.join("\n") || ""}
                />
                <small className="muted">
                  Одна профессия или область на строку.
                </small>
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  name="is_active"
                  defaultChecked={initial?.is_active ?? true}
                />{" "}
                Показывать студентам
              </label>
            </div>
            <RequirementFields
              value={requirements}
              onChange={setRequirements}
              skills={skills}
              title="Требования направления"
              hint="Покрытие этих навыков рассчитывается по проверенным результатам обучения студента. Это ориентир, а не гарантия трудоустройства."
            />
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

function LearningLinkEditor({
  initial,
  skills,
  courses,
  onSaved,
}: {
  initial?: LearningLink;
  skills: Skill[];
  courses: CourseSource[];
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [courseId, setCourseId] = useState("");
  const [module, setModule] = useState("");
  const [week, setWeek] = useState("");
  const [work, setWork] = useState("");
  const [syllabus, setSyllabus] = useState("");
  const [prerequisites, setPrerequisites] = useState<Requirement[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const course = courses.find((entry) => entry.id === Number(courseId));
  const weeks =
    course?.weeks.filter(
      (entry) =>
        (!module || entry.module === module) &&
        (!syllabus || entry.source_syllabus_id === Number(syllabus)),
    ) || [];
  const works =
    course?.works.filter(
      (entry) =>
        (!module || entry.module === module) &&
        (!week || entry.week_number === Number(week)) &&
        (!syllabus || entry.source_syllabus_id === Number(syllabus)),
    ) || [];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(
        `/admin/career/learning-links${initial ? `/${initial.id}` : ""}`,
        {
          method: initial ? "PATCH" : "POST",
          body: JSON.stringify({
            skill_id: Number(form.get("skill_id")),
            course_id: Number(courseId),
            module,
            week_number: optionalId(week),
            work_id: optionalId(work),
            syllabus_id: optionalId(syllabus),
            title: form.get("title"),
            description: form.get("description"),
            target_level: Number(form.get("target_level")),
            min_score: Number(form.get("min_score")),
            prerequisites: prerequisites.map(({ skill_id, level }) => ({
              skill_id,
              level,
            })),
            is_active: form.get("is_active") === "on",
          }),
        },
      );
      await onSaved();
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className={initial ? "academic-icon-button" : "btn btn-primary"}
        type="button"
        disabled={!courses.length || !skills.length}
        aria-label={
          initial
            ? `Редактировать связь ${initial.title || initial.skill_name}`
            : "Связать обучение с навыком"
        }
        title={initial ? "Редактировать связь" : undefined}
        onClick={() => {
          setCourseId(
            initial ? String(initial.course_id) : String(courses[0]?.id || ""),
          );
          setModule(initial?.module || "");
          setWeek(initial?.week_number ? String(initial.week_number) : "");
          setWork(initial?.work_id ? String(initial.work_id) : "");
          setSyllabus(initial?.syllabus_id ? String(initial.syllabus_id) : "");
          setPrerequisites(
            initial?.prerequisites.map(({ skill_id, level }) => ({
              skill_id,
              level,
            })) || [],
          );
          setError("");
          setOpen(true);
        }}
      >
        {initial ? (
          <Pencil size={16} />
        ) : (
          <>
            <Plus size={17} /> Добавить связь
          </>
        )}
      </button>
      {open && (
        <Modal
          title={
            initial
              ? "Редактировать связь с обучением"
              : "Связать обучение с навыком"
          }
          close={() => setOpen(false)}
          busy={busy}
        >
          <form onSubmit={submit}>
            <div className={styles.source}>
              <p>
                <strong>Уровень начисляется после проверки.</strong> Сервер
                учитывает завершённые тесты по учебной программе и оценённые
                администратором работы. Выбранные ограничения по силабусу,
                модулю, неделе и работе действуют одновременно.
              </p>
            </div>
            <div className={styles.fields}>
              <label className={`academic-field ${styles.full}`}>
                <span>Дисциплина и группа *</span>
                <select
                  className="field"
                  value={courseId}
                  required
                  onChange={(event) => {
                    setCourseId(event.target.value);
                    setModule("");
                    setWeek("");
                    setWork("");
                    setSyllabus("");
                  }}
                >
                  {courses.map((entry) => (
                    <option value={entry.id} key={entry.id}>
                      {entry.group_name} · {entry.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="academic-field">
                <span>Силабус</span>
                <select
                  className="field"
                  value={syllabus}
                  onChange={(event) => {
                    setSyllabus(event.target.value);
                    setWeek("");
                    setWork("");
                  }}
                >
                  <option value="">Все опубликованные источники</option>
                  {syllabus &&
                    !course?.syllabi.some(
                      (entry) => entry.id === Number(syllabus),
                    ) && (
                      <option value={syllabus} disabled>
                        Силабус #{syllabus} недоступен
                      </option>
                    )}
                  {course?.syllabi.map((entry) => (
                    <option value={entry.id} key={entry.id}>
                      {entry.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="academic-field">
                <span>Модуль</span>
                <select
                  className="field"
                  value={module}
                  onChange={(event) => {
                    setModule(event.target.value);
                    setWeek("");
                    setWork("");
                  }}
                >
                  <option value="">Вся дисциплина</option>
                  {module && !course?.modules.includes(module) && (
                    <option value={module} disabled>
                      {module} · недоступен
                    </option>
                  )}
                  {course?.modules.map((entry) => (
                    <option value={entry} key={entry}>
                      {entry}
                    </option>
                  ))}
                </select>
              </label>
              <label className="academic-field">
                <span>Неделя</span>
                <select
                  className="field"
                  value={week}
                  onChange={(event) => {
                    setWeek(event.target.value);
                    setWork("");
                  }}
                >
                  <option value="">Любая неделя</option>
                  {week &&
                    !weeks.some(
                      (entry) => entry.week_number === Number(week),
                    ) && (
                      <option value={week} disabled>
                        Неделя {week} недоступна
                      </option>
                    )}
                  {weeks.map((entry) => (
                    <option value={entry.week_number} key={entry.id}>
                      {entry.week_number}. {entry.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="academic-field">
                <span>Учебная работа</span>
                <select
                  className="field"
                  value={work}
                  onChange={(event) => setWork(event.target.value)}
                >
                  <option value="">Тесты и работы по указанной теме</option>
                  {work &&
                    !works.some((entry) => entry.id === Number(work)) && (
                      <option value={work} disabled>
                        Работа #{work} недоступна
                      </option>
                    )}
                  {works.map((entry) => (
                    <option value={entry.id} key={entry.id}>
                      {entry.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="academic-field">
                <span>Навык *</span>
                <select
                  className="field"
                  name="skill_id"
                  required
                  defaultValue={initial?.skill_id || skills[0]?.id}
                >
                  {skills.map((skill) => (
                    <option value={skill.id} key={skill.id}>
                      {skill.name}
                      {skill.is_active ? "" : " · скрыт"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="academic-field">
                <span>Подтверждаемый уровень *</span>
                <select
                  className="field"
                  name="target_level"
                  defaultValue={initial?.target_level || 1}
                >
                  {[1, 2, 3, 4, 5].map((level) => (
                    <option value={level} key={level}>
                      {level} из 5
                    </option>
                  ))}
                </select>
              </label>
              <label className="academic-field">
                <span>Минимальный результат, % *</span>
                <input
                  className="field"
                  name="min_score"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  required
                  defaultValue={initial?.min_score ?? 70}
                />
              </label>
              <label className="academic-field">
                <span>Название шага обучения</span>
                <input
                  className="field"
                  name="title"
                  maxLength={200}
                  defaultValue={initial?.title || ""}
                  placeholder="Можно оставить пустым"
                />
              </label>
              <label className={`academic-field ${styles.full}`}>
                <span>Описание шага</span>
                <textarea
                  className="field"
                  name="description"
                  rows={3}
                  maxLength={4000}
                  defaultValue={initial?.description || ""}
                />
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  name="is_active"
                  defaultChecked={initial?.is_active ?? true}
                />{" "}
                Связь активна
              </label>
            </div>
            <RequirementFields
              value={prerequisites}
              onChange={setPrerequisites}
              skills={skills}
              title="Предварительные навыки"
              hint="Шаг попадёт в рекомендацию, когда эти требования уже выполнены или освоены на предыдущем шаге плана."
            />
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

function LearningSuggestions({
  onSaved,
}: {
  onSaved: (created: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState<LearningSuggestion[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const grouped = new Map<number, LearningSuggestion[]>();
  for (const item of items)
    grouped.set(item.course_id, [...(grouped.get(item.course_id) || []), item]);
  async function load() {
    setOpen(true);
    setBusy(true);
    setError("");
    setItems([]);
    setSelected([]);
    try {
      const result = await api<List<LearningSuggestion>>(
        "/admin/career/learning-links/suggest",
        { method: "POST", body: "{}" },
      );
      setItems(result.items);
      setSelected([...new Set(result.items.map((item) => item.course_id))]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ created: number }>(
        "/admin/career/learning-links/apply-suggestions",
        { method: "POST", body: JSON.stringify({ course_ids: selected }) },
      );
      await onSaved(result.created);
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="btn btn-secondary" type="button" onClick={load}>
        <Compass size={16} /> Предложить связи
      </button>
      {open && (
        <Modal
          title="Связи по учебной программе"
          close={() => setOpen(false)}
          busy={busy}
        >
          <p className={styles.hint}>
            Система сопоставила опубликованную программу с каталогом навыков.
            Проверьте предложения и выберите дисциплины. Будут добавлены только
            отсутствующие связи; существующие настройки сохранятся. Добавление
            связи само по себе не начисляет уровень.
          </p>
          <ErrorNotice message={error} />
          {busy && !items.length && <Loading />}
          <div className={styles.cardList}>
            {[...grouped.entries()].map(([courseId, suggestions]) => (
              <article className={styles.card} key={courseId}>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={selected.includes(courseId)}
                    disabled={busy}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, courseId]
                          : selected.filter((id) => id !== courseId),
                      )
                    }
                  />
                  <strong>
                    {suggestions[0].group_name} · {suggestions[0].course_title}
                  </strong>
                </label>
                {suggestions.map((suggestion) => (
                  <div key={suggestion.skill_id}>
                    <p>
                      {suggestion.skill_name} · уровень{" "}
                      {suggestion.target_level} · от {suggestion.min_score}%
                    </p>
                    <p className={styles.hint}>{suggestion.reason}</p>
                  </div>
                ))}
              </article>
            ))}
          </div>
          {!busy && !items.length && !error && (
            <p className={styles.empty}>
              Новых подходящих связей нет. Можно добавить связь вручную или
              дополнить опубликованную учебную программу.
            </p>
          )}
          <div className="academic-form-actions">
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Закрыть
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || !selected.length}
              onClick={apply}
            >
              {busy
                ? "Сохраняем…"
                : `Добавить для дисциплин: ${selected.length}`}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function StudentReview({
  student,
  close,
}: {
  student: Student;
  close: () => void;
}) {
  const { data, loading, error } = useResource<StudentDetail>(
    `/admin/career/students/${student.id}`,
  );
  return (
    <Modal title={student.name || student.email} close={close}>
      <ErrorNotice message={error} />
      {loading && <Loading />}
      {data && (
        <div className={styles.studentDetail}>
          <p>
            {student.email} · {data.profile.group_name || "Без группы"}
          </p>
          <div className={styles.source}>
            <p>
              <strong>
                {data.summary.demonstrated_skills} навыков ·{" "}
                {data.summary.evidence_count} подтверждений.
              </strong>{" "}
              {data.summary.target_direction_title
                ? `Цель: ${data.summary.target_direction_title}.`
                : "Карьерная цель ещё не выбрана."}{" "}
              {data.summary.readiness === null
                ? ""
                : `Покрытие требований: ${Math.round(data.summary.readiness)}%.`}
            </p>
          </div>
          <section>
            <h3>Интересы и планы</h3>
            <p>
              {data.profile.interests.join(", ") || "Интересы пока не указаны."}
            </p>
            {data.profile.about && <p>{data.profile.about}</p>}
          </section>
          <section>
            <h3>Учебная активность</h3>
            <p>
              Отмечено недель: {data.activity.completed_weeks}. Завершено
              тестов: {data.activity.finished_tests}. Оценено работ:{" "}
              {data.activity.graded_works}.
            </p>
          </section>
          <section>
            <h3>Навыки и подтверждения</h3>
            <div className={styles.cardList}>
              {data.skills
                .filter((skill) => skill.level > 0 || skill.evidence.length)
                .map((skill) => (
                  <article className={styles.card} key={skill.id}>
                    <div className={styles.cardHead}>
                      <h3>{skill.name}</h3>
                      <span className={styles.badge}>
                        Уровень {skill.level} / 5
                      </span>
                    </div>
                    <ul className={styles.evidence}>
                      {skill.evidence.map((entry, index) => (
                        <li key={`${entry.kind}-${index}`}>
                          <Link href={entry.href}>{entry.title}</Link> ·{" "}
                          {Math.round(entry.score)}% · уровень {entry.level}
                          <br />
                          {date(entry.verified_at)}
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              {!data.skills.some(
                (skill) => skill.level > 0 || skill.evidence.length,
              ) && (
                <p>Пока нет результатов, подтверждающих настроенные навыки.</p>
              )}
            </div>
          </section>
          <section>
            <h3>Рекомендованный путь</h3>
            <p>{data.recommendations.reason}</p>
            <ol className={styles.evidence}>
              {data.recommendations.steps.map((step) => (
                <li key={step.id}>
                  <Link href={step.href}>{step.title}</Link> · {step.skill_name}
                  : {step.from_level} → {step.to_level}
                  <br />
                  {step.reason}
                </li>
              ))}
            </ol>
          </section>
          <p className={styles.hint}>{data.disclaimer}</p>
          <Link className="btn btn-secondary" href="/qcontrol">
            Управление аккаунтами <ArrowUpRight size={15} />
          </Link>
        </div>
      )}
    </Modal>
  );
}

export default function CareerAdminPanel() {
  const { user } = useAuth();
  const admin = user.role === "admin";
  const [tab, setTab] = useState<Tab>("overview");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [groupId, setGroupId] = useState("");
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const overview = useResource<Overview>(
    admin ? "/admin/career/overview" : null,
  );
  const config = useResource<Config>(admin ? "/admin/career/config" : null);
  const skills = useResource<List<Skill>>(
    admin ? "/admin/career/skills" : null,
  );
  const directions = useResource<List<Direction>>(
    admin ? "/admin/career/directions" : null,
  );
  const links = useResource<List<LearningLink>>(
    admin ? "/admin/career/learning-links" : null,
  );
  const opportunities = useResource<List<Opportunity>>(
    admin ? "/admin/career/opportunities" : null,
  );
  const sources = useResource<{ courses: CourseSource[] }>(
    admin ? "/admin/career/sources" : null,
  );
  const studentQuery = new URLSearchParams({
    search,
    ...(groupId ? { group_id: groupId } : {}),
  });
  const students = useResource<List<Student>>(
    admin && tab === "students"
      ? `/admin/career/students?${studentQuery}`
      : null,
  );
  const allSkills = skills.data?.items || [];
  const allDirections = directions.data?.items || [];
  const allCourses = sources.data?.courses || [];
  async function refresh() {
    await Promise.all([
      overview.reload(),
      config.reload(),
      skills.reload(),
      directions.reload(),
      links.reload(),
      opportunities.reload(),
      sources.reload(),
      students.reload(),
    ]);
  }
  async function saved() {
    await refresh();
    notifyCareerChanged();
    setNotice(
      "Изменения сохранены. Данные студентов пересчитываются по текущим учебным результатам.",
    );
  }
  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/admin/career/config", {
        method: "PATCH",
        body: JSON.stringify({
          title: form.get("title"),
          description: form.get("description"),
          announcement: form.get("announcement"),
          enabled: form.get("enabled") === "on",
        }),
      });
      await config.reload();
      notifyCareerChanged();
      setNotice("Настройки QCareer сохранены.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const skillFields: FieldDefinition[] = [
    { name: "name", label: "Название навыка", required: true, maxLength: 160 },
    {
      name: "slug",
      label: "Код навыка",
      required: true,
      maxLength: 100,
      hint: "Строчные латинские буквы, цифры и дефис, например communication.",
    },
    { name: "category", label: "Категория", maxLength: 120 },
    {
      name: "description",
      label: "Описание",
      type: "textarea",
      maxLength: 4000,
    },
    { name: "is_active", label: "Показывать студентам", type: "checkbox" },
  ];
  const opportunityFields: FieldDefinition[] = [
    { name: "title", label: "Название", required: true, maxLength: 200 },
    { name: "organization", label: "Организация", maxLength: 200 },
    {
      name: "kind",
      label: "Тип возможности",
      type: "select",
      options: Object.entries(kindLabels).map(([value, label]) => ({
        value,
        label,
      })),
    },
    {
      name: "description",
      label: "Описание и условия",
      type: "textarea",
      maxLength: 10000,
    },
    {
      name: "url",
      label: "Ссылка на источник",
      maxLength: 2000,
      hint: "Полный адрес http:// или https://. Без ссылки карточка останется информационной.",
    },
    { name: "location", label: "Город или удалённый формат", maxLength: 200 },
    {
      name: "direction_id",
      label: "Карьерное направление",
      type: "select",
      nullable: true,
      options: [
        { value: "", label: "Для всех направлений" },
        ...allDirections.map((entry) => ({
          value: entry.id,
          label: entry.title,
        })),
      ],
    },
    {
      name: "published_at",
      label: "Начало публикации",
      type: "datetime-local",
      nullable: true,
      hint: "Пустое поле — опубликовать сейчас.",
    },
    {
      name: "expires_at",
      label: "Окончание публикации",
      type: "datetime-local",
      nullable: true,
      hint: "Пустое поле — без срока. Просроченные карточки скрываются от студентов.",
    },
    { name: "is_active", label: "Публикация активна", type: "checkbox" },
  ];
  const activeResource = {
    overview,
    skills,
    directions,
    links,
    opportunities,
    students,
    settings: config,
  }[tab];
  if (!admin)
    return (
      <Empty title="Доступ только для администратора">
        Управление QCareer доступно администратору QStudy.
      </Empty>
    );
  return (
    <div className={styles.root}>
      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>
            <Compass size={15} /> QCAREER · ЦЕНТР УПРАВЛЕНИЯ
          </span>
          <h1>От обучения — к своему пути.</h1>
          <p>
            Настройте навыки, свяжите их с реальными учебными результатами и
            помогите студентам выбрать профессию или продолжение образования.
          </p>
        </div>
        <Link className="btn btn-secondary" href="/qcareer">
          Открыть QCareer <ArrowUpRight size={16} />
        </Link>
      </header>
      <nav className={styles.tabs} aria-label="Разделы управления QCareer">
        {(
          [
            ["overview", "Обзор"],
            ["skills", "Навыки"],
            ["directions", "Направления"],
            ["links", "Связь с обучением"],
            ["opportunities", "Возможности"],
            ["students", "Студенты"],
            ["settings", "Настройки и логотип"],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => {
              setTab(value);
              setNotice("");
              setError("");
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <ErrorNotice message={error || activeResource.error} />
      {activeResource.error && (
        <button className="btn btn-secondary" type="button" onClick={refresh}>
          <RefreshCw size={15} /> Повторить загрузку
        </button>
      )}
      {activeResource.loading && <Loading />}

      {tab === "overview" && overview.data && (
        <>
          <div className={styles.stats}>
            {[
              ["Студенты", overview.data.students_count],
              ["Активные навыки", overview.data.active_skills],
              ["Направления", overview.data.active_directions],
              ["Учебные связи", overview.data.active_links],
              ["Возможности", overview.data.active_opportunities],
            ].map(([label, value]) => (
              <div className={styles.stat} key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <section className={styles.panel}>
            <h2>Как связана система</h2>
            <p>
              Силабус задаёт темы и работы. Учебная связь определяет, какой
              навык и уровень подтверждает успешный тест или оценённая работа.
              Карьерное направление сравнивает эти результаты со своими
              требованиями, а план предлагает до трёх следующих учебных шагов.
            </p>
            <p>
              Отметки «изучено» показывают активность. Подтверждённые уровни
              рассчитываются сервером по результатам и не назначаются вручную.
            </p>
            <div className={styles.actions}>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setTab("links")}
              >
                Настроить учебные связи
              </button>
              <Link className={styles.mutedLink} href="/dashboard/syllabi">
                Управление силабусами <ArrowUpRight size={14} />
              </Link>
            </div>
          </section>
          <section className={styles.panel}>
            <div className={styles.sectionHead}>
              <div>
                <h2>Результаты групп</h2>
                <p>
                  Количество навыков — сумма подтверждённых навыков студентов, а
                  не число профессий.
                </p>
              </div>
            </div>
            <div className={styles.table}>
              <table className="academic-table">
                <thead>
                  <tr>
                    <th>Группа</th>
                    <th>Студенты</th>
                    <th>Подтверждённые навыки</th>
                    <th>Подтверждения</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {overview.data.groups.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.name}</td>
                      <td>{entry.students_count}</td>
                      <td>{entry.demonstrated_skills}</td>
                      <td>{entry.evidence_count}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            setGroupId(String(entry.id));
                            setTab("students");
                          }}
                        >
                          Посмотреть
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!overview.data.groups.length && (
              <p className={styles.empty}>Группы ещё не созданы.</p>
            )}
          </section>
        </>
      )}

      {tab === "skills" && skills.data && (
        <section className={styles.panel}>
          <div className={styles.sectionHead}>
            <div>
              <h2>Каталог навыков</h2>
              <p>Компетенции, которые студент может подтвердить обучением.</p>
            </div>
            <RecordEditor
              title="Создать навык"
              fields={skillFields}
              initial={{ is_active: true }}
              endpoint="/admin/career/skills"
              onSaved={saved}
            />
          </div>
          <div className={styles.cardList}>
            {allSkills.map((skill) => (
              <article className={styles.card} key={skill.id}>
                <div className={styles.cardHead}>
                  <div>
                    <h3>{skill.name}</h3>
                    <div className={styles.meta}>
                      {activeBadge(skill.is_active)}
                      {skill.category && (
                        <span className={styles.badge}>{skill.category}</span>
                      )}
                      <span className={styles.hint}>{skill.slug}</span>
                    </div>
                  </div>
                  <div className={styles.actions}>
                    <RecordEditor
                      compact
                      title={`Редактировать навык ${skill.name}`}
                      fields={skillFields}
                      initial={{ ...skill }}
                      endpoint={`/admin/career/skills/${skill.id}`}
                      method="PATCH"
                      onSaved={saved}
                    />
                    <DeleteButton
                      title={`Удалить навык «${skill.name}»?`}
                      description="Удалятся его учебные связи и требования направлений. Исходные тесты, оценки и аккаунты сохранятся."
                      endpoint={`/admin/career/skills/${skill.id}`}
                      onDeleted={saved}
                    />
                  </div>
                </div>
                {skill.description && <p>{skill.description}</p>}
              </article>
            ))}
          </div>
          {!allSkills.length && (
            <Empty title="Создайте первый навык">
              После этого его можно связать с обучением и требованиями
              направлений.
            </Empty>
          )}
        </section>
      )}

      {tab === "directions" && directions.data && (
        <section className={styles.panel}>
          <div className={styles.sectionHead}>
            <div>
              <h2>Направления после обучения</h2>
              <p>
                Профессии, области работы и дальнейшее образование с понятными
                требованиями к навыкам.
              </p>
            </div>
            <DirectionEditor skills={allSkills} onSaved={saved} />
          </div>
          {skills.error && <ErrorNotice message={skills.error} />}
          <div className={styles.cardList}>
            {allDirections.map((direction) => (
              <article className={styles.card} key={direction.id}>
                <div className={styles.cardHead}>
                  <div>
                    <h3>{direction.title}</h3>
                    <div className={styles.meta}>
                      {activeBadge(direction.is_active)}
                      {direction.category && (
                        <span className={styles.badge}>
                          {direction.category}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className={styles.actions}>
                    <DirectionEditor
                      initial={direction}
                      skills={allSkills}
                      onSaved={saved}
                    />
                    <DeleteButton
                      title={`Удалить направление «${direction.title}»?`}
                      description="Направление исчезнет из каталога и карьерных целей. Учебные результаты студентов сохранятся."
                      endpoint={`/admin/career/directions/${direction.id}`}
                      onDeleted={saved}
                    />
                  </div>
                </div>
                {direction.description && <p>{direction.description}</p>}
                <ul className={styles.requirements}>
                  {direction.requirements.map((entry) => (
                    <li key={entry.skill_id}>
                      {entry.skill_name ||
                        allSkills.find((skill) => skill.id === entry.skill_id)
                          ?.name ||
                        "Навык"}
                      : {entry.level} / 5
                    </li>
                  ))}
                </ul>
                {!direction.requirements.length && (
                  <p>Требования ещё не заданы — покрытие не рассчитывается.</p>
                )}
                <div className={styles.paths}>
                  {[
                    ["Продолжение учёбы", direction.study_paths],
                    ["Карьера", direction.career_paths],
                  ].map(([title, paths]) => (
                    <div key={String(title)}>
                      <strong>{String(title)}</strong>
                      <ul>
                        {(paths as string[]).map((path, index) => (
                          <li key={index}>{path}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
          {!allDirections.length && (
            <Empty title="Направления ещё не созданы">
              Опишите варианты профессий и продолжения образования для ваших
              студентов.
            </Empty>
          )}
        </section>
      )}

      {tab === "links" && links.data && (
        <section className={styles.panel}>
          <div className={styles.sectionHead}>
            <div>
              <h2>Учебные источники навыков</h2>
              <p>
                Реальные дисциплины, силабусы, модули и работы QStudy. Уровень
                подтверждается после достижения указанного результата.
              </p>
            </div>
            <div className={styles.actions}>
              <LearningSuggestions
                onSaved={async (created) => {
                  await refresh();
                  setNotice(
                    `Добавлено учебных связей: ${created}. Существующие связи сохранены.`,
                  );
                }}
              />
              <LearningLinkEditor
                skills={allSkills}
                courses={allCourses}
                onSaved={saved}
              />
            </div>
          </div>
          <ErrorNotice message={sources.error || skills.error} />
          {(sources.loading || skills.loading) && <Loading />}
          {!sources.loading && !allCourses.length && (
            <p className={styles.hint}>
              Сначала создайте дисциплины в группе. Для детальных связей
              опубликуйте силабус и учебные работы.
            </p>
          )}
          {!skills.loading && !allSkills.length && (
            <p className={styles.hint}>
              Сначала создайте навыки в соседнем разделе.
            </p>
          )}
          <div className={styles.cardList}>
            {links.data.items.map((entry) => (
              <article className={styles.card} key={entry.id}>
                <div className={styles.cardHead}>
                  <div>
                    <h3>{entry.title || entry.skill_name}</h3>
                    <p>
                      {entry.group_name} · {entry.course_title}
                    </p>
                  </div>
                  <div className={styles.actions}>
                    <LearningLinkEditor
                      initial={entry}
                      skills={allSkills}
                      courses={allCourses}
                      onSaved={saved}
                    />
                    <DeleteButton
                      title="Удалить связь с обучением?"
                      description="Учебные тесты и работы останутся. По этой связи навыки больше не будут подтверждаться."
                      endpoint={`/admin/career/learning-links/${entry.id}`}
                      onDeleted={saved}
                    />
                  </div>
                </div>
                {entry.description && <p>{entry.description}</p>}
                <div className={styles.meta}>
                  {activeBadge(entry.is_active)}
                  <span className={styles.badge}>
                    {entry.skill_name} · уровень {entry.target_level}
                  </span>
                  <span className={styles.badge}>От {entry.min_score}%</span>
                  {entry.module && (
                    <span className={styles.badge}>{entry.module}</span>
                  )}
                  {entry.week_number && (
                    <span className={styles.badge}>
                      Неделя {entry.week_number}
                    </span>
                  )}
                  {entry.work_id && (
                    <span className={styles.badge}>
                      Работа #{entry.work_id}
                    </span>
                  )}
                  {entry.syllabus_id && (
                    <span className={styles.badge}>
                      Силабус #{entry.syllabus_id}
                    </span>
                  )}
                </div>
                {entry.prerequisites.length > 0 && (
                  <ul className={styles.requirements}>
                    {entry.prerequisites.map((row) => (
                      <li key={row.skill_id}>
                        Сначала:{" "}
                        {row.skill_name ||
                          allSkills.find((skill) => skill.id === row.skill_id)
                            ?.name ||
                          "Навык"}{" "}
                        · {row.level} / 5
                      </li>
                    ))}
                  </ul>
                )}
                <div className={styles.meta}>
                  {entry.href && (
                    <Link className={styles.mutedLink} href={entry.href}>
                      Открыть материал <ArrowUpRight size={13} />
                    </Link>
                  )}
                  {entry.source_available === false && (
                    <span className={`${styles.badge} ${styles.inactive}`}>
                      Источник недоступен — проверьте публикацию и ограничения
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
          {!links.data.items.length && (
            <Empty title="Связи ещё не настроены">
              Укажите, какой результат обучения подтверждает каждый навык.
            </Empty>
          )}
        </section>
      )}

      {tab === "opportunities" && opportunities.data && (
        <section className={styles.panel}>
          <div className={styles.sectionHead}>
            <div>
              <h2>Практика, работа и образование</h2>
              <p>
                Проверенные администратором предложения с источником и сроком
                публикации.
              </p>
            </div>
            <RecordEditor
              title="Добавить возможность"
              fields={opportunityFields}
              initial={{ kind: "internship", is_active: true }}
              endpoint="/admin/career/opportunities"
              onSaved={saved}
            />
          </div>
          <ErrorNotice message={directions.error} />
          <div className={styles.cardList}>
            {opportunities.data.items.map((entry) => (
              <article className={styles.card} key={entry.id}>
                <div className={styles.cardHead}>
                  <div>
                    <h3>{entry.title}</h3>
                    <p>
                      {[entry.organization, entry.location]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <div className={styles.actions}>
                    <RecordEditor
                      compact
                      title={`Редактировать ${entry.title}`}
                      fields={opportunityFields}
                      initial={{
                        ...entry,
                        direction_id: entry.direction_id ?? "",
                        published_at: localDateTime(entry.published_at),
                        expires_at: localDateTime(entry.expires_at),
                      }}
                      endpoint={`/admin/career/opportunities/${entry.id}`}
                      method="PATCH"
                      onSaved={saved}
                    />
                    <DeleteButton
                      title={`Удалить «${entry.title}»?`}
                      description="Предложение и его сохранения у студентов будут удалены."
                      endpoint={`/admin/career/opportunities/${entry.id}`}
                      onDeleted={saved}
                    />
                  </div>
                </div>
                {entry.description && <p>{entry.description}</p>}
                <div className={styles.meta}>
                  {activeBadge(entry.is_active)}
                  <span className={styles.badge}>
                    {kindLabels[entry.kind] || entry.kind}
                  </span>
                  <span className={styles.badge}>
                    {entry.direction_title ||
                      allDirections.find(
                        (direction) => direction.id === entry.direction_id,
                      )?.title ||
                      "Все направления"}
                  </span>
                  <span className={styles.hint}>
                    {entry.expires_at
                      ? `До ${date(entry.expires_at)}`
                      : "Без срока"}
                    {entry.expires_at &&
                    Date.parse(entry.expires_at) < Date.now()
                      ? " · срок истёк"
                      : ""}
                  </span>
                </div>
                {entry.url && (
                  <div className={styles.meta}>
                    <a
                      className={styles.mutedLink}
                      href={entry.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Источник предложения <ArrowUpRight size={13} />
                    </a>
                  </div>
                )}
              </article>
            ))}
          </div>
          {!opportunities.data.items.length && (
            <Empty title="Предложения ещё не опубликованы">
              Добавьте реальные стажировки, программы обучения или вакансии.
            </Empty>
          )}
        </section>
      )}

      {tab === "students" && (
        <section className={styles.panel}>
          <div className={styles.sectionHead}>
            <div>
              <h2>Путь студентов</h2>
              <p>
                Личные цели и подтверждённые результаты. Учётные записи
                изменяются в общей панели QStudy.
              </p>
            </div>
            <Link href="/qcontrol" className={styles.mutedLink}>
              Аккаунты <ArrowUpRight size={14} />
            </Link>
          </div>
          <form
            className={styles.filter}
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(query.trim());
            }}
          >
            <input
              className="field"
              aria-label="Поиск студента по имени или email"
              placeholder="Имя или email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              className="field"
              aria-label="Фильтр по группе"
              value={groupId}
              onChange={(event) => setGroupId(event.target.value)}
            >
              <option value="">Все группы</option>
              {overview.data?.groups.map((entry) => (
                <option value={entry.id} key={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            <button className="btn btn-secondary">Найти</button>
          </form>
          {students.data && (
            <div className={styles.table}>
              <table className="academic-table">
                <thead>
                  <tr>
                    <th>Студент</th>
                    <th>Цель</th>
                    <th>Навыки / подтверждения</th>
                    <th>Покрытие требований</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {students.data.items.map((student) => (
                    <tr key={student.id}>
                      <td>
                        <strong>{student.name || "Без имени"}</strong>
                        <small>{student.email}</small>
                        <small>{student.group_name || "Без группы"}</small>
                      </td>
                      <td>{student.target_direction_title || "Не выбрана"}</td>
                      <td>
                        {student.demonstrated_skills} / {student.evidence_count}
                      </td>
                      <td>
                        {student.readiness === null
                          ? "—"
                          : `${Math.round(student.readiness)}%`}
                      </td>
                      <td>
                        <button
                          className="btn btn-secondary"
                          type="button"
                          onClick={() => setSelectedStudent(student)}
                        >
                          Подробнее
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!students.data.items.length && (
                <p className={styles.empty}>Студенты не найдены.</p>
              )}
            </div>
          )}
          <p className={styles.hint}>
            Показано до 200 студентов. Для больших списков уточните группу или
            поисковый запрос.
          </p>
        </section>
      )}

      {tab === "settings" && config.data && (
        <>
          <section className={styles.panel}>
            <h2>Общие настройки</h2>
            <p>
              Один вход и одна база QStudy. Отдельные аккаунты, сервер или ключ
              ИИ для QCareer не требуются.
            </p>
            <form
              onSubmit={saveConfig}
              key={`${config.data.title}-${config.data.description}-${config.data.announcement}-${config.data.enabled}`}
            >
              <div className={styles.fields}>
                <label className={`academic-field ${styles.full}`}>
                  <span>Название проекта *</span>
                  <input
                    className="field"
                    name="title"
                    required
                    maxLength={120}
                    defaultValue={config.data.title}
                  />
                </label>
                <label className={`academic-field ${styles.full}`}>
                  <span>Описание</span>
                  <textarea
                    className="field"
                    name="description"
                    rows={4}
                    maxLength={4000}
                    defaultValue={config.data.description}
                  />
                </label>
                <label className={`academic-field ${styles.full}`}>
                  <span>Объявление</span>
                  <textarea
                    className="field"
                    name="announcement"
                    rows={2}
                    maxLength={2000}
                    defaultValue={config.data.announcement}
                  />
                </label>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={config.data.enabled}
                  />{" "}
                  QCareer доступен студентам
                </label>
              </div>
              <div className="academic-form-actions">
                <button className="btn btn-primary" disabled={busy}>
                  {busy ? "Сохраняем…" : "Сохранить настройки"}
                </button>
              </div>
            </form>
          </section>
          <section className={styles.panel}>
            <h2>Логотип QCareer</h2>
            <p>
              Используется фирменный логотип QCareer. Здесь можно загрузить
              другой PNG с прозрачным фоном или вернуть стандартный логотип.
            </p>
            <LogoUpload<{ logo_url: string; logo_custom: boolean }>
              title="Логотип QCareer"
              currentUrl={
                config.data.logo_url || "/brand/qforcelogo_qcareer.png"
              }
              custom={Boolean(config.data.logo_custom)}
              endpoint="/branding/career-logo"
              onSaved={async () => {
                await config.reload();
                notifyCareerChanged();
                setNotice("Логотип QCareer обновлён.");
              }}
            />
          </section>
        </>
      )}
      {selectedStudent && (
        <StudentReview
          student={selectedStudent}
          close={() => setSelectedStudent(null)}
        />
      )}
    </div>
  );
}
