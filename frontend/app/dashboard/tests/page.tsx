"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { setActivity } from "@/lib/context";
import { learningSourceActivity } from "@/lib/learning-selection";
import { assessmentSessionFromQuery } from "@/lib/assessment-link";
import {
  LearningSourceSelector,
  SourceContext,
  useLearningSource,
} from "@/components/learning-source";
import { DeleteButton, errorMessage } from "@/components/academic";
import type {
  TestSession,
  TestQuestion,
  Subject,
  Topic,
  JobNotification,
} from "@/types";
import {
  ListChecks,
  ArrowUpRight,
  Loader2,
  MessageSquare,
  ChevronRight,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Plus,
} from "lucide-react";

const DIFFS = [
  { value: "easy", label: "Легко" },
  { value: "medium", label: "Средне" },
  { value: "hard", label: "Сложно" },
];

export default function TestsPage() {
  const source = useLearningSource();
  const router = useRouter();

  // выбор
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [allTopics, setAllTopics] = useState<Topic[]>([]);
  const [selSubjects, setSelSubjects] = useState<number[]>([]);
  const [selTopics, setSelTopics] = useState<number[]>([]);
  const [difficulty, setDifficulty] = useState("medium");
  const [count, setCount] = useState(10);

  // прохождение
  const [test, setTest] = useState<TestSession | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [history, setHistory] = useState<TestSession[]>([]);
  const [error, setError] = useState("");
  const [answering, setAnswering] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const unanswered = test?.questions.filter((q) => q.user_index === null) ?? [];
  const current = unanswered[0] ?? null;
  const answeredCount = (test?.questions.length ?? 0) - unanswered.length;
  const feedbackQ = test?.questions.find((q) => q.id === feedbackFor) ?? null;

  useEffect(() => {
    const requested = assessmentSessionFromQuery(window.location.search);
    if (!requested) return;
    let active = true;
    api<TestSession>(`/tests/${requested}`)
      .then((value) => {
        if (active) setTest(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    (async () => {
      const subs = await api<Subject[]>("/subjects");
      setSubjects(subs);
      const maps: Topic[] = [];
      for (const s of subs) {
        const ts = await api<Topic[]>(`/subjects/${s.id}/topics`);
        maps.push(...ts);
      }
      setAllTopics(maps);
    })().catch((e: unknown) => setError(errorMessage(e)));
    api<TestSession[]>("/tests")
      .then(setHistory)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    const complete = (event: Event) => {
      const job = (event as CustomEvent<JobNotification>).detail;
      if (job.kind !== "test" && job.kind !== "test_summary") return;
      api<TestSession[]>("/tests")
        .then(setHistory)
        .catch((e: unknown) => setError(errorMessage(e)));
      if (job.id === jobId) {
        setJobId(null);
        setNotice("");
        if (job.status === "error")
          setError(
            job.error || "Не удалось составить тест. Повторите попытку.",
          );
        else if (job.result?.test_id)
          api<TestSession>(`/tests/${job.result.test_id}`)
            .then((value) => {
              setTest(value);
              setFeedbackFor(null);
            })
            .catch((e: unknown) => setError(errorMessage(e)));
      } else if (job.status === "done" && test?.status === "finished") {
        api<TestSession>(`/tests/${test.id}`)
          .then(setTest)
          .catch((e: unknown) => setError(errorMessage(e)));
      }
    };
    window.addEventListener("qstudy:job", complete);
    return () => window.removeEventListener("qstudy:job", complete);
  }, [jobId, test?.id, test?.status]);

  // активность для чата
  useEffect(() => {
    const names = subjects
      .filter((s) => selSubjects.includes(s.id))
      .map((s) => s.name)
      .join(", ");
    setActivity({
      page: "tests",
      course_id: source.courseMode
        ? source.selection.course_id || undefined
        : undefined,
      module: source.courseMode ? source.selection.module : undefined,
      week_numbers: source.courseMode
        ? source.selection.week_numbers
        : undefined,
      work_ids: source.courseMode ? source.selection.work_ids : undefined,
      use_web: source.selection.use_web,
      subject: names || undefined,
      ...(test?.id
        ? learningSourceActivity(test?.source_context, source.selection.use_web)
        : {}),
      task:
        test?.status === "active" && current
          ? { question: current.question, status: "тест" }
          : null,
    });
  }, [
    current,
    test?.status,
    test?.id,
    test?.source_context,
    selSubjects,
    subjects,
    source.courseMode,
    source.selection,
  ]);

  function toggleSubject(id: number) {
    setSelSubjects((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      // убрать темы снятого предмета
      const removed = prev.filter((x) => !next.includes(x));
      if (removed.length) {
        const goneTopics = allTopics
          .filter((t) => removed.includes(t.subject_id))
          .map((t) => t.id);
        setSelTopics((tp) => tp.filter((x) => !goneTopics.includes(x)));
      }
      return next;
    });
  }

  function toggleTopic(id: number) {
    setSelTopics((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function start() {
    if (
      (source.courseMode && source.selectionError) ||
      (!source.courseMode && !selSubjects.length)
    ) {
      setError(
        source.courseMode
          ? source.selectionError
          : "Выберите хотя бы один предмет.",
      );
      return;
    }
    setError("");
    setStarting(true);
    try {
      const result = await api<{ job_id: string }>("/tests/start", {
        method: "POST",
        body: JSON.stringify({
          ...source.payload,
          subject_ids: source.courseMode ? [] : selSubjects,
          topic_ids: source.courseMode
            ? []
            : selTopics.length
              ? selTopics
              : null,
          difficulty,
          count,
        }),
      });
      // Тест уйдёт в фон; придёт уведомление в колокольчик.
      // Для удобства — подсказка:
      setError("");
      setStarting(false);
      setJobId(result.job_id);
      setNotice(
        "ИИ составляет тест. Он откроется автоматически после завершения.",
      );
    } catch (e: unknown) {
      setError(errorMessage(e));
      setStarting(false);
    }
  }

  async function answer(idx: number) {
    if (!current || current.user_index !== null || answering) return;
    setAnswering(true);
    setError("");
    try {
      const res = await api<{ question: TestQuestion }>(
        `/tests/${test!.id}/answer/${current.id}`,
        { method: "POST", body: JSON.stringify({ option_index: idx }) },
      );
      setTest((prev) =>
        prev
          ? {
              ...prev,
              questions: prev.questions.map((q) =>
                q.id === res.question.id ? res.question : q,
              ),
            }
          : prev,
      );
      setFeedbackFor(current.id);
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setAnswering(false);
    }
  }

  function nextQuestion() {
    setFeedbackFor(null);
  }

  async function finish() {
    setFinishing(true);
    try {
      const s = await api<TestSession>(`/tests/${test!.id}/finish`, {
        method: "POST",
      });
      setTest(s);
      setFeedbackFor(null);
      loadHistory();
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setFinishing(false);
    }
  }

  async function loadHistory() {
    api<TestSession[]>("/tests")
      .then(setHistory)
      .catch((e: unknown) => setError(errorMessage(e)));
  }

  function exitTest() {
    if (
      test?.status === "active" &&
      !confirm("Прервать тест? Его можно продолжить из истории")
    )
      return;
    setTest(null);
    setFeedbackFor(null);
    loadHistory();
  }

  async function openFromHistory(s: TestSession) {
    try {
      const full = await api<TestSession>(`/tests/${s.id}`);
      setTest(full);
      setFeedbackFor(null);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const allDone = test?.status === "active" && unanswered.length === 0;

  // ================= ЭКРАН ТЕСТА =================
  if (test) {
    return (
      <div className="mx-auto max-w-3xl academic-assessment">
        <SourceContext value={test.source_context} />
        {test.status === "active" ? (
          <>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h1 className="flex items-center gap-2 text-2xl font-bold">
                  <ListChecks className="h-6 w-6 text-indigo-400" /> Тест
                </h1>
                <p className="text-sm text-gray-400">
                  {test.subject_names?.join(", ")} · Вопрос{" "}
                  {Math.min(answeredCount + 1, test.questions.length)} из{" "}
                  {test.questions.length}
                </p>
              </div>
              <button
                onClick={exitTest}
                className="rounded-lg bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700"
              >
                Прервать
              </button>
            </div>

            <div className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
              <div
                className="h-full bg-indigo-500 transition-all"
                style={{
                  width: `${(answeredCount / Math.max(1, test.questions.length)) * 100}%`,
                }}
              />
            </div>

            {/* Текущий вопрос */}
            {current && !feedbackQ && (
              <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <p className="text-lg leading-relaxed">{current.question}</p>
                  <button
                    onClick={() => router.push("/dashboard/chat")}
                    title="Спросить ИИ об этом вопросе"
                    className="flex shrink-0 items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700"
                  >
                    <MessageSquare className="h-3.5 w-3.5" /> Спросить ИИ
                  </button>
                </div>
                <div className="space-y-2">
                  {current.options.map((opt, i) => (
                    <button
                      key={i}
                      onClick={() => answer(i)}
                      disabled={answering}
                      className="flex w-full items-center gap-3 rounded-xl border border-gray-800 bg-gray-950 p-3 text-left text-sm transition hover:border-indigo-500"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-800 font-bold text-indigo-300">
                        {"АБВГ"[i]}
                      </span>
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Фидбек */}
            {feedbackQ && feedbackQ.user_index !== null && (
              <div
                className={`rounded-2xl border p-6 ${
                  feedbackQ.user_index === feedbackQ.correct_index
                    ? "border-green-500/40 bg-green-500/10"
                    : "border-red-500/40 bg-red-500/10"
                }`}
              >
                <div className="mb-3 flex items-center gap-2 font-semibold">
                  {feedbackQ.user_index === feedbackQ.correct_index ? (
                    <>
                      <CheckCircle2 className="h-5 w-5 text-green-400" /> Верно!
                    </>
                  ) : (
                    <>
                      <XCircle className="h-5 w-5 text-red-400" /> Неправильно
                    </>
                  )}
                </div>
                <p className="mb-2 text-sm text-gray-300">
                  {feedbackQ.question}
                </p>
                <p className="mb-1 text-sm">
                  <span className="text-gray-500">Правильный ответ: </span>
                  <span className="text-green-300">
                    {"АБВГ"[feedbackQ.correct_index!]} —{" "}
                    {feedbackQ.options[feedbackQ.correct_index!]}
                  </span>
                </p>
                {feedbackQ.user_index !== feedbackQ.correct_index && (
                  <p className="mb-1 text-sm">
                    <span className="text-gray-500">Ты выбрал: </span>
                    <span className="text-red-300">
                      {"АБВГ"[feedbackQ.user_index]} —{" "}
                      {feedbackQ.options[feedbackQ.user_index]}
                    </span>
                  </p>
                )}
                {feedbackQ.explanation && (
                  <p className="mt-2 rounded-lg bg-gray-900/60 p-3 text-sm leading-relaxed text-gray-300">
                    {feedbackQ.explanation}
                  </p>
                )}
                <div className="mt-4 flex gap-2">
                  {unanswered.length > 0 ? (
                    <button
                      onClick={nextQuestion}
                      className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500"
                    >
                      Следующий <ChevronRight className="h-4 w-4" />
                    </button>
                  ) : (
                    <button
                      onClick={finish}
                      disabled={finishing}
                      className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {finishing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : null}
                      Завершить тест
                    </button>
                  )}
                  <button
                    onClick={() => router.push("/dashboard/chat")}
                    className="flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700"
                  >
                    <MessageSquare className="h-4 w-4" /> Спросить ИИ
                  </button>
                </div>
              </div>
            )}

            {/* Все отвечены, но фидбека нет */}
            {allDone && !feedbackQ && (
              <div className="rounded-2xl border border-indigo-500/40 bg-indigo-500/10 p-6 text-center">
                <p className="mb-4 font-medium">Все вопросы отвечены!</p>
                <button
                  onClick={finish}
                  disabled={finishing}
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-2.5 font-medium hover:bg-indigo-500 disabled:opacity-50"
                >
                  {finishing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  Завершить и получить итог
                </button>
              </div>
            )}

            {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
          </>
        ) : (
          <>
            {/* ===== ИТОГИ ===== */}
            <div className="mb-6 flex items-center justify-between">
              <h1 className="flex items-center gap-2 text-2xl font-bold">
                <ListChecks className="h-6 w-6 text-indigo-400" /> Результат
                теста
              </h1>
              <button
                onClick={() => {
                  setTest(null);
                  loadHistory();
                }}
                className="flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700"
              >
                <RotateCcw className="h-4 w-4" /> Новый тест
              </button>
            </div>

            <div className="mb-4 rounded-2xl border border-indigo-500/40 bg-indigo-500/10 p-5 text-center">
              <div className="text-4xl font-bold">{test.score}%</div>
              <p className="mt-1 text-sm text-gray-400">
                {test.subject_names?.join(", ")}
              </p>
            </div>

            {test.summary && (
              <div className="mb-6 rounded-2xl border border-gray-800 bg-gray-900 p-5 text-sm leading-relaxed text-gray-300">
                {test.summary}
              </div>
            )}

            <div className="space-y-4">
              {test.questions.map((q, i) => {
                const ok = q.user_index === q.correct_index;
                return (
                  <div
                    key={q.id}
                    className={`rounded-2xl border p-5 ${ok ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}
                  >
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <p className="font-medium">
                        {i + 1}. {q.question}
                      </p>
                      {ok ? (
                        <CheckCircle2 className="h-5 w-5 shrink-0 text-green-400" />
                      ) : (
                        <XCircle className="h-5 w-5 shrink-0 text-red-400" />
                      )}
                    </div>
                    <p className="text-sm text-green-300">
                      ✓ {q.options[q.correct_index!]}
                    </p>
                    {!ok && q.user_index !== null && (
                      <p className="text-sm text-red-300">
                        ✗ Ты выбрал: {q.options[q.user_index]}
                      </p>
                    )}
                    {q.user_index === null && (
                      <p className="text-sm text-gray-500">— без ответа</p>
                    )}
                    {q.explanation && (
                      <p className="mt-2 text-sm text-gray-400">
                        {q.explanation}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    );
  }

  // ================= ЭКРАН НАСТРОЙКИ =================
  return (
    <div className="mx-auto max-w-3xl academic-assessment">
      <h1 className="mb-1 text-2xl font-bold">Тестирование</h1>
      <p className="mb-5">
        <Link href="/qtests/library" className="btn btn-secondary">
          Есть Word с готовыми вопросами? Открыть QTests{" "}
          <ArrowUpRight size={15} />
        </Link>
      </p>
      <p className="mb-8 text-gray-400">
        Выберите программу из силабуса или свои предметы и пройдите тест с
        вариантами ответов.
      </p>

      <div className="mb-6 rounded-2xl border border-gray-800 bg-gray-900 p-5">
        <LearningSourceSelector
          source={source}
          disabled={starting || Boolean(jobId)}
        />
        {!source.courseMode && (
          <>
            <p className="mb-2 text-xs uppercase text-gray-500">
              Предметы (можно несколько)
            </p>
            <div className="flex flex-wrap gap-2">
              {subjects.map((s) => {
                const on = selSubjects.includes(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => toggleSubject(s.id)}
                    className={`rounded-full border px-3 py-1.5 text-sm transition
                  ${
                    on
                      ? "border-indigo-500 bg-indigo-600/20 text-indigo-300"
                      : "border-gray-700 text-gray-400 hover:border-gray-500"
                  }`}
                  >
                    {on && "✓ "}
                    {s.name}
                  </button>
                );
              })}
              {subjects.length === 0 && (
                <p className="text-sm text-gray-500">Сначала создай предметы</p>
              )}
            </div>

            {selSubjects.length > 0 && (
              <>
                <p className="mb-2 mt-4 text-xs uppercase text-gray-500">
                  Темы (опционально — пусто = вся программа)
                </p>
                <div className="flex flex-wrap gap-2">
                  {allTopics
                    .filter((t) => selSubjects.includes(t.subject_id))
                    .map((t) => {
                      const on = selTopics.includes(t.id);
                      return (
                        <button
                          key={t.id}
                          onClick={() => toggleTopic(t.id)}
                          className={`rounded-full border px-3 py-1 text-xs transition
                        ${
                          on
                            ? "border-indigo-500 bg-indigo-600/20 text-indigo-300"
                            : "border-gray-700 text-gray-400 hover:border-gray-500"
                        }`}
                        >
                          {on && "✓ "}
                          {t.title}
                        </button>
                      );
                    })}
                </div>
              </>
            )}
          </>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            className="rounded-lg border border-gray-800 bg-gray-800 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          >
            {DIFFS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={20}
            value={count}
            onChange={(e) =>
              setCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))
            }
            className="w-16 rounded-lg border border-gray-800 bg-gray-800 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            title="Количество вопросов"
          />
          <button
            onClick={start}
            disabled={
              starting ||
              Boolean(jobId) ||
              (source.courseMode &&
                (source.loading || Boolean(source.selectionError)))
            }
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {starting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {starting || jobId ? "Составляем тест…" : "Начать тест"}
          </button>
          {error && <span className="text-sm text-red-400">{error}</span>}
        </div>
      </div>

      {notice && (
        <p className="academic-success" role="status">
          {notice}
        </p>
      )}
      <h2 className="mb-3 font-semibold">Прошлые попытки</h2>
      <div className="space-y-2">
        {history.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 p-3"
          >
            <ListChecks className="h-5 w-5 shrink-0 text-indigo-400" />
            <button
              onClick={() => openFromHistory(s)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="truncate text-sm font-medium">
                {s.source_context?.course_title ||
                  s.subject_names?.join(", ") ||
                  "Тест"}
              </div>
              <SourceContext value={s.source_context} compact />
              <div className="text-xs text-gray-500">
                {new Date(s.created_at).toLocaleString("ru", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}{" "}
                ·{" "}
                {s.status === "finished"
                  ? `${s.score}%`
                  : "не завершён — можно продолжить"}
              </div>
            </button>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                s.status === "finished"
                  ? "bg-gray-800 text-gray-300"
                  : "bg-indigo-600/20 text-indigo-300"
              }`}
            >
              {s.status === "finished" ? "завершён" : "активен"}
            </span>
            <DeleteButton
              title="Удалить попытку теста?"
              endpoint={`/tests/${s.id}`}
              onDeleted={loadHistory}
            />
          </div>
        ))}
        {history.length === 0 && (
          <p className="text-sm text-gray-500">Пока попыток не было.</p>
        )}
      </div>
    </div>
  );
}
