"use client";
import { useRouter } from "next/navigation";
import { setActivity } from "@/lib/context";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Subject, Topic, Task, TaskCheck } from "@/types";
import {
  MessageSquare, Sparkles, Loader2, Send, Lightbulb, ListChecks, ChevronRight, RotateCcw,
} from "lucide-react";

const DIFFS = [
  { value: "easy", label: "Легко" },
  { value: "medium", label: "Средне" },
  { value: "hard", label: "Сложно" },
];

const STATUS: Record<string, { text: string; cls: string }> = {
  new: { text: "Новая", cls: "bg-gray-700/60 text-gray-300" },
  solved: { text: "Верно", cls: "bg-green-500/20 text-green-300" },
  partial: { text: "Частично", cls: "bg-yellow-500/20 text-yellow-300" },
  failed: { text: "Ошибка", cls: "bg-red-500/20 text-red-300" },
};

const VERDICT_STYLE: Record<string, string> = {
  correct: "border-green-500/40 bg-green-500/10",
  partial: "border-yellow-500/40 bg-yellow-500/10",
  wrong: "border-red-500/40 bg-red-500/10",
};

const VERDICT_EMOJI: Record<string, string> = {
  correct: "✅ Верно",
  partial: "🟡 Частично верно",
  wrong: "❌ Неверно",
};

