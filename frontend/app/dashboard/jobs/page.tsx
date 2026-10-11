"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  XCircle,
} from "lucide-react";
import {
  Empty,
  ErrorNotice,
  Loading,
  PageTitle,
  useResource,
} from "@/components/academic";

type AIJob = {
  id: string;
  kind: string;
  title: string;
  status: string;
  error: string;
  result: Record<string, unknown>;
  attempts: number;
  created_at: string;
  finished_at: string | null;
};

const kinds: Record<string, string> = {
  lecture: "Подготовка лекции",
  test: "Создание теста",
  test_summary: "Разбор результатов теста",
  exam: "Подготовка экзамена",
  syllabus_import: "Импорт силабуса",
  tasks: "Создание заданий",
  task: "Создание заданий",
  cards: "Подготовка карточек",
  file: "Обработка материала",
};
const statuses: Record<string, string> = {
  queued: "В очереди",
  running: "Выполняется",
  done: "Готово",
  error: "Нужна повторная попытка",
};

function source(job: AIJob) {
  if (
    job.kind === "lecture" &&
    typeof job.result?.lecture_id === "number" &&
    job.result.lecture_id > 0
  )
    return {
      href: `/dashboard/lectures/course/${job.result.lecture_id}`,
      label: "Открыть лекцию",
    };
  if (job.kind === "syllabus_import") {
    const courseId = job.result?.course_id;
    return {
      href:
        typeof courseId === "number" &&
        Number.isSafeInteger(courseId) &&
        courseId > 0
          ? `/dashboard/syllabi?course=${courseId}`
          : "/dashboard/syllabi",
      label: "Открыть силабусы",
    };
  }
  const destinations: Record<string, { href: string; label: string }> = {
    lecture: { href: "/dashboard/lectures", label: "Открыть лекции" },
    test: { href: "/dashboard/tests", label: "Открыть тесты" },
    test_summary: {
      href: "/dashboard/tests",
      label: "Открыть результаты теста",
    },
    exam: { href: "/dashboard/exam", label: "Открыть экзамены" },
    tasks: { href: "/dashboard/tasks", label: "Открыть тренажёр" },
    task: { href: "/dashboard/tasks", label: "Открыть тренажёр" },
    cards: { href: "/dashboard/review", label: "Открыть карточки" },
    file: { href: "/dashboard/files", label: "Открыть материалы" },
  };
  return (
    destinations[job.kind] || {
      href: "/dashboard/chat",
      label: "Перейти к ИИ-помощнику",
    }
  );
}

