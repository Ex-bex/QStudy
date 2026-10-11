"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  MessageSquare,
  Pencil,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { api } from "@/lib/api";
import { setActivity } from "@/lib/context";
import { SourceContext } from "@/components/learning-source";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Empty,
  Loading,
  DeleteButton,
  errorMessage,
} from "@/components/academic";
import type { Lecture, ChatMessage, JobNotification } from "@/types";

export default function LecturePage() {
  const { subjectId, topicId } = useParams<{
    subjectId: string;
    topicId: string;
  }>();
  const router = useRouter();
  const {
    data: lecture,
    loading,
    error: loadError,
    reload,
  } = useResource<Lecture>(`/lectures/topic/${topicId}`);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [useWeb, setUseWeb] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const chatBottom = useRef<HTMLDivElement>(null);
  const tempId = useRef(0);
  const generating = Boolean(jobId) || lecture?.status === "generating";
  useEffect(() => {
    if (lecture)
      setActivity({
        page: "lectures",
        subject: lecture.subject_name,
        topic: lecture.topic_title,
        lecture: {
          title: lecture.topic_title || "",
          content: lecture.content.slice(0, 9000),
        },
      });
  }, [lecture]);
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [generating, reload]);
  useEffect(() => {
    const done = (event: Event) => {
      const job = (event as CustomEvent<JobNotification>).detail;
      if (job.kind !== "lecture" || (jobId && job.id !== jobId)) return;
      if (job.status === "error")
        setError(
          job.error || "Не удалось составить лекцию. Повторите попытку.",
        );
      setJobId(null);
      void reload();
    };
    window.addEventListener("qstudy:job", done);
    return () => window.removeEventListener("qstudy:job", done);
  }, [jobId, reload]);
  useEffect(() => {
    chatBottom.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [messages, chatSending]);
  async function generate() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ job_id: string }>(
        `/lectures/topic/${topicId}/generate`,
        { method: "POST", body: JSON.stringify({ use_web: useWeb }) },
      );
      setJobId(result.job_id);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(`/lectures/topic/${topicId}`, {
        method: "PATCH",
        body: JSON.stringify({ content }),
      });
      await reload();
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function sendChat() {
    const text = chatInput.trim();
    if (!text || chatSending || !lecture) return;
    setChatInput("");
    setChatSending(true);
    setError("");
    const id = --tempId.current;
    setMessages((previous) => [
      ...previous,
      {
        id,
        session_id: sessionId || 0,
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
      },
    ]);
    try {
      const result = await api<{
        session_id: number;
        user_message: ChatMessage;
        assistant_message: ChatMessage;
      }>("/chat/send", {
        method: "POST",
        body: JSON.stringify({
          use_web: useWeb,
          session_id: sessionId,
          message: text,
          context: {
            page: "lectures",
            subject: lecture.subject_name,
            lecture: {
              title: lecture.topic_title || "",
              content: lecture.content.slice(0, 9000),
            },
          },
        }),
      });
      setSessionId(result.session_id);
      setMessages((previous) => [
        ...previous.filter((message) => message.id !== id),
        result.user_message,
        result.assistant_message,
      ]);
    } catch (e) {
      setMessages((previous) =>
        previous.filter((message) => message.id !== id),
      );
      setChatInput(text);
      setError(errorMessage(e));
    } finally {
      setChatSending(false);
    }
  }
  if (loading) return <Loading />;
  if (!lecture)
    return (
      <div>
        <ErrorNotice message={loadError || "Лекция не найдена"} />
        <Link
          className="btn btn-secondary"
          href={`/dashboard/lectures/${subjectId}`}
        >
          К списку лекций
        </Link>
      </div>
    );
  return (
    <div>
      <Link
        className="academic-breadcrumb"
        href={`/dashboard/lectures/${subjectId}`}
      >
        <ArrowLeft size={14} /> Все темы предмета
      </Link>
      <PageTitle
        eyebrow={lecture.subject_name || "ЛИЧНАЯ ЛЕКЦИЯ"}
        title={lecture.topic_title || "Лекция"}
        description={`Материалов по теме: ${lecture.materials_count || 0}. Вы можете составить лекцию с ИИ или написать свой конспект.`}
      >
        <button
          className="btn btn-primary"
          disabled={busy || generating || editing}
          onClick={generate}
        >
          <RefreshCw size={15} />
          {generating
            ? "Составляем…"
            : lecture.content
              ? "Обновить с ИИ"
              : "Создать с ИИ"}
        </button>
        <button
          className="btn btn-secondary"
          disabled={busy || generating || editing}
          onClick={() => {
            setContent(lecture.content);
            setEditing(true);
          }}
        >
          <Pencil size={15} />
          {lecture.content ? "Редактировать" : "Написать вручную"}
        </button>
        <DeleteButton
          title="Удалить личную лекцию?"
          description="Ваш конспект будет удалён. Общая тема предмета останется."
          disabled={busy || generating}
          endpoint={`/lectures/topic/${topicId}`}
          onDeleted={() => router.push(`/dashboard/lectures/${subjectId}`)}
        />
      </PageTitle>
      <ErrorNotice message={error || loadError} />
      <label
        style={{
          display: "flex",
          gap: 9,
          alignItems: "center",
          fontSize: 13,
          marginBottom: 15,
        }}
      >
        <input
          type="checkbox"
          checked={useWeb}
          disabled={busy || generating || chatSending}
          onChange={(event) => setUseWeb(event.target.checked)}
        />
        Интернет: актуальные источники
      </label>
      <SourceContext value={lecture.source_context} />
      {lecture.stale && (
        <p className="academic-feedback" style={{ marginBottom: 22 }}>
          Материалы темы изменились. При необходимости обновите конспект.
        </p>
      )}
      {lecture.status === "error" && !error && (
        <ErrorNotice message="Предыдущую генерацию не удалось завершить. Ваш сохранённый текст доступен ниже; можно повторить попытку." />
      )}
      <div className="academic-lecture-layout">
        <section className="panel" style={{ minWidth: 0 }}>
          {generating ? (
            <>
              <Loading />
              <p
                className="muted"
                style={{ textAlign: "center", fontSize: 12 }}
              >
                ИИ готовит лекцию. Страница обновится после завершения; можно
                продолжать работу в других разделах.
              </p>
            </>
          ) : editing ? (
            <div className="academic-stack">
              <label className="academic-field">
                <span>Текст лекции · поддерживается Markdown</span>
                <textarea
                  className="field"
                  rows={24}
                  maxLength={150000}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  style={{ fontFamily: "Consolas, monospace" }}
                />
              </label>
              <div className="academic-actions">
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={save}
                >
                  <Save size={15} />
                  {busy ? "Сохраняем…" : "Сохранить"}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => setEditing(false)}
                >
                  <X size={15} /> Отмена
                </button>
              </div>
            </div>
          ) : lecture.content ? (
            <div className="academic-markdown">
              <ReactMarkdown>{lecture.content}</ReactMarkdown>
            </div>
          ) : (
            <Empty title="Лекция пока не создана">
              <Sparkles size={30} style={{ margin: "15px auto" }} />
              Добавьте материалы по теме и попросите ИИ собрать конспект или
              напишите его самостоятельно.
            </Empty>
          )}
        </section>
        <aside className="panel academic-lecture-chat">
          <div className="academic-chat-header">
            <MessageSquare size={17} />
            <strong>Разобрать лекцию</strong>
          </div>
          <div className="academic-chat-messages" aria-live="polite">
            {!messages.length && (
              <div className="academic-stack">
                <p className="muted" style={{ fontSize: 12 }}>
                  Задайте вопрос по тексту этой лекции.
                </p>
                {[
                  "Объясни главную идею простыми словами",
                  "Покажи пример по этой теме",
                  "Задай мне вопрос для самопроверки",
                ].map((prompt) => (
                  <button
                    className="btn btn-secondary"
                    style={{ textAlign: "left", justifyContent: "flex-start" }}
                    key={prompt}
                    onClick={() => setChatInput(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
            {messages.map((message) => (
              <div
                className={`academic-message ${message.role === "user" ? "from-user" : "from-assistant"}`}
                key={message.id}
              >
                <div className="academic-message-content">
                  {message.role === "user" ? (
                    <p style={{ whiteSpace: "pre-wrap" }}>{message.content}</p>
                  ) : (
                    <>
                      <ReactMarkdown>{message.content}</ReactMarkdown>
                      <SourceContext value={message.source_context} />
                    </>
                  )}
                </div>
              </div>
            ))}
            {chatSending && (
              <p className="muted" style={{ fontSize: 12 }}>
                Готовим объяснение…
              </p>
            )}
            <div ref={chatBottom} />
          </div>
          <div className="academic-chat-composer">
            <textarea
              className="field"
              aria-label="Вопрос по лекции"
              rows={2}
              maxLength={12000}
              value={chatInput}
              disabled={chatSending}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void sendChat();
                }
              }}
              placeholder="Что хотите уточнить?"
            />
            <button
              className="btn btn-primary"
              aria-label="Отправить вопрос"
              disabled={chatSending || !chatInput.trim()}
              onClick={sendChat}
            >
              <Send size={15} />
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
