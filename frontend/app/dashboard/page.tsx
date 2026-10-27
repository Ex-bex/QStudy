"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CalendarDays,
  FileText,
  Layers,
  ListChecks,
  Loader2,
  Plus,
  Search,
  StickyNote,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  civilDate,
  isEntryOnDate,
  scheduleTimeLabel,
  shiftCivilDate,
  TIMETABLE_TIME_ZONE,
  weekPatternLabel,
} from "@/lib/timetable";
import type { Note } from "@/types";
import type { GroupDetail } from "@/types/academic";
import styles from "./overview.module.css";

type Resource<T> = { key: string; data: T | null; error: string };
type SearchResult = {
  notes: { id: number; title: string; snippet: string }[];
  materials: { id: number; filename: string; snippet: string }[];
  tasks: { id: number; question: string; status: string }[];
  cards: { id: number; front: string }[];
};
type SearchState = {
  owner: number;
  pending: boolean;
  data: SearchResult | null;
  error: string;
};

function dateLabel(value: string) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("ru-RU", {
    timeZone: TIMETABLE_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [date, setDate] = useState(civilDate);
  const [groupRevision, reloadGroup] = useState(0);
  const [notesRevision, reloadNotes] = useState(0);
  const [groupState, setGroup] = useState<Resource<GroupDetail> | null>(null);
  const [notesState, setNotes] = useState<Resource<Note[]> | null>(null);
  const [query, setQuery] = useState("");
  const [searchState, setSearch] = useState<SearchState | null>(null);
  const searchRequest = useRef(0);
  const groupKey = `${user.id}:${user.group_id ?? "none"}:${groupRevision}`;
  const notesKey = `${user.id}:${notesRevision}`;
  const groupResult = groupState?.key === groupKey ? groupState : null;
  const notesResult = notesState?.key === notesKey ? notesState : null;
  const group = groupResult?.data;
  const notes = notesResult?.data || [];
  const search = searchState?.owner === user.id ? searchState : null;
  const groupLoading = Boolean(user.group_id && !groupResult);

  useEffect(() => {
    const timer = window.setInterval(() => setDate(civilDate()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!user.group_id) return;
    const controller = new AbortController();
    api<GroupDetail>(`/groups/${user.group_id}`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setGroup({ key: groupKey, data, error: "" });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setGroup({
            key: groupKey,
            data: null,
            error:
              error instanceof Error
                ? error.message
                : "Не удалось загрузить расписание",
          });
      });
    return () => controller.abort();
  }, [groupKey, user.group_id]);

  useEffect(() => {
    const controller = new AbortController();
    api<Note[]>("/notes", { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setNotes({ key: notesKey, data, error: "" });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setNotes({
            key: notesKey,
            data: null,
            error:
              error instanceof Error
                ? error.message
                : "Не удалось загрузить заметки",
          });
      });
    return () => controller.abort();
  }, [notesKey]);

  useEffect(
    () => () => {
      searchRequest.current++;
    },
    [user.id],
  );

  const nearest = useMemo(() => {
    for (let offset = 0; group && offset < 14; offset++) {
      const day = shiftCivilDate(date, offset);
      const entries = group.schedule
        .filter((entry) => isEntryOnDate(entry, day))
        .sort((a, b) => a.start_time.localeCompare(b.start_time));
      if (entries.length) return { day, entries };
    }
    return null;
  }, [date, group]);
  const groupHref = user.group_id
    ? `/dashboard/groups/${user.group_id}`
    : "/dashboard/groups";
  const firstName =
    user.name?.trim().split(/\s+/)[0] || user.email.split("@")[0];
  const sourceEntries =
    nearest?.entries.filter((entry) => entry.source_file) || [];
  const sourceDate = sourceEntries.find(
    (entry) => entry.source_updated_at,
  )?.source_updated_at;

  async function find(event: React.FormEvent) {
    event.preventDefault();
    const value = query.trim();
    if (value.length < 2) return;
    const request = ++searchRequest.current;
    const owner = user.id;
    setSearch({ owner, pending: true, data: null, error: "" });
    try {
      const data = await api<SearchResult>(
        `/search?q=${encodeURIComponent(value)}`,
      );
      if (request === searchRequest.current)
        setSearch({ owner, pending: false, data, error: "" });
    } catch (error) {
      if (request === searchRequest.current)
        setSearch({
          owner,
          pending: false,
          data: null,
          error:
            error instanceof Error
              ? error.message
              : "Не удалось выполнить поиск",
        });
    }
  }

  return (
    <div className={styles.overview}>
      <header className={styles.heading}>
        <div>
          <h1>Обзор</h1>
          <p>
            Привет, {firstName}. <span>{dateLabel(date)}</span>
          </p>
        </div>
        <Link href="/dashboard/notes" className="btn btn-secondary">
          <Plus size={15} />
          Новая заметка
        </Link>
      </header>

      <div className={styles.columns}>
        <section className={styles.panel} aria-labelledby="overview-schedule">
          <div className={styles.sectionHead}>
            <h2 id="overview-schedule">
              <CalendarDays size={18} />
              Расписание
            </h2>
            <Link href={groupHref}>
              {group?.name || "Моя группа"}
              <ArrowUpRight size={14} />
            </Link>
          </div>
          {groupLoading ? (
            <div className={styles.empty} role="status">
              <Loader2 size={20} className="animate-spin" />
              <p>Загружаем расписание…</p>
            </div>
          ) : groupResult?.error ? (
            <div className={styles.empty} role="alert">
              <p>{groupResult.error}</p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => reloadGroup((value) => value + 1)}
              >
                Повторить загрузку расписания
              </button>
            </div>
          ) : nearest ? (
            <>
              <p className={styles.scheduleDate}>
                {nearest.day === date ? "Сегодня" : "Ближайший учебный день"}
                <span>{dateLabel(nearest.day)}</span>
              </p>
              <div className={styles.schedule}>
                {nearest.entries.map((entry) => (
                  <Link
                    key={entry.id}
                    href={`/dashboard/groups/${entry.group_id}/courses/${entry.course_id}`}
                    className={styles.lesson}
                  >
                    <time className={styles.time}>
                      {scheduleTimeLabel(entry)}
                    </time>
                    <div className={styles.lessonContent}>
                      <strong>{entry.course_title || "Дисциплина"}</strong>
                      <span>
                        {entry.lesson_type || "Занятие"} ·{" "}
                        {entry.room
                          ? `Кабинет ${entry.room}`
                          : "Кабинет не указан"}
                      </span>
                      {entry.teacher && <small>{entry.teacher}</small>}
                      {entry.week_pattern !== "every" && (
                        <small>{weekPatternLabel(entry.week_pattern)}</small>
                      )}
                    </div>
                    <ArrowUpRight size={15} className={styles.lessonArrow} />
                  </Link>
                ))}
              </div>
              {sourceEntries.length > 0 && (
                <details className={styles.source}>
                  <summary>Источник расписания</summary>
                  <p>
                    По загруженному справочнику
                    {sourceDate
                      ? ` от ${new Date(`${sourceDate}T12:00:00Z`).toLocaleDateString("ru-RU", { timeZone: TIMETABLE_TIME_ZONE })}`
                      : ""}
                    . Даты семестра в источнике не указаны.
                    {sourceEntries.some((entry) => !entry.end_time)
                      ? " Время окончания некоторых занятий не указано."
                      : ""}
                    {sourceEntries.some(
                      (entry) => entry.week_pattern === "unspecified",
                    )
                      ? " Периодичность некоторых занятий нужно уточнить у куратора."
                      : ""}
                  </p>
                </details>
              )}
            </>
          ) : (
            <div className={styles.empty}>
              <CalendarDays size={25} />
              <h3>
                {!user.group_id
                  ? "Группа ещё не выбрана"
                  : group?.schedule.length
                    ? "В ближайшие две недели занятий нет"
                    : "Расписание ещё не опубликовано"}
              </h3>
              <p>
                {!user.group_id
                  ? "Попросите администратора назначить вам группу."
                  : "Материалы и учебный план доступны на странице группы."}
              </p>
              <Link
                className="btn btn-secondary"
                href={!user.group_id ? "/dashboard/profile" : groupHref}
              >
                {!user.group_id ? "Мой профиль" : "Открыть группу"}
                <ArrowUpRight size={14} />
              </Link>
            </div>
          )}
        </section>

        <aside className={styles.side} aria-label="Учебные действия и заметки">
          <nav className={styles.actions} aria-label="Быстрые действия">
            {[
              {
                href: "/dashboard/modules",
                text: "Модули и задания",
                Icon: Layers,
              },
              {
                href: "/dashboard/tests",
                text: "Пройти тест",
                Icon: ListChecks,
              },
              {
                href: "/dashboard/files",
                text: "Мои материалы",
                Icon: FileText,
              },
            ].map(({ href, text, Icon }) => (
              <Link key={href} href={href}>
                <Icon size={18} />
                <span>{text}</span>
                <ArrowUpRight size={14} />
              </Link>
            ))}
          </nav>
          <section className={styles.panel} aria-labelledby="overview-notes">
            <div className={styles.sectionHead}>
              <h2 id="overview-notes">Заметки</h2>
              <Link href="/dashboard/notes">
                Все
                <ArrowUpRight size={14} />
              </Link>
            </div>
            {!notesResult ? (
              <p className={styles.noteStatus} role="status">
                Загружаем заметки…
              </p>
            ) : notesResult.error ? (
              <div className={styles.noteStatus} role="alert">
                <p>{notesResult.error}</p>
                <button
                  type="button"
                  onClick={() => reloadNotes((value) => value + 1)}
                >
                  Повторить загрузку заметок
                </button>
              </div>
            ) : notes.length ? (
              <div className={styles.notes}>
                {notes.slice(0, 3).map((note) => (
                  <Link key={note.id} href="/dashboard/notes">
                    <StickyNote size={16} />
                    <span>{note.title || "Без названия"}</span>
                    <ArrowUpRight size={13} />
                  </Link>
                ))}
              </div>
            ) : (
              <p className={styles.noteStatus}>
                Пока нет заметок. Сохраните важное с занятия.
              </p>
            )}
          </section>
        </aside>
      </div>

      <details className={styles.search}>
        <summary>
          <Search size={16} />
          Поиск по личным материалам
        </summary>
        <form onSubmit={find}>
          <input
            className="field"
            aria-label="Поиск по личным материалам"
            placeholder="Заметка, материал или задача"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            className="btn btn-secondary"
            disabled={search?.pending || query.trim().length < 2}
          >
            {search?.pending ? (
              <Loader2 size={15} className="animate-spin" aria-label="Поиск" />
            ) : (
              "Найти"
            )}
          </button>
        </form>
        {search?.error && (
          <p className={styles.searchError} role="alert">
            {search.error}
          </p>
        )}
        {search?.data && (
          <div className={styles.results} aria-live="polite">
            {search.data.notes.map((note) => (
              <Link key={`n${note.id}`} href="/dashboard/notes">
                <span>{note.title}</span>
                <small>{note.snippet}</small>
              </Link>
            ))}
            {search.data.materials.map((file) => (
              <Link key={`f${file.id}`} href="/dashboard/files">
                <span>{file.filename}</span>
                <small>{file.snippet}</small>
              </Link>
            ))}
            {search.data.tasks.map((task) => (
              <Link key={`t${task.id}`} href="/dashboard/tasks">
                {task.question}
              </Link>
            ))}
            {search.data.cards.map((card) => (
              <Link key={`c${card.id}`} href="/dashboard/review">
                {card.front}
              </Link>
            ))}
            {Object.values(search.data).every((items) => !items.length) && (
              <p>Ничего не найдено. Попробуйте другое слово.</p>
            )}
          </div>
        )}
      </details>
    </div>
  );
}