function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Дата не указана"
    : date.toLocaleString("ru-RU", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function outcome(job: AIJob) {
  if (job.status === "queued")
    return "Задача сохранена и ожидает своей очереди.";
  if (job.status === "running")
    return "Можно закрыть страницу: задача продолжит работу, а после перезапуска сервера будет восстановлена.";
  if (job.status === "error")
    return (
      job.error ||
      "Не удалось завершить задачу. Откройте исходный раздел и повторите действие."
    );
  if (job.kind === "syllabus_import") {
    if (job.result?.status === "needs_configuration")
      return "Документ сохранён. Для импорта требуется настройка ИИ на сервере.";
    if (job.result?.status === "manual_conflict")
      return "Ручные изменения сохранены. Автоматическая публикация отменена; проверьте документ.";
    if (job.result?.status === "review")
      return "Программа сохранена как черновик. Сравните её с действующим учебным планом.";
    const weeks = job.result?.weeks_created;
    const works = job.result?.works_created;
    if (typeof weeks === "number" && typeof works === "number")
      return `Программа опубликована. Добавлено недель: ${weeks}, работ: ${works}.`;
  }
  return "Результат сохранён и доступен в исходном разделе.";
}

export default function JobsPage() {
  const { data, loading, error, reload } = useResource<AIJob[]>(
    "/notifications/jobs",
  );
  const [filter, setFilter] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const jobs = data || [];
  const active = jobs.filter((job) =>
    ["queued", "running"].includes(job.status),
  ).length;
  const completed = jobs.filter((job) => job.status === "done").length;
  const failed = jobs.filter((job) => job.status === "error").length;
  const filtered = jobs.filter(
    (job) =>
      filter === "all" ||
      (filter === "active"
        ? ["queued", "running"].includes(job.status)
        : job.status === filter),
  );

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(timer);
  }, [active, reload]);

  async function refresh() {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div>
      <PageTitle
        eyebrow="МОЯ ИСТОРИЯ ИИ"
        title="Задания ИИ"
        description="Последние 100 ваших заданий. Статус и результаты сохраняются после обновления страницы и перезапуска сервера."
      >
        <button
          className="btn btn-secondary"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} /> {refreshing ? "Обновляем…" : "Обновить"}
        </button>
      </PageTitle>
      <ErrorNotice message={error} />
      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="academic-stats" style={{ marginBottom: 24 }}>
            <div className="panel academic-stat">
              <strong>{jobs.length}</strong>
              <p>Всего в истории</p>
            </div>
            <div className="panel academic-stat">
              <strong>{active}</strong>
              <p>В очереди и в работе</p>
            </div>
            <div className="panel academic-stat">
              <strong>{completed}</strong>
              <p>Завершено</p>
            </div>
            <div className="panel academic-stat">
              <strong>{failed}</strong>
              <p>Требуют внимания</p>
            </div>
          </div>
          <div className="academic-filter">
            <label className="academic-field">
              <span className="sr-only">Фильтр по состоянию задания</span>
              <select
                className="field"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">Все задания</option>
                <option value="active">В очереди и в работе</option>
                <option value="done">Завершённые</option>
                <option value="error">Требуют внимания</option>
              </select>
            </label>
            {active > 0 && (
              <p className="muted" style={{ fontSize: 12 }} role="status">
                Статус обновляется автоматически
              </p>
            )}
          </div>
          {filtered.length ? (
            <div className="academic-grid two">
              {filtered.map((job) => {
                const destination = source(job);
                const Icon =
                  job.status === "done"
                    ? CheckCircle2
                    : job.status === "error"
                      ? XCircle
                      : job.status === "running"
                        ? LoaderCircle
                        : Clock3;
                return (
                  <article className="panel academic-card" key={job.id}>
                    <div
                      className="academic-actions"
                      style={{ justifyContent: "space-between" }}
                    >
                      <span className="academic-meta">
                        <Sparkles size={14} /> {kinds[job.kind] || "Задание ИИ"}
                      </span>
                      <span className="badge">
                        <Icon size={13} /> {statuses[job.status] || job.status}
                      </span>
                    </div>
                    <h3 style={{ overflowWrap: "anywhere" }}>{job.title}</h3>
                    <p
                      className={
                        job.status === "error" ? "academic-error" : "muted"
                      }
                      style={{
                        fontSize: 13,
                        lineHeight: 1.7,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {outcome(job)}
                    </p>
                    <div className="academic-meta">
                      <span>Создано {dateTime(job.created_at)}</span>
                      {job.finished_at && (
                        <span>Завершено {dateTime(job.finished_at)}</span>
                      )}
                    </div>
                    <Link
                      className="academic-card-link"
                      href={destination.href}
                    >
                      {destination.label}
                      <ArrowUpRight size={15} />
                    </Link>
                  </article>
                );
              })}
            </div>
          ) : (
            <Empty
              title={
                jobs.length
                  ? "Нет заданий с таким статусом"
                  : "Заданий ИИ пока нет"
              }
            >
              {jobs.length
                ? "Выберите другой фильтр, чтобы посмотреть историю."
                : "Создайте лекцию, тест или загрузите силабус. Здесь появится статус обработки и переход к результату."}
            </Empty>
          )}
        </>
      )}
    </div>
  );
}
