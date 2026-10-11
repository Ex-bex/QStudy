"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { setActivity } from "@/lib/context";
import { learningSourceActivity } from "@/lib/learning-selection";
import {
  LearningSourceSelector,
  SourceContext,
  useLearningSource,
} from "@/components/learning-source";
import { DeleteButton, errorMessage } from "@/components/academic";
import { useJobRefresh } from "@/lib/notifications";
import type { LucideIcon } from "lucide-react";
import type { ExamSession, ExamQuestion, Subject, Topic } from "@/types";
import {
  GraduationCap,
  Loader2,
  Mic,
  Square,
  Send,
  Volume2,
  VolumeX,
  ChevronRight,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RotateCcw,
  MessageSquare,
} from "lucide-react";
import ReactMarkdown from "react-markdown";

const VERDICT_UI: Record<
  string,
  { text: string; cls: string; icon: LucideIcon }
> = {
  correct: {
    text: "Верно",
    cls: "bg-green-500/20 text-green-300",
    icon: CheckCircle2,
  },
  partial: {
    text: "Частично",
    cls: "bg-yellow-500/20 text-yellow-300",
    icon: AlertCircle,
  },
  wrong: { text: "Неверно", cls: "bg-red-500/20 text-red-300", icon: XCircle },
};

const MAX_RECORD_SEC = 120;

