"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { setActivity } from "@/lib/context";
import type { Lecture, Subject, Topic } from "@/types";
import {
  BookOpen, RefreshCw, Loader2, Sparkles, ChevronDown, ChevronRight,
  FileText, AlertTriangle, Pencil, Save, X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";

export default function LecturesPage() {
  const router = useRouter();

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [topicsBySubject, setTopicsBySubject] = useState<Record<number, Topic[]>>({});
  const [lectures, setLectures] = useState<Record<number, Lecture>>({});
  const [openTopic, setOpenTopic] = useState<number | null>(null);

  const [generating, setGenerating] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const subs = await api<Subject[]>("/subjects");
      setSubjects(subs);
      const tMap: Record<number, Topic[]> = {};
      for (const s of subs) {
        tMap[s.id] = await api<Topic[]>(`/subjects/${s.id}/topics`);
      }
      setTopicsBySubject(tMap);
      const lecRows = await api<Lecture[]>("/lectures");
      const lMap: Record<number, Lecture> = {};
      lecRows.forEach((l) => (lMap[l.topic_id] = l));
      setLectures(lMap);
    })().catch(() => {});
  }, []);

  useEffect(() => {
    setActivity({ page: "lectures" });
  }, []);

  async function refreshLecture(topicId: number) {
    const l = await api<Lecture>(`/lectures/topic/${topicId}`);
    setLectures((prev) => ({ ...prev, [topicId]: l }));
    return l;
  }

  async function toggleTopic(topicId: number) {
    if (openTopic === topicId) { setOpenTopic(null); return; }
    setOpenTopic(topicId);
    if (!lectures[topicId]) await refreshLecture(topicId);
  }

  async function generate(topicId: number) {
    setGenerating(topicId);
    setError("");
    try {
      await api(`/lectures/topic/${topicId}/generate`, { method: "POST" });
      // Пошла фоновая генерация; статус обновится через уведомление/поллинг
      setLectures((prev) => ({
        ...prev,
        [topicId]: { ...prev[topicId], status: "generating", content: prev[topicId]?.content ?? "" },
      }));
      pollStatus(topicId);
    } catch (e: any) {
      setError(e.message);
      setGenerating(null);
    }
  }

  function pollStatus(topicId: number) {
    const timer = setInterval(async () => {
      const l = await refreshLecture(topicId);
      if (l.status === "ready" || l.status === "empty") {
        clearInterval(timer);
        setGenerating(null);
      }
    }, 4000);
  }

  async function saveEdit(topicId: number) {
    const l = await api<Lecture>(`/lectures/topic/${topicId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: editContent }),
    });
    setLectures((prev) => ({ ...prev, [topicId]: l }));
    setEditing(false);
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-2xl font-bold">Лекции</h1>
      <p className="mb-8 text-gray-400">
        Живые лекции по каждой теме: собираются из твоих заметок и файлов, обновляются при изменении материалов
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {subjects.map((s) => (
        <div key={s.id} className="mb-6 overflow-hidden rounded-2xl border border-gray-800">
          {/* Шапка предмета */}
          <div className="flex items-center gap-3 bg-gray-900 px-4 py-3">
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="font-semibold">{s.name}</span>
            <span className="text-xs text-gray-500">{topicsBySubject[s.id]?.length ?? 0} тем</span>
          </div>

          {/* Строки-темы, как таблица */}
          <div className="divide-y divide-gray-800 border-t border-gray-800">
            {(topicsBySubject[s.id] ?? []).map((t) => {
              const lec = lectures[t.id];
              const isOpen = openTopic === t.id;
              return (
                <div key={t.id}>
                  <button
                    onClick={() => toggleTopic(t.id)}
                    className="flex w-full items-center gap-3 bg-gray-950 px-4 py-3 text-left transition hover:bg-gray-900"
                  >
                    {isOpen ? <ChevronDown className="h-4 w-4 text-gray-500" />
                             : <ChevronRight className="h-4 w-4 text-gray-500" />}
                    <FileText className="h-4 w-4 shrink-0 text-indigo-400" />
                    <span className="flex-1 text-sm">{t.title}</span>

                    {/* Статус лекции */}
                    {generating === t.id || lec?.status === "generating" ? (
                      <span className="flex items-center gap-1 text-xs text-indigo-300">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> составляется
                      </span>
                    ) : lec?.status === "ready" ? (
                      <span className="flex items-center gap-2">
                        {lec.stale && (
                          <span className="flex items-center gap-1 text-xs text-amber-400">
                            <AlertTriangle className="h-3.5 w-3.5" /> материалы изменились
                          </span>
                          )}
                        <span className="text-xs text-green-400">готова</span>
                      </span>
                    ) : (
                      <span className="text-xs text-gray-600">нет лекции</span>
                    )}
                  </button>

                  {/* Развёрнутая лекция */}
                  {isOpen && (
                    <div className="bg-gray-900 p-5">
                      {!lec || lec.status === "empty" || !lec.content ? (
                        <div className="flex flex-col items-center py-8 text-center">
                          <Sparkles className="mb-3 h-8 w-8 text-gray-600" />
                          <p className="mb-1 text-sm font-medium">Лекции ещё нет</p>
                          <p className="mb-4 text-xs text-gray-500">
                            {lec && lec.materials_count === 0
                              ? "Добавь заметки или обработай файлы по этой теме — и ИИ составит лекцию из них"
                              : "ИИ соберёт лекцию из твоих материалов по этой теме"}
                          </p>
                          <button
                            onClick={() => generate(t.id)}
                            disabled={lec && lec.materials_count === 0}
                            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
                          >
                            <Sparkles className="h-4 w-4" /> Составить лекцию
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="mb-3 flex flex-wrap items-center gap-2">
                            {lec.stale && (
                              <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
                                <AlertTriangle className="h-3.5 w-3.5" /> материалы менялись — обнови
                              </span>
                            )}
                            <button
                              onClick={() => generate(t.id)}
                              disabled={generating === t.id}
                              className="flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700 disabled:opacity-50"
                            >
                              <RefreshCw className={`h-3.5 w-3.5 ${generating === t.id ? "animate-spin" : ""}`} />
                              {lec.stale ? "Обновить лекцию" : "Пересобрать"}
                            </button>
                            <button
                              onClick={() => { setEditing(true); setEditContent(lec.content); }}
                              className="flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700"
                            >
                              <Pencil className="h-3.5 w-3.5" /> Править
                            </button>
                          </div>

                          {editing ? (
                            <>
                              <textarea
                                value={editContent}
                                onChange={(e) => setEditContent(e.target.value)}
                                rows={18}
                                className="w-full resize-y rounded-xl border border-gray-800 bg-gray-950 p-4 font-mono text-sm outline-none focus:border-indigo-500"
                              />
                              <div className="mt-2 flex gap-2">
                                <button onClick={() => saveEdit(t.id)}
                                  className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs hover:bg-indigo-500">
                                  <Save className="h-3.5 w-3.5" /> Сохранить
                                </button>
                                <button onClick={() => setEditing(false)}
                                  className="flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700">
                                  <X className="h-3.5 w-3.5" /> Отмена
                                </button>
                              </div>
                            </>
                          ) : (
                            <div className="prose prose-invert max-w-none text-sm">
                              <ReactMarkdown>{lec.content}</ReactMarkdown>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {(topicsBySubject[s.id] ?? []).length === 0 && (
              <div className="bg-gray-950 px-4 py-3 text-sm text-gray-500">Темы не созданы</div>
            )}
          </div>
        </div>
      ))}

      {subjects.length === 0 && (
        <p className="text-gray-500">Сначала создай предметы и темы.</p>
      )}
    </div>
  );
}