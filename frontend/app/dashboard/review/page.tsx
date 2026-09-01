"use client";
import { setActivity } from "@/lib/context";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Flashcard, Subject, Topic } from "@/types";
import {
  Layers, Sparkles, Loader2, Eye, Check, X, Minus, Trash2, Brain,
} from "lucide-react";

export default function ReviewPage() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [count, setCount] = useState(10);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const [dueCards, setDueCards] = useState<Flashcard[]>([]);
  const [stats, setStats] = useState({ total: 0, due: 0 });
  const [currentIdx, setCurrentIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [sessionDone, setSessionDone] = useState(0);
  const [loadingDue, setLoadingDue] = useState(false);

  const current = dueCards[currentIdx] ?? null;
useEffect(() => { setActivity({ page: "review" }); }, []);
  useEffect(() => {
    api<Subject[]>("/subjects").then(setSubjects).catch(() => {});
    refreshStats();
  }, []);

  useEffect(() => {
    setTopicId("");
    if (!subjectId) { setTopics([]); return; }
    api<Topic[]>(`/subjects/${subjectId}/topics`).then(setTopics).catch(() => {});
  }, [subjectId]);

  async function refreshStats() {
    try {
      const s = await api<{ total: number; due: number }>("/cards/stats");
      setStats(s);
    } catch {}
    setLoadingDue(false);
  }

  async function generate() {
    if (!subjectId) { setError("Выбери предмет"); return; }
    setError("");
    setGenerating(true);
    try {
      await api("/cards/generate", {
        method: "POST",
        body: JSON.stringify({
          subject_id: Number(subjectId),
          topic_id: topicId ? Number(topicId) : null,
          count,
        }),
      });
      await refreshStats();
      await loadDue();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  async function loadDue() {
    setLoadingDue(true);
    try {
      const cards = await api<Flashcard[]>("/cards/due");
      setDueCards(cards);
      setCurrentIdx(0);
      setFlipped(false);
      setSessionDone(0);
    } catch {}
    setLoadingDue(false);
  }

  async function review(quality: 0 | 1 | 2) {
    if (!current || reviewing) return;
    setReviewing(true);
    try {
      await api(`/cards/${current.id}/review`, {
        method: "POST",
        body: JSON.stringify({ quality }),
      });
      setSessionDone((n) => n + 1);
      setFlipped(false);
      // Убираем карточку из очереди; показываем следующую
      setDueCards((prev) => prev.filter((c) => c.id !== current.id));
      // currentIdx остаётся — теперь указывает на следующую
    } catch (e: any) {
      alert(e.message);
    } finally {
      setReviewing(false);
    }
  }

  const startNew = !current && dueCards.length === 0;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-bold">
        <Layers className="h-6 w-6 text-indigo-400" /> Повторение
      </h1>
      <p className="mb-8 text-gray-400">
        Интервальное повторение: карточки появляются ровно перед тем, как ты их забудешь
      </p>

      {/* Генерация */}
      <div className="mb-8 flex flex-wrap items-center gap-2 rounded-2xl border border-gray-800 bg-gray-900 p-4">
        <select
          value={subjectId}
          onChange={(e) => setSubjectId(e.target.value)}
          className="rounded-lg border border-gray-800 bg-gray-800 px-3 py-2 text-sm outline-none focus:border-indigo-500"
        >
          <option value="">Предмет...</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select
          value={topicId}
          onChange={(e) => setTopicId(e.target.value)}
          disabled={!subjectId}
          className="rounded-lg border border-gray-800 bg-gray-800 px-3 py-2 text-sm outline-none focus:border-indigo-500 disabled:opacity-40"
        >
          <option value="">Вся программа</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>{t.title}</option>
          ))}
        </select>
        <input
          type="number" min={1} max={30} value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          className="w-16 rounded-lg border border-gray-800 bg-gray-800 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          title="Сколько карточек создать"
        />
        <button
          onClick={generate}
          disabled={generating}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {generating ? "Создаём..." : "Создать карточки"}
        </button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>

      {/* Статистика */}
      <div className="mb-6 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 text-center">
          <div className="text-2xl font-bold">{stats.total}</div>
          <div className="text-xs text-gray-500">всего карточек</div>
        </div>
        <div className="rounded-xl border border-indigo-500/40 bg-indigo-500/10 p-4 text-center">
          <div className="text-2xl font-bold text-indigo-300">{stats.due}</div>
          <div className="text-xs text-gray-400">повторить сегодня</div>
        </div>
      </div>

      {/* Режим повторения */}
      {current ? (
        <div className="rounded-2xl border border-gray-800 bg-gray-900">
          <div className="border-b border-gray-800 px-5 py-3 text-xs text-gray-500">
            Карточка {currentIdx + 1} · повторений: {current.repetitions} · интервал: {current.interval} дн.
          </div>
          <div
            onClick={() => setFlipped(!flipped)}
            className="flex min-h-56 cursor-pointer flex-col items-center justify-center p-8 text-center transition"
          >
            {!flipped ? (
              <>
                <p className="text-lg font-medium leading-relaxed">{current.front}</p>
                <p className="mt-4 flex items-center gap-1 text-xs text-gray-500">
                  <Eye className="h-3.5 w-3.5" /> кликни, чтобы перевернуть
                </p>
              </>
            ) : (
              <>
                <p className="mb-3 text-xs uppercase tracking-wide text-gray-500">Ответ</p>
                <p className="text-base leading-relaxed text-gray-200">{current.back}</p>
              </>
            )}
          </div>
          {flipped && (
            <div className="flex gap-2 border-t border-gray-800 p-4">
              <button
                onClick={() => review(0)}
                disabled={reviewing}
                className="flex flex-1 flex-col items-center gap-1 rounded-xl bg-red-500/10 py-3 text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
              >
                <X className="h-5 w-5" />
                <span className="text-xs">Забыл</span>
              </button>
              <button
                onClick={() => review(1)}
                disabled={reviewing}
                className="flex flex-1 flex-col items-center gap-1 rounded-xl bg-yellow-500/10 py-3 text-yellow-300 transition hover:bg-yellow-500/20 disabled:opacity-50"
              >
                <Minus className="h-5 w-5" />
                <span className="text-xs">С трудом</span>
              </button>
              <button
                onClick={() => review(2)}
                disabled={reviewing}
                className="flex flex-1 flex-col items-center gap-1 rounded-xl bg-green-500/10 py-3 text-green-300 transition hover:bg-green-500/20 disabled:opacity-50"
              >
                <Check className="h-5 w-5" />
                <span className="text-xs">Помню</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center rounded-2xl border border-gray-800 bg-gray-900 p-10 text-center">
          <Brain className="mb-3 h-10 w-10 text-gray-600" />
          {sessionDone > 0 ? (
            <>
              <p className="mb-1 font-medium">Сессия завершена!</p>
              <p className="mb-4 text-sm text-gray-400">Повторено карточек: {sessionDone}</p>
            </>
          ) : loadingDue ? (
            <p className="text-sm text-gray-500">Загружаем...</p>
          ) : (
            <>
              <p className="mb-1 font-medium">На сегодня всё чисто 🎉</p>
              <p className="text-sm text-gray-400">
                Создай карточки из материалов или возвращайся завтра
              </p>
            </>
          )}
        </div>
      )}

      {/* Обновить очередь */}
      <button
        onClick={loadDue}
        className="mt-4 w-full rounded-lg bg-gray-800 py-2 text-sm hover:bg-gray-700"
      >
        Обновить очередь повторения
      </button>
    </div>
  );
}