"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, formatBytes } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  civilDate,
  isEntryOnDate,
  scheduleTimeLabel,
  weekPatternLabel,
} from "@/lib/timetable";
import type { Note, Material, Task } from "@/types";
import type { Group, GroupDetail, Schedule } from "@/types/academic";
import {
  BookOpen,
  StickyNote,
  FolderOpen,
  Layers,
  Sparkles,
  Search,
  Loader2,
  FileText,
  ArrowUpRight,
  ArrowRight,
  Plus,
  CalendarDays,
  GraduationCap,
  Mic,
} from "lucide-react";

type SearchResult = {
  notes: { id: number; title: string; snippet: string }[];
  materials: { id: number; filename: string; snippet: string }[];
  tasks: { id: number; question: string; status: string }[];
  cards: { id: number; front: string }[];
};
export default function DashboardPage() {
  const { user } = useAuth();
  const [notes, setNotes] = useState<Note[]>([]);
  const [files, setFiles] = useState<Material[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [due, setDue] = useState(0);
  const [groups, setGroups] = useState<Group[]>([]);
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [today, setToday] = useState<Schedule[]>([]);
  const [scheduleDate, setScheduleDate] = useState("");
  const [referenceDate, setReferenceDate] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [n, f, t, c, g] = await Promise.all([
          api<Note[]>("/notes"),
          api<Material[]>("/files"),
          api<Task[]>("/tasks"),
          api<{ due: number }>("/cards/stats"),
          api<Group[]>("/groups"),
        ]);
        if (!active) return;
        setNotes(n);
        setFiles(f);
        setTasks(t);
        setDue(c.due);
        setGroups(g);
        if (user.group_id) {
          const date = civilDate();
          const detail = await api<GroupDetail>(`/groups/${user.group_id}`);
          if (active) {
            setGroup(detail);
            setReferenceDate(date);
            setToday([]);
            setScheduleDate("");
            for (let offset = 0; offset < 14; offset++) {
              const next = new Date(`${date}T12:00:00Z`);
              next.setUTCDate(next.getUTCDate() + offset);
              const candidate = next.toISOString().slice(0, 10);
              const schedule = detail.schedule
                .filter((entry) => isEntryOnDate(entry, candidate))
                .sort((a, b) => a.start_time.localeCompare(b.start_time));
              if (schedule.length) {
                setToday(schedule);
                setScheduleDate(candidate);
                break;
              }
            }
          }
        } else {
          setGroup(null);
          setToday([]);
          setScheduleDate("");
        }
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Не удалось загрузить данные",
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [user.group_id]);
  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true);
    setError("");
    try {
      setResults(
        await api<SearchResult>(
          `/search?q=${encodeURIComponent(query.trim())}`,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка поиска");
    } finally {
      setSearching(false);
    }
  }
  const firstName = user.name?.split(" ")[0] || user.email.split("@")[0];
  const sourceDate = today.find(
    (entry) => entry.source_updated_at,
  )?.source_updated_at;
  const stats = [
    {
      label: "Дисциплин в группе",
      value: group?.courses.length || 0,
      icon: BookOpen,
      href: group ? `/dashboard/groups/${group.id}` : "/dashboard/groups",
      sub: "УЧЕБНЫЙ ПЛАН",
    },
    {
      label: "Личных заметок",
      value: notes.length,
      icon: StickyNote,
      href: "/dashboard/notes",
      sub: "ВАШИ ИДЕИ",
    },
    {
      label: "Материалов",
      value: files.length,
      icon: FolderOpen,
      href: "/dashboard/files",
      sub: formatBytes(files.reduce((sum, f) => sum + f.size, 0)),
    },
    {
      label: "Карточек к повторению",
      value: due,
      icon: Layers,
      href: "/dashboard/review",
      sub: "ЗАКРЕПЛЯЕМ",
    },
  ];
  return (
    <div>
      <div className="dashboard-welcome">
        <div>
          <span className="eyebrow">СЕГОДНЯ — ХОРОШИЙ ДЕНЬ ДЛЯ ОТКРЫТИЙ</span>
          <h1>
            Привет, {firstName}
            <span className="brand-dot">.</span>
          </h1>
          <p>Ваше обучение, чуть спокойнее и понятнее.</p>
        </div>
        <Link href="/dashboard/notes" className="btn btn-secondary">
          <Plus size={15} />
          Новая заметка
        </Link>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <form className="dashboard-search" onSubmit={search}>
        <Search size={16} />
        <input
          className="field"
          aria-label="Поиск по личным материалам"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Найти заметку, материал или задачу…"
        />
        <button
          className="btn btn-secondary"
          disabled={searching || query.trim().length < 2}
        >
          {searching ? <Loader2 size={14} className="animate-spin" /> : "Найти"}
        </button>
      </form>
      {results && (
        <div className="panel search-results">
          <div className="section-head">
            <h2>Результаты поиска</h2>
            <button
              className="muted"
              onClick={() => setResults(null)}
              aria-label="Закрыть результаты"
            >
              Закрыть ×
            </button>
          </div>
          {results.notes.map((n) => (
            <Link key={`n${n.id}`} href="/dashboard/notes">
              {n.title}
              <small>{n.snippet}</small>
            </Link>
          ))}
          {results.materials.map((f) => (
            <Link key={`f${f.id}`} href="/dashboard/files">
              {f.filename}
              <small>{f.snippet}</small>
            </Link>
          ))}
          {results.tasks.map((t) => (
            <Link key={`t${t.id}`} href="/dashboard/tasks">
              {t.question}
            </Link>
          ))}
          {results.cards.map((c) => (
            <Link key={`c${c.id}`} href="/dashboard/review">
              {c.front}
            </Link>
          ))}
          {Object.values(results).every((a) => !a.length) && (
            <p className="muted">Ничего не найдено. Попробуйте другое слово.</p>
          )}
        </div>
      )}
      <div className="welcome-banner">
        <span className="eyebrow" style={{ marginBottom: 10 }}>
          МАЛЕНЬКИЕ ШАГИ. БОЛЬШОЙ ПРОГРЕСС.
        </span>
        <h2>
          Сфокусируйтесь
          <br />
          на следующем открытии.
        </h2>
        <p>Откройте учебный план, выберите тему и двигайтесь в своём ритме.</p>
        <Link
          className="btn btn-primary"
          href={group ? `/dashboard/groups/${group.id}` : "/dashboard/groups"}
        >
          К моему обучению
          <ArrowUpRight size={14} />
        </Link>
        <div className="banner-art" aria-hidden="true">
          <div>
            Q<small>STUDY</small>
          </div>
          <span />
        </div>
      </div>
      <div className="stat-grid">
        {stats.map(({ label, value, icon: Icon, href, sub }) => (
          <Link key={label} href={href} className="stat-card">
            <div className="stat-card-top">
              <Icon size={18} />
              <span>{sub}</span>
            </div>
            <strong>{loading ? "—" : value.toString().padStart(2, "0")}</strong>
            <p>{label}</p>
          </Link>
        ))}
      </div>
      <div className="dashboard-grid">
        <div>
          <div className="panel">
            <div className="section-head">
              <h2>Моё расписание</h2>
              <Link
                href={
                  group ? `/dashboard/groups/${group.id}` : "/dashboard/groups"
                }
              >
                {group?.name || "Все группы"}
                <ArrowUpRight size={12} />
              </Link>
            </div>
            {scheduleDate && (
              <p className="muted" style={{ marginBottom: 16, fontSize: 12 }}>
                {scheduleDate === referenceDate
                  ? "Сегодня"
                  : "Ближайший учебный день"}
                {" · "}
                {new Date(`${scheduleDate}T12:00:00Z`).toLocaleDateString(
                  "ru-RU",
                  {
                    timeZone: "Asia/Almaty",
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                  },
                )}
                {" · UTC+5"}
              </p>
            )}
            {today.length > 0 ? (
              today.map((s) => (
                <Link
                  className="daily-schedule"
                  key={s.id}
                  href={`/dashboard/groups/${s.group_id}/courses/${s.course_id}`}
                >
                  <span
                    style={{
                      minWidth: 72,
                      maxWidth: 100,
                      whiteSpace: "normal",
                      lineHeight: 1.6,
                    }}
                  >
                    {scheduleTimeLabel(s)}
                  </span>
                  <div>
                    <strong>{s.course_title}</strong>
                    <small>
                      {s.lesson_type} · Кабинет {s.room || "не указан"} ·{" "}
                      {weekPatternLabel(s.week_pattern)}
                    </small>
                    {s.teacher && <small>{s.teacher}</small>}
                  </div>
                </Link>
              ))
            ) : (
              <div className="schedule-empty">
                <CalendarDays size={24} />
                <strong>
                  {loading
                    ? "Загружаем расписание…"
                    : !user.group_id
                      ? "Найдите свою группу"
                      : group?.schedule.length
                        ? "Сегодня занятий нет"
                        : "Расписание ещё не опубликовано"}
                </strong>
                <p>
                  {!user.group_id
                    ? "Попросите администратора назначить вам группу."
                    : "Учебный план и материалы доступны на странице группы."}
                </p>
                <Link
                  href={
                    !user.group_id
                      ? "/dashboard/profile"
                      : `/dashboard/groups/${user.group_id}`
                  }
                  style={{
                    display: "inline-block",
                    marginTop: 12,
                    color: "#5d8050",
                  }}
                >
                  {!user.group_id ? "Мой профиль →" : "Открыть группу →"}
                </Link>
              </div>
            )}
            {today.some((entry) => entry.source_file) && (
              <p
                className="muted"
                style={{ marginTop: 14, fontSize: 11, lineHeight: 1.6 }}
              >
                По загруженному справочнику
                {sourceDate
                  ? ` от ${new Date(`${sourceDate}T12:00:00Z`).toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty" })}`
                  : ""}
                . В нём не указаны даты семестра, время окончания и
                периодичность занятий. Изменения проверяйте у куратора.
              </p>
            )}
          </div>
          <div style={{ marginTop: 23 }}>
            <div className="section-head">
              <h2>Быстрый старт</h2>
              <span className="muted" style={{ fontSize: 9 }}>
                Всё, что помогает учиться
              </span>
            </div>
            <div className="quick-links">
              {[
                {
                  href: "/dashboard/syllabi",
                  label: "Силабусы",
                  icon: FileText,
                },
                {
                  href: "/dashboard/exam",
                  label: "Подготовка к экзамену",
                  icon: GraduationCap,
                },
                {
                  href: "/dashboard/voice",
                  label: "Записать лекцию",
                  icon: Mic,
                },
              ].map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} className="quick-link">
                  <Icon size={22} />
                  <span>{label}</span>
                  <ArrowUpRight size={13} />
                </Link>
              ))}
            </div>
          </div>
        </div>
        <div>
          <div className="panel">
            <div className="section-head">
              <h2>Недавние заметки</h2>
              <Link href="/dashboard/notes">
                Все заметки
                <ArrowUpRight size={12} />
              </Link>
            </div>
            {notes.slice(0, 3).map((n) => (
              <Link href="/dashboard/notes" key={n.id} className="recent-note">
                <FileText />
                <div>
                  <strong>{n.title}</strong>
                  <small>
                    {new Date(
                      n.updated_at +
                        (/Z|[+-]\d\d:\d\d$/.test(n.updated_at) ? "" : "Z"),
                    ).toLocaleDateString("ru-RU", {
                      day: "numeric",
                      month: "long",
                    })}
                  </small>
                </div>
                <span>↗</span>
              </Link>
            ))}
            {notes.length === 0 && (
              <div className="empty-state" style={{ padding: "21px 0" }}>
                <StickyNote size={22} />
                <p>Хорошей мысли нужно место.</p>
                <Link
                  href="/dashboard/notes"
                  style={{ color: "#6b895a", fontSize: 10 }}
                >
                  Создать первую заметку →
                </Link>
              </div>
            )}
          </div>
          <div className="assistant-mini">
            <span>
              <Sparkles size={15} /> QSTUDY AI
            </span>
            <h3>
              Не нужно разбираться
              <br />
              во всём в одиночку.
            </h3>
            <p>
              Объясним сложную тему, проверим знания и найдём ответы в
              материалах.
            </p>
            <Link href="/dashboard/chat">
              О чём хотите узнать?
              <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </div>
      <div
        style={{
          marginTop: 25,
          display: "flex",
          justifyContent: "space-between",
          gap: 15,
          color: "#a1ae95",
          fontSize: 9,
        }}
      >
        <span>
          {loading
            ? "Загрузка…"
            : `Групп: ${groups.length} · Решено задач: ${tasks.filter((t) => t.status === "solved").length}`}
        </span>
        <span>Каждый день — немного ближе.</span>
      </div>
    </div>
  );
}