export default function ExamPage() {
  const source = useLearningSource();
  const router = useRouter();

  // Выбор предметов/тем
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [allTopics, setAllTopics] = useState<Topic[]>([]);
  const [selSubjects, setSelSubjects] = useState<number[]>([]);
  const [selTopics, setSelTopics] = useState<number[]>([]);
  const [difficulty, setDifficulty] = useState("medium");
  const [count, setCount] = useState(5);
  const [history, setHistory] = useState<ExamSession[]>([]);

  // Экзамен
  const [exam, setExam] = useState<ExamSession | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");

  // Запись ответа
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [grading, setGrading] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [textAnswer, setTextAnswer] = useState("");
  const [soundOn, setSoundOn] = useState(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const cancelRecording = useRef(false);
  const elapsed = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const unanswered = exam?.questions.filter((q) => !q.verdict) ?? [];
  const current = unanswered[0] ?? null;
  const answeredCount = (exam?.questions.length ?? 0) - unanswered.length;

  // Загрузка: все предметы + все их темы разом
  useEffect(() => {
    mounted.current = true;
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
    loadHistory();
    return () => {
      mounted.current = false;
      cancelRecording.current = true;
      if (timerRef.current) clearInterval(timerRef.current);
      if (recorderRef.current?.state === "recording")
        recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      window.speechSynthesis?.cancel();
    };
  }, []);

  // Озвучка текущего вопроса
  useEffect(() => {
    if (exam?.status !== "active") {
      window.speechSynthesis?.cancel();
      return;
    }
    if (
      current &&
      soundOn &&
      window.speechSynthesis &&
      typeof SpeechSynthesisUtterance !== "undefined"
    ) {
      window.speechSynthesis?.cancel();
      const u = new SpeechSynthesisUtterance(current.question);
      u.lang = "ru-RU";
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    }
  }, [current, soundOn, exam?.status]);

  // Контекст для чата
  useEffect(() => {
    const names = subjects
      .filter((s) => selSubjects.includes(s.id))
      .map((s) => s.name)
      .join(", ");
    setActivity({
      page: "exam",
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
      ...(exam?.id
        ? learningSourceActivity(exam?.source_context, source.selection.use_web)
        : {}),
      exam_question:
        exam?.status === "active" ? (current?.question ?? null) : null,
    });
  }, [
    exam?.status,
    exam?.id,
    exam?.source_context,
    current,
    selSubjects,
    subjects,
    source.courseMode,
    source.selection,
  ]);

  async function loadHistory() {
    await api<ExamSession[]>("/exam")
      .then(setHistory)
      .catch((e: unknown) => setError(errorMessage(e)));
  }

  useJobRefresh("exam", loadHistory);

  function speakQuestion(text: string) {
    if (
      !soundOn ||
      !window.speechSynthesis ||
      typeof SpeechSynthesisUtterance === "undefined"
    )
      return;
    window.speechSynthesis?.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ru-RU";
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  }

  function toggleSubject(id: number) {
    setSelSubjects((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      // При снятии предмета — убрать и его темы
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
      const s = await api<ExamSession>("/exam/start", {
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
      setExam(s);
      setFeedbackFor(null);
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }

  async function startRecording() {
    setError("");
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(
          "Запись звука не поддерживается. Выберите текстовый ответ.",
        );
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      elapsed.current = 0;
      cancelRecording.current = false;
      rec.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        if (timerRef.current) clearInterval(timerRef.current);
        if (!mounted.current || cancelRecording.current) return;
        setRecording(false);
        void submitAudio(
          new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }),
        );
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setSeconds(0);
      timerRef.current = setInterval(() => {
        elapsed.current += 1;
        setSeconds(elapsed.current);
        if (elapsed.current >= MAX_RECORD_SEC) stopRecording();
      }, 1000);
    } catch (e) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Разрешите доступ к микрофону или выберите текстовый ответ."
          : errorMessage(e),
      );
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }

  async function submitAudio(blob: Blob) {
    if (!current) return;
    if (!blob.size || blob.size > 25 * 1024 * 1024) {
      setError("Запись пустая или превышает 25 МБ. Попробуйте ещё раз.");
      return;
    }
    setGrading(true);
    setError("");
    try {
      const ext = blob.type.includes("ogg")
        ? "ogg"
        : blob.type.includes("mp4")
          ? "m4a"
          : "webm";
      const fd = new FormData();
      fd.append("file", new File([blob], `answer.${ext}`, { type: blob.type }));
      const res = await api<{ question: ExamQuestion }>(
        `/exam/${exam!.id}/answer/${current.id}`,
        { method: "POST", body: fd },
      );
      updateQuestion(res.question);
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setGrading(false);
    }
  }

  async function submitText() {
    if (!current || !textAnswer.trim()) return;
    setGrading(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("text_answer", textAnswer);
      const res = await api<{ question: ExamQuestion }>(
        `/exam/${exam!.id}/answer/${current.id}`,
        { method: "POST", body: fd },
      );
      setTextAnswer("");
      updateQuestion(res.question);
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setGrading(false);
    }
  }

  function updateQuestion(q: ExamQuestion) {
    setExam((prev) =>
      prev
        ? {
            ...prev,
            questions: prev.questions.map((x) => (x.id === q.id ? q : x)),
          }
        : prev,
    );
    setFeedbackFor(q.id);
    window.speechSynthesis?.cancel();
  }

  async function finish() {
    setFinishing(true);
    try {
      const s = await api<ExamSession>(`/exam/${exam!.id}/finish`, {
        method: "POST",
      });
      setExam(s);
      setFeedbackFor(null);
      window.speechSynthesis?.cancel();
      loadHistory();
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setFinishing(false);
    }
  }

  async function openFromHistory(s: ExamSession) {
    try {
      const full = await api<ExamSession>(`/exam/${s.id}`);
      setExam(full);
      setFeedbackFor(null);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function exitExam() {
    if (
      exam?.status === "active" &&
      !confirm("Выйти? Экзамен можно будет продолжить из истории")
    )
      return;
    cancelRecording.current = true;
    stopRecording();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    window.speechSynthesis?.cancel();
    setExam(null);
    loadHistory();
  }

  const feedbackQ = exam?.questions.find((q) => q.id === feedbackFor) ?? null;
  const allDone = exam?.status === "active" && unanswered.length === 0;
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div className="mx-auto max-w-3xl academic-assessment">
      {exam && <SourceContext value={exam.source_context} />}
      {/* ===== ЭКЗАМЕН АКТИВЕН ===== */}
      {exam && exam.status === "active" && (
        <div className="flex h-full flex-col">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-bold">
                <GraduationCap className="h-6 w-6 text-indigo-400" /> Экзамен
              </h1>
              <p className="text-sm text-gray-400">
                {exam.subject_names?.join(", ")} · Вопрос{" "}
                {Math.min(answeredCount + 1, exam.questions.length)} из{" "}
                {exam.questions.length}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSoundOn(!soundOn)}
                className="rounded-lg bg-gray-800 p-2 hover:bg-gray-700"
                title={soundOn ? "Озвучка включена" : "Озвучка выключена"}
              >
                {soundOn ? (
                  <Volume2 className="h-4 w-4" />
                ) : (
                  <VolumeX className="h-4 w-4 text-gray-500" />
                )}
              </button>
              <button
                onClick={exitExam}
                disabled={grading}
                className="rounded-lg bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700"
              >
                Прервать
              </button>
            </div>
          </div>

          <div className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
            <div
              className="h-full bg-indigo-500 transition-all"
              style={{
                width: `${(answeredCount / Math.max(1, exam.questions.length)) * 100}%`,
              }}
            />
          </div>

          {/* Текущий вопрос */}
          {current && (
            <div className="mb-6 rounded-2xl border border-gray-800 bg-gray-900 p-6">
              <div className="mb-1 flex items-start justify-between gap-3">
                <p className="text-xs uppercase text-gray-500">
                  {exam.difficulty}
                </p>
                <button
                  onClick={() => router.push("/dashboard/chat")}
                  title="Спросить ИИ об этом вопросе"
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700"
                >
                  <MessageSquare className="h-3.5 w-3.5" /> Спросить ИИ
                </button>
              </div>
              <p className="text-lg leading-relaxed">{current.question}</p>
              <button
                onClick={() => speakQuestion(current.question)}
                className="mt-3 flex items-center gap-1 text-xs text-indigo-400/80 hover:text-indigo-300"
              >
                <Volume2 className="h-3.5 w-3.5" /> Повторить вопрос
              </button>
            </div>
          )}

          {/* Фидбек на последний ответ */}
          {feedbackQ && (
            <div
              className={`mb-6 rounded-2xl border p-5 ${
                feedbackQ.verdict === "correct"
                  ? "border-green-500/40 bg-green-500/10"
                  : feedbackQ.verdict === "partial"
                    ? "border-yellow-500/40 bg-yellow-500/10"
                    : "border-red-500/40 bg-red-500/10"
              }`}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-2 font-semibold">
                  {(() => {
                    const I = VERDICT_UI[feedbackQ.verdict].icon;
                    return <I className="h-5 w-5" />;
                  })()}
                  {VERDICT_UI[feedbackQ.verdict]?.text}
                </span>
                <span className="text-sm text-gray-300">
                  {feedbackQ.score}/100
                </span>
              </div>
              <p className="mb-3 text-sm leading-relaxed text-gray-300">
                {feedbackQ.feedback}
              </p>
              {feedbackQ.reference && (
                <details className="text-sm text-gray-400">
                  <summary className="cursor-pointer hover:text-gray-300">
                    Эталонный ответ
                  </summary>
                  <p className="mt-2 leading-relaxed">{feedbackQ.reference}</p>
                </details>
              )}
            </div>
          )}

          {/* Ответ голосом / текстом */}
          {current && !feedbackQ && (
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6">
              {!textMode ? (
                <div className="flex flex-col items-center">
                  {grading ? (
                    <>
                      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gray-800">
                        <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
                      </div>
                      <p className="mt-3 text-sm text-gray-400">
                        Расшифровываем и оцениваем...
                      </p>
                    </>
                  ) : recording ? (
                    <>
                      <button
                        onClick={stopRecording}
                        className="flex h-20 w-20 animate-pulse items-center justify-center rounded-full bg-red-600 hover:bg-red-500"
                      >
                        <Square className="h-8 w-8" />
                      </button>
                      <p className="mt-3 font-mono text-xl text-red-400">
                        {mm}:{ss}
                      </p>
                      <p className="text-xs text-gray-500">
                        Говори свой ответ, потом нажми стоп
                      </p>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={startRecording}
                        className="flex h-20 w-20 items-center justify-center rounded-full bg-indigo-600 hover:bg-indigo-500"
                      >
                        <Mic className="h-8 w-8" />
                      </button>
                      <p className="mt-3 text-sm text-gray-400">
                        Нажми и отвечай голосом
                      </p>
                    </>
                  )}
                  <button
                    onClick={() => setTextMode(true)}
                    className="mt-4 text-xs text-gray-500 hover:text-gray-300"
                  >
                    или ответить текстом
                  </button>
                </div>
              ) : (
                <div>
                  <textarea
                    maxLength={20000}
                    value={textAnswer}
                    onChange={(e) => setTextAnswer(e.target.value)}
                    rows={4}
                    placeholder="Пиши ответ как на письменном экзамене..."
                    disabled={grading}
                    className="w-full resize-none rounded-xl border border-gray-800 bg-gray-950 p-3 text-sm outline-none focus:border-indigo-500 disabled:opacity-60"
                  />
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={submitText}
                      disabled={grading || !textAnswer.trim()}
                      className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {grading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      Отправить
                    </button>
                    <button
                      onClick={() => setTextMode(false)}
                      className="rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
                    >
                      Ответить голосом
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Все отвечены */}
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
                {finishing ? "Составляем итог..." : "Завершить и получить итог"}
              </button>
            </div>
          )}

          {/* После фидбека — дальше */}
          {feedbackQ && !allDone && (
            <button
              onClick={() => {
                setFeedbackFor(null);
                if (current) speakQuestion(current.question);
              }}
              className="flex items-center gap-2 self-end rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium hover:bg-indigo-500"
            >
              Следующий вопрос <ChevronRight className="h-4 w-4" />
            </button>
          )}
          {feedbackQ && allDone && (
            <button
              onClick={finish}
              disabled={finishing}
              className="flex items-center gap-2 self-end rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {finishing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Завершить и получить итог
            </button>
          )}

          {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
        </div>
      )}

      {/* ===== ИТОГИ ===== */}
      {exam && exam.status === "finished" && (
        <div>
          <div className="mb-6 flex items-center justify-between">
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <GraduationCap className="h-6 w-6 text-indigo-400" /> Результат
              экзамена
            </h1>
            <button
              onClick={() => {
                setExam(null);
                loadHistory();
              }}
              className="flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700"
            >
              <RotateCcw className="h-4 w-4" /> Новый экзамен
            </button>
          </div>

          {exam.summary && (
            <div className="prose prose-invert mb-6 max-w-none rounded-2xl border border-indigo-500/30 bg-indigo-500/5 p-5 text-sm">
              <ReactMarkdown>{exam.summary}</ReactMarkdown>
            </div>
          )}

          <div className="space-y-4">
            {exam.questions.map((q, i) => {
              const v = VERDICT_UI[q.verdict] ?? VERDICT_UI.wrong;
              return (
                <div
                  key={q.id}
                  className="rounded-2xl border border-gray-800 bg-gray-900 p-5"
                >
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <p className="font-medium">
                      {i + 1}. {q.question}
                    </p>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${v.cls}`}
                    >
                      {q.score}/100
                    </span>
                  </div>
                  <p className="mb-2 text-sm text-gray-400">
                    Твой ответ: {q.user_answer || "—"}
                  </p>
                  {q.reference && (
                    <p className="mb-2 text-sm text-gray-400">
                      Эталон: {q.reference}
                    </p>
                  )}
                  <p className="text-sm text-gray-300">{q.feedback}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ===== НАСТРОЙКА + ИСТОРИЯ ===== */}
      {!exam && (
        <div>
          <h1 className="mb-1 text-2xl font-bold">Экзаменатор</h1>
          <p className="mb-8 text-gray-400">
            Отвечайте текстом или голосом. Выберите программу из силабуса или
            несколько своих предметов.
          </p>

          <div className="mb-8 rounded-2xl border border-gray-800 bg-gray-900 p-5">
            <LearningSourceSelector source={source} disabled={starting} />
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
                    <p className="text-sm text-gray-500">
                      Сначала создай предметы
                    </p>
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
                <option value="easy">Легко</option>
                <option value="medium">Средне</option>
                <option value="hard">Сложно</option>
              </select>
              <input
                type="number"
                min={1}
                max={10}
                value={count}
                onChange={(e) =>
                  setCount(
                    Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                  )
                }
                className="w-16 rounded-lg border border-gray-800 bg-gray-800 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                title="Количество вопросов"
              />
              <button
                onClick={start}
                disabled={
                  starting ||
                  (source.courseMode &&
                    (source.loading || Boolean(source.selectionError)))
                }
                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
              >
                {starting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <GraduationCap className="h-4 w-4" />
                )}
                {starting ? "Готовим вопросы..." : "Начать экзамен"}
              </button>
              {error && <span className="text-sm text-red-400">{error}</span>}
            </div>
          </div>

          <h2 className="mb-3 font-semibold">Прошлые попытки</h2>
          <div className="space-y-2">
            {history.map((s) => {
              const answered = s.questions.filter((q) => q.verdict);
              const avg = answered.length
                ? Math.round(
                    answered.reduce((a, q) => a + q.score, 0) / answered.length,
                  )
                : 0;
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 p-3"
                >
                  <GraduationCap className="h-5 w-5 shrink-0 text-indigo-400" />
                  <button
                    onClick={() => openFromHistory(s)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-sm font-medium">
                      {s.source_context?.course_title ||
                        s.subject_names?.join(", ") ||
                        "Экзамен"}{" "}
                      · {s.difficulty}
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
                        ? `средний балл ${avg}`
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
                    title="Удалить попытку экзамена?"
                    endpoint={`/exam/${s.id}`}
                    onDeleted={loadHistory}
                  />
                </div>
              );
            })}
            {history.length === 0 && (
              <p className="text-sm text-gray-500">Пока попыток не было.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
