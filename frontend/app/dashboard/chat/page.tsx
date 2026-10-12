"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquare, Mic, Plus, Send, Sparkles, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { api } from "@/lib/api";
import { getActivity, learningActivityContext } from "@/lib/context";
import {
  LearningSourceSelector,
  SourceContext,
  useLearningSource,
} from "@/components/learning-source";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Loading,
  RecordEditor,
  DeleteButton,
  errorMessage,
} from "@/components/academic";
import type { ChatSession, ChatMessage } from "@/types";

const starters = [
  "Объясни мою текущую тему простыми словами",
  "Помоги составить план подготовки к экзамену",
  "Задай мне три вопроса по моим материалам",
  "Кратко перескажи мои учебные материалы",
];
export default function ChatPage() {
  const source = useLearningSource(true);
  const {
    data: sessions,
    loading,
    error: loadError,
    reload,
    setData: setSessions,
  } = useResource<ChatSession[]>("/chat/sessions");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [creating, setCreating] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const optimisticId = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const drafts = useRef<Record<string, string>>({});
  const busy =
    sending || recording || transcribing || loadingMessages || creating;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (recorderRef.current?.state === "recording")
        recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, sending]);
  function changeInput(value: string) {
    setInput(value);
    drafts.current[String(activeId || "new")] = value;
  }
  async function openSession(id: number) {
    if (busy) return;
    setActiveId(id);
    setMessages([]);
    setInput(drafts.current[String(id)] || "");
    setLoadingMessages(true);
    setError("");
    try {
      setMessages(await api<ChatMessage[]>(`/chat/sessions/${id}/messages`));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMessages(false);
    }
  }
  async function newChat() {
    if (busy) return;
    setCreating(true);
    setError("");
    try {
      const session = await api<ChatSession>("/chat/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "Новый диалог" }),
      });
      setSessions((previous) => [session, ...(previous || [])]);
      setActiveId(session.id);
      setInput("");
      setMessages([]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  }
  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    if (source.courseMode && source.selectionError) {
      setError(source.selectionError);
      return;
    }
    setError("");
    setSending(true);
    changeInput("");
    const tempId = --optimisticId.current;
    setMessages((previous) => [
      ...previous,
      {
        id: tempId,
        session_id: activeId || 0,
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
      },
    ]);
    try {
      const result = await api<{
        session_id: number;
        session_title: string;
        user_message: ChatMessage;
        assistant_message: ChatMessage;
      }>("/chat/send", {
        method: "POST",
        body: JSON.stringify({
          ...source.payload,
          session_id: activeId,
          message: text,
          context: learningActivityContext(getActivity(), source.payload),
        }),
      });
      if (!activeId) setActiveId(result.session_id);
      setMessages((previous) => [
        ...previous.filter((message) => message.id !== tempId),
        result.user_message,
        result.assistant_message,
      ]);
      await reload();
    } catch (e) {
      setMessages((previous) =>
        previous.filter((message) => message.id !== tempId),
      );
      changeInput(text);
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }
  async function toggleMic() {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      return;
    }
    setError("");
    try {
      if (!window.isSecureContext)
        throw new Error(
          "Запись с микрофона недоступна при подключении по HTTP. Используйте текстовый ввод или загрузите аудиофайл в разделе файлов.",
        );
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(
          "Этот браузер не поддерживает запись звука. Используйте текстовый ввод.",
        );
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (!mounted.current) return;
        setRecording(false);
        setTranscribing(true);
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        try {
          const ext = blob.type.includes("ogg")
            ? "ogg"
            : blob.type.includes("mp4")
              ? "m4a"
              : "webm";
          const form = new FormData();
          form.append(
            "file",
            new File([blob], `voice.${ext}`, { type: blob.type }),
          );
          const result = await api<{ text: string }>("/chat/transcribe", {
            method: "POST",
            body: form,
          });
          if (mounted.current)
            setInput((previous) => {
              const value = `${previous}${previous ? " " : ""}${result.text}`;
              drafts.current[String(activeId || "new")] = value;
              return value;
            });
        } catch (e) {
          if (mounted.current) setError(errorMessage(e));
        } finally {
          if (mounted.current) setTranscribing(false);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      timeoutRef.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 120000);
    } catch (e) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Разрешите доступ к микрофону в настройках браузера."
          : errorMessage(e),
      );
    }
  }
  return (
    <div>
      <PageTitle
        eyebrow="ПОДДЕРЖКА В ОБУЧЕНИИ"
        title="ИИ-помощник"
        description="Разбирайте сложные темы и задавайте вопросы по своим материалам."
      />
      <ErrorNotice message={error || loadError} />
      <div className="panel" style={{ padding: 20, marginBottom: 20 }}>
        <LearningSourceSelector source={source} disabled={busy} />
      </div>
      <div className="study-split academic-chat">
        <aside className="study-list">
          <button
            className="btn btn-primary"
            style={{ width: "100%", marginBottom: 19 }}
            disabled={busy}
            onClick={newChat}
          >
            <Plus size={16} />
            {creating ? "Создаём…" : "Новый диалог"}
          </button>
          {loading ? (
            <Loading />
          ) : (
            <div className="academic-chat-list">
              {sessions?.map((session) => (
                <div
                  key={session.id}
                  className={`academic-chat-session ${activeId === session.id ? "active" : ""}`}
                >
                  <button
                    className="academic-chat-session-title"
                    disabled={busy}
                    onClick={() => openSession(session.id)}
                  >
                    <MessageSquare size={15} />
                    <span>{session.title}</span>
                  </button>
                  <div className="academic-actions">
                    <RecordEditor
                      disabled={busy}
                      compact
                      title="Переименовать диалог"
                      fields={[
                        { name: "title", label: "Название", required: true },
                      ]}
                      initial={{ title: session.title }}
                      method="PATCH"
                      endpoint={`/chat/sessions/${session.id}`}
                      onSaved={reload}
                    />
                    <DeleteButton
                      disabled={busy}
                      title="Удалить диалог?"
                      description="Все сообщения этого диалога будут удалены."
                      endpoint={`/chat/sessions/${session.id}`}
                      onDeleted={async () => {
                        delete drafts.current[String(session.id)];
                        if (activeId === session.id) {
                          setActiveId(null);
                          setMessages([]);
                          setInput("");
                        }
                        await reload();
                      }}
                    />
                  </div>
                </div>
              ))}
              {!sessions?.length && (
                <p className="muted" style={{ fontSize: 12, padding: 15 }}>
                  Ваши диалоги появятся здесь.
                </p>
              )}
            </div>
          )}
        </aside>
        <section className="panel study-editor academic-chat-window">
          <div className="academic-chat-header">
            <span
              className="academic-card-icon"
              style={{ width: 33, height: 33, borderRadius: 10 }}
            >
              <Sparkles size={17} />
            </span>
            <div>
              <strong>QStudy AI</strong>
              <p className="muted">Ваш помощник в учёбе</p>
            </div>
          </div>
          <div className="academic-chat-messages" aria-live="polite">
            {loadingMessages ? (
              <Loading />
            ) : messages.length === 0 && !sending ? (
              <div className="academic-chat-empty">
                <div
                  className="academic-card-icon"
                  style={{ width: 60, height: 60, borderRadius: 20 }}
                >
                  <Sparkles size={28} />
                </div>
                <h2>С чего начнём?</h2>
                <p className="muted">
                  Задайте вопрос или выберите отправную точку.
                </p>
                <div className="academic-chat-starters">
                  {starters.map((starter) => (
                    <button key={starter} onClick={() => changeInput(starter)}>
                      {starter}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={`academic-message ${message.role === "user" ? "from-user" : "from-assistant"}`}
                >
                  <div className="academic-message-content">
                    {message.role === "user" ? (
                      <p style={{ whiteSpace: "pre-wrap" }}>
                        {message.content}
                      </p>
                    ) : (
                      <>
                        <ReactMarkdown>{message.content}</ReactMarkdown>
                        <SourceContext value={message.source_context} />
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
            {sending && (
              <div className="academic-message from-assistant">
                <div className="academic-message-content muted">
                  Готовим ответ…
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="academic-chat-composer">
            <label style={{ flex: 1, minWidth: 0 }}>
              <span className="sr-only">Сообщение</span>
              <textarea
                className="field"
                value={input}
                maxLength={12000}
                disabled={sending || loadingMessages}
                onChange={(e) => changeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder={
                  recording
                    ? "Запись… Нажмите стоп, когда закончите."
                    : transcribing
                      ? "Распознаём речь…"
                      : "Напишите сообщение…"
                }
              />
            </label>
            <button
              className={`btn ${recording ? "btn-danger" : "btn-secondary"}`}
              aria-label={
                recording ? "Остановить запись" : "Записать голосовое сообщение"
              }
              title={recording ? "Остановить запись" : "Голосовой ввод"}
              disabled={transcribing || sending || loadingMessages || creating}
              onClick={toggleMic}
            >
              {recording ? <Square size={17} /> : <Mic size={17} />}
            </button>
            <button
              className="btn btn-primary"
              aria-label="Отправить сообщение"
              title="Отправить"
              disabled={
                busy ||
                !input.trim() ||
                (source.courseMode &&
                  (source.loading || Boolean(source.selectionError)))
              }
              onClick={send}
            >
              <Send size={17} />
            </button>
          </div>
          <p className="muted" style={{ fontSize: 10, padding: "0 20px 16px" }}>
            ИИ может ошибаться. Проверяйте важные факты по учебным материалам.
          </p>
        </section>
      </div>
    </div>
  );
}
