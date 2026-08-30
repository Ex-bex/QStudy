"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, formatBytes } from "@/lib/api";
import type { Subject, Note, Material, Task } from "@/types";
import {
  BookOpen, StickyNote, FolderOpen, Layers, Sparkles, Search, Loader2,
  FileText, ListChecks, GraduationCap,
} from "lucide-react";

interface SearchResult {
  notes: { id: number; title: string; snippet: string }[];
  materials: { id: number; filename: string; snippet: string; processed: boolean }[];
  tasks: { id: number; question: string; status: string }[];
  cards: { id: number; front: string }[];
}

const EMPTY: SearchResult = { notes: [], materials: [], tasks: [], cards: [] };

export default function DashboardPage() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [files, setFiles] = useState<Material[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [due, setDue] = useState(0);

  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    Promise.all([
      api<Subject[]>("/subjects"),
      api<Note[]>("/notes"),
      api<Material[]>("/files"),
      api<Task[]>("/tasks"),
      api<{ total: number; due: number }>("/cards/stats"),
    ])
      .then(([s, n, f, t, cs]) => {
        setSubjects(s);
        setNotes(n);
        setFiles(f);
        setTasks(t);
        setDue(cs.due);
      })
      .catch(() => {});
  }, []);

  async function doSearch(e?: React.FormEvent) {
    e?.preventDefault();
    if (q.trim().length < 2) return;
    setSearching(true);
    try {
      const res = await api<SearchResult>(`/search?q=${encodeURIComponent(q.trim())}`);
      setResults(res);
    } catch {
      setResults(EMPTY);
    } finally {
      setSearching(false);
    }
  }

  const totalSize = files.reduce((acc, f) => acc + f.size, 0);
  const processed = files.filter((f) => f.processed).length;
  const solved = tasks.filter((t) => t.status === "solved").length;

  const cards = [
    { label: "Предметы", value: subjects.length, icon: BookOpen, href: "/dashboard/subjects" },
    { label: "Заметки", value: notes.length, icon: StickyNote, href: "/dashboard/notes" },
    { label: "Файлы", value: `${processed}/${files.length}`, icon: FolderOpen, href: "/dashboard/files", sub: "прочитано ИИ" },
    { label: "Решено задач", value: solved, icon: ListChecks, href: "/dashboard/tasks" },
  ];

  const totalHits = results
    ? results.notes.length + results.materials.length + results.tasks.length + results.cards.length
    : 0;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-2xl font-bold">Обзор</h1>
      <p className="mb-8 text-gray-400">Всё твоё обучение в одном месте</p>

      {/* Пора повторить */}
      {due > 0 && (
        <Link
          href="/dashboard/review"
          className="mb-6 flex items-center justify-between rounded-2xl border border-indigo-500/40 bg-indigo-500/10 p-4 transition hover:border-indigo-400"
        >
          <div className="flex items-center gap-3">
            <Layers className="h-5 w-5 text-indigo-400" />
            <span className="font-medium">Пора повторить {due} {due === 1 ? "карточку" : "карточек"}</span>
          </div>
          <span className="text-sm text-indigo-300">Начать →</span>
        </Link>
      )}

      {/* Поиск */}
      <form onSubmit={doSearch} className="mb-6 flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по заметкам, файлам, задачам и карточкам..."
            className="w-full rounded-xl border border-gray-800 bg-gray-900 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-indigo-500"
          />
        </div>
        <button
          type="submit"
          disabled={searching || q.trim().length < 2}
          className="rounded-xl bg-indigo-600 px-4 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Найти"}
        </button>
      </form>

      {/* Результаты поиска */}
      {results && (
        <div className="mb-8 space-y-4 rounded-2xl border border-gray-800 bg-gray-900 p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Результаты</h2>
            <span className="text-xs text-gray-500">найдено: {totalHits}</span>
          </div>

          {totalHits === 0 && <p className="text-sm text-gray-500">Ничего не найдено</p>}

          {results.notes.length > 0 && (
            <div>
              <p className="mb-2 text-xs uppercase text-gray-500">Заметки</p>
              {results.notes.map((r) => (
                <Link key={r.id} href="/dashboard/notes"
                  className="block rounded-lg px-3 py-2 text-sm hover:bg-gray-800">
                  <div className="font-medium">{r.title}</div>
                  <div className="text-xs text-gray-500">{r.snippet}</div>
                </Link>
              ))}
            </div>
          )}

          {results.materials.length > 0 && (
            <div>
              <p className="mb-2 text-xs uppercase text-gray-500">Файлы</p>
              {results.materials.map((r) => (
                <Link key={r.id} href="/dashboard/files"
                  className="flex items-start gap-2 rounded-lg px-3 py-2 text-sm hover:bg-gray-800">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" />
                  <div>
                    <div className="font-medium">{r.filename}</div>
                    <div className="text-xs text-gray-500">{r.snippet}</div>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {results.tasks.length > 0 && (
            <div>
              <p className="mb-2 text-xs uppercase text-gray-500">Задачи</p>
              {results.tasks.map((r) => (
                <Link key={r.id} href="/dashboard/tasks"
                  className="block rounded-lg px-3 py-2 text-sm hover:bg-gray-800">
                  <div className="line-clamp-1">{r.question}</div>
                  <div className="text-xs text-gray-500">статус: {r.status}</div>
                </Link>
              ))}
            </div>
          )}

          {results.cards.length > 0 && (
            <div>
              <p className="mb-2 text-xs uppercase text-gray-500">Карточки</p>
              {results.cards.map((r) => (
                <Link key={r.id} href="/dashboard/review"
                  className="block rounded-lg px-3 py-2 text-sm hover:bg-gray-800">
                  <div className="line-clamp-1">{r.front}</div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Статистика */}
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {cards.map(({ label, value, icon: Icon, href, sub }) => (
          <Link key={label} href={href}
            className="rounded-2xl border border-gray-800 bg-gray-900 p-5 transition hover:border-indigo-500/50">
            <Icon className="mb-3 h-5 w-5 text-indigo-400" />
            <div className="text-2xl font-bold">{value}</div>
            <div className="text-sm text-gray-400">{label}</div>
            {sub && <div className="text-xs text-gray-500">{sub}</div>}
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Недавние заметки */}
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Недавние заметки</h2>
            <Link href="/dashboard/notes" className="text-sm text-indigo-400 hover:underline">Все</Link>
          </div>
          {notes.slice(0, 5).map((n) => (
            <Link key={n.id} href="/dashboard/notes"
              className="block rounded-lg px-3 py-2 text-sm hover:bg-gray-800">
              <div className="font-medium">{n.title}</div>
              <div className="text-xs text-gray-500">
                {new Date(n.updated_at).toLocaleString("ru", {
                  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                })}
              </div>
            </Link>
          ))}
          {notes.length === 0 && <p className="px-3 text-sm text-gray-500">Пока пусто</p>}
        </div>

        {/* ИИ-панель */}
        <div className="rounded-2xl border border-indigo-500/30 bg-gradient-to-br from-indigo-600/10 to-purple-600/10 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-indigo-400" />
            <h2 className="font-semibold">ИИ-помощник</h2>
          </div>
          <ul className="space-y-2 text-sm text-gray-300">
            <li>💬 Чат видит твои материалы и знает, чем ты занят</li>
            <li>📝 Тренажёр: задачи по твоим конспектам с проверкой</li>
            <li>🎓 Экзаменатор: отвечай голосом, получай разбор</li>
            <li>🔁 Повторение: карточки появляются перед забыванием</li>
          </ul>
          <p className="mt-4 rounded-lg bg-gray-900/60 px-3 py-2 text-xs text-gray-400">
            Хранилище: {formatBytes(totalSize)} · Обработано ИИ: {processed} из {files.length}
          </p>
          <Link href="/dashboard/exam"
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500">
            <GraduationCap className="h-4 w-4" /> Проверить себя экзаменом
          </Link>
        </div>
      </div>
    </div>
  );
}