export default function TasksPage() {
  // конфигурация генерации
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [difficulty, setDifficulty] = useState("medium");
  const [count, setCount] = useState(5);

  // решение
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<TaskCheck | null>(null);
  const [showHint, setShowHint] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const current = tasks.find((t) => t.id === selectedId) ?? null;
  const [sources, setSources] = useState<string[]>([]);
useEffect(() => {
  api<Subject[]>("/subjects").then(setSubjects).catch(() => {});
  api<Task[]>("/tasks").then(setTasks).catch(() => {});
}, []);

  useEffect(() => {
    setActivity({
      page: "tasks",
      subject: subjects.find((s) => s.id === Number(subjectId))?.name,
      task: current ? { question: current.question, status: current.status } : null,
    });
  }, [current?.id, subjectId, subjects]);
  useEffect(() => {
    setTopicId("");
    if (!subjectId) { setTopics([]); return; }
    api<Topic[]>(`/subjects/${subjectId}/topics`).then(setTopics).catch(() => {});
  }, [subjectId]);

  async function generate() {
    if (!subjectId) { setError("Сначала выбери предмет"); return; }
    setError("");
    setGenerating(true);
    try {
      const res = await api<{ tasks: Task[]; sources: string[] }>("/tasks/generate", {
  method: "POST",
  body: JSON.stringify({
    subject_id: Number(subjectId),
    topic_id: topicId ? Number(topicId) : null,
    difficulty,
    count,
  }),
});
setTasks((prev) => [...res.tasks, ...prev]);
setSources(res.sources);
if (res.tasks[0]) selectTask(res.tasks[0]);      if (created[0]) selectTask(created[0]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  function selectTask(t: Task) {
    setSelectedId(t.id);
    setAnswer(t.user_answer || "");
    setFeedback(null);
    setShowHint(false);
  }

  async function submit() {
    if (!current || !answer.trim()) return;
    setChecking(true);
    setError("");
    try {
      const res = await api<TaskCheck>(`/tasks/${current.id}/answer`, {
        method: "POST",
        body: JSON.stringify({ answer }),
      });
      setFeedback(res);
      setTasks((prev) => prev.map((t) => (t.id === res.task.id ? res.task : t)));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setChecking(false);
    }
  }

  function goNext() {
    if (!current) return;
    const idx = tasks.findIndex((t) => t.id === current.id);
    if (tasks[idx + 1]) selectTask(tasks[idx + 1]);
  }

  const solved = tasks.filter((t) => t.status === "solved").length;

  return (
    <div className="flex h-full flex-col">
      <h1 className="mb-1 text-2xl font-bold">Тренажёр</h1>
      <p className="mb-6 text-gray-400">
        ИИ составляет задачи, проверяет твои ответы и объясняет ошибки
      </p>

      {/* Панель генерации */}
      <div className="mb-6 flex flex-wrap items-center gap-2 rounded-2xl border border-gray-800 bg-gray-900 p-4">
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

        <select
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value)}
          className="rounded-lg border border-gray-800 bg-gray-800 px-3 py-2 text-sm outline-none focus:border-indigo-500"
        >
          {DIFFS.map((d) => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>

        <input
          type="number"
          min={1}
          max={10}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          className="w-16 rounded-lg border border-gray-800 bg-gray-800 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          title="Количество задач (1-10)"
        />

        <button
          onClick={generate}
          disabled={generating}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {generating ? "Придумываем..." : "Сгенерировать тест"}
        </button>

        {error && <span className="text-sm text-red-400">{error}</span>}
        {sources.length > 0 ? (
  <p className="w-full text-xs text-green-400/80">
    ✓ Составлено по: {sources.join(", ")}
  </p>
) : (
  <p className="w-full text-xs text-yellow-500/80">
    Материалов не нашлось — вопросы из общих знаний. Загрузи и обработай файлы в разделе «Файлы».
  </p>
)}
      </div>

      <div className="flex flex-1 gap-6 overflow-hidden">
        {/* Список задач */}
        <div className="flex w-80 shrink-0 flex-col">
          <div className="mb-3 flex items-center justify-between text-sm text-gray-400">
            <span>Задачи</span>
            <span>Решено: {solved}/{tasks.length}</span>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto pr-1">
            {tasks.map((t) => {
              const st = STATUS[t.status] ?? STATUS.new;
              return (
                <button
                  key={t.id}
                  onClick={() => selectTask(t)}
                  className={`w-full rounded-xl border p-3 text-left text-sm transition
                    ${selectedId === t.id
                      ? "border-indigo-500 bg-indigo-600/10"
                      : "border-gray-800 bg-gray-900 hover:border-gray-700"}`}
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${st.cls}`}>{st.text}</span>
                    <span className="text-[10px] uppercase text-gray-500">{t.difficulty}</span>
                  </div>
                  <div className="line-clamp-2 leading-snug">{t.question}</div>
                </button>
              );
            })}
            {tasks.length === 0 && (
              <p className="text-sm text-gray-500">
                Задач пока нет. Выбери предмет и сгенерируй тест.
              </p>
            )}
          </div>
        </div>

        {/* Решение */}
        <div className="flex flex-1 flex-col rounded-2xl border border-gray-800 bg-gray-900">
          {!current ? (
            <div className="flex flex-1 flex-col items-center justify-center text-gray-500">
              <ListChecks className="mb-3 h-10 w-10" />
              <p className="text-sm">Выбери задачу слева или сгенерируй новый тест</p>
            </div>
          ) : (
            <>
              <div className="border-b border-gray-800 p-5">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-gray-800 px-2 py-0.5 uppercase text-gray-400">
                    {current.difficulty}
                  </span>
                  {showHint && current.hint && (
                    <span className="flex items-start gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-300">
                      <Lightbulb className="mt-0.5 h-3 w-3 shrink-0" /> {current.hint}
                    </span>
                  )}
                </div>
                <p className="text-base leading-relaxed">{current.question}</p>
                {!showHint && current.hint && (
                  <button
                    onClick={() => setShowHint(true)}
                    className="mt-3 flex items-center gap-1 text-xs text-amber-400/80 hover:text-amber-300"
                  >
                    <Lightbulb className="h-3.5 w-3.5" /> Показать подсказку
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-5">
                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="Пиши свой ответ сюда — как на экзамене..."
                  disabled={checking}
                  className="h-32 w-full resize-none rounded-xl border border-gray-800 bg-gray-950 p-3 text-sm outline-none focus:border-indigo-500 disabled:opacity-60"
                />

                {feedback && (
                  <div className={`mt-4 rounded-xl border p-4 ${VERDICT_STYLE[feedback.verdict] ?? VERDICT_STYLE.wrong}`}>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="font-semibold">{VERDICT_EMOJI[feedback.verdict]}</span>
                      <span className="text-sm text-gray-300">{feedback.score}/100</span>
                    </div>
                    <p className="text-sm leading-relaxed text-gray-300">{feedback.feedback}</p>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 border-t border-gray-800 p-4">
  <button
    onClick={submit}
    disabled={checking || !answer.trim()}
    className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
  >
    {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
    {checking ? "Проверяем..." : "Проверить ответ"}
  </button>
  <button
    onClick={() => router.push("/dashboard/chat")}
    disabled={!current}
    title="Спросить ИИ об этой задаче в чате"
    className="flex items-center gap-2 rounded-lg bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700 disabled:opacity-50"
  >
    <MessageSquare className="h-4 w-4" /> Спросить ИИ
  </button>
  {/* дальше твой существующий блок {feedback && (...)} */}

                {feedback && (
                  <>
                    <button
                      onClick={() => setFeedback(null)}
                      className="flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Ещё раз
                    </button>
                    <button
                      onClick={goNext}
                      className="ml-auto flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700"
                    >
                      Следующая <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
