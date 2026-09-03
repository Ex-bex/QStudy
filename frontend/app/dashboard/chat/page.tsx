"use client";
import { getActivity } from "@/lib/context";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ChatSession, ChatMessage } from "@/types";
import { Plus, Send, Mic, Square, Loader2, Trash2, MessageSquare } from "lucide-react";
import ReactMarkdown from "react-markdown";

const STARTERS = [
  "Повтори кратко, что было в моих материалах по последней теме",
  "Объясни простыми словами: в чём суть моей темы?",
  "Проверь меня: задай 3 вопроса по предмету",
  "Как дела? Расскажи что-нибудь интересное",
];

export default function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const draftKey = activeId ? `chat_draft_${activeId}` : "chat_draft_new";
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<ChatSession[]>("/chat/sessions").then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);
useEffect(() => {
  setInput(localStorage.getItem(draftKey) ?? "");
}, [draftKey]);

// Сохранение при каждом изменении ввода
useEffect(() => {
  localStorage.setItem(draftKey, input);
}, [input, draftKey]);

  async function openSession(id: number) {
    if (sending || recording) return;
    setActiveId(id);
    setMessages([]);
    try {
      const msgs = await api<ChatMessage[]>(`/chat/sessions/${id}/messages`);
      setMessages(msgs);
    } catch (e: any) {
      alert(e.message);
    }
  }

  function newChat() {
    if (sending || recording) return;
    setActiveId(null);
    setMessages([]);
  }

  async function deleteSession(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Удалить чат?")) return;
    await api(`/chat/sessions/${id}`, { method: "DELETE" });
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeId === id) {
      setActiveId(null);
      setMessages([]);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || sending || recording) return;
    setInput("");
    setSending(true);
    const tempId = -Date.now();
    setMessages((prev) => [
      ...prev,
      { id: tempId, session_id: activeId ?? 0, role: "user", content: text, created_at: new Date().toISOString() },
    ]);
    try {
      const res = await api<{
        session_id: number;
        session_title: string;
        user_message: ChatMessage;
        assistant_message: ChatMessage;
      }>("/chat/send", {
        method: "POST",
        body: JSON.stringify({
          session_id: activeId,
          message: text,
          context: getActivity() ?? undefined,
        }),
      });
      if (!activeId) {
        setActiveId(res.session_id);
        setSessions((prev) => [
          { id: res.session_id, title: res.session_title, created_at: new Date().toISOString() },
          ...prev,
        ]);
      }
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempId),
        {
          id: res.user_message?.id ?? Date.now(),
          session_id: res.session_id,
          role: "user",
          content: text,
          created_at: new Date().toISOString(),
        },
        res.assistant_message,
      ]);
    } catch (e: any) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInput(text);
      alert(e.message);
    } finally {
      setSending(false);
    }
  }
  useEffect(() => {
    const act = getActivity();
    if (act?.task) {
      setInput(`Не понимаю вопрос: «${act.task.question}». Объясни, с чего начать`);
    } else if (act?.exam_question) {
      setInput(`Не понимаю экзаменационный вопрос: «${act.exam_question}». Объясни, с чего начать`);
    }
  }, []);
  async function toggleMic() {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        setTranscribing(true);
        try {
          const ext = blob.type.includes("ogg") ? "ogg" : "webm";
          const fd = new FormData();
          fd.append("file", new File([blob], `voice.${ext}`, { type: blob.type }));
          const res = await api<{ text: string }>("/chat/transcribe", { method: "POST", body: fd });
          setInput((prev) => (prev ? prev + " " : "") + res.text);
        } catch (e: any) {
          alert(e.message);
        } finally {
          setTranscribing(false);
        }
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch {
      alert("Нет доступа к микрофону. Разреши доступ в браузере.");
    }
  }

  return (
    <div className="flex h-full gap-6">
      {/* Список чатов */}
      <div className="flex w-64 shrink-0 flex-col">
        <button
          onClick={newChat}
          className="mb-4 flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" /> Новый чат
        </button>
        <div className="flex-1 space-y-1 overflow-y-auto">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => openSession(s.id)}
              className={`group w-full rounded-lg px-3 py-2 text-left text-sm transition
                ${activeId === s.id ? "bg-indigo-600/20 text-indigo-300" : "hover:bg-gray-800"}`}
            >
              <div className="flex items-center gap-2">
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                <span className="truncate">{s.title}</span>
                <span
                  onClick={(e) => deleteSession(s.id, e)}
                  className="ml-auto hidden text-gray-500 hover:text-red-400 group-hover:block"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="px-3 text-sm text-gray-500">Чатов пока нет</p>
          )}
        </div>
      </div>

      {/* Окно чата */}
      <div className="flex flex-1 flex-col rounded-2xl border border-gray-800 bg-gray-900">
        {/* Сообщения */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {messages.length === 0 && !sending && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <MessageSquare className="mb-3 h-10 w-10 text-gray-600" />
              <p className="mb-1 font-medium">Спроси что угодно</p>
              <p className="mb-6 text-sm text-gray-500">
                Я вижу твои материалы и заметки — и просто поболтать тоже могу
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setInput(s)}
                    className="rounded-full border border-gray-700 px-3 py-1.5 text-xs text-gray-300 transition hover:border-indigo-500 hover:text-indigo-300"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed
                  ${m.role === "user"
                    ? "rounded-br-md bg-indigo-600"
                    : "rounded-bl-md bg-gray-800"}`}
              >
                {m.role === "user" ? (
                  <p className="whitespace-pre-wrap">{m.content}</p>
                ) : (
                  <div className="prose prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-li:my-0">
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          ))}

          {sending && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-gray-800 px-4 py-3">
                <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
                <span className="text-sm text-gray-400">Думаю...</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Ввод */}
        <div className="flex items-end gap-2 border-t border-gray-800 p-4">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder="Напиши сообщение... (Enter — отправить)"
            className="max-h-40 flex-1 resize-none rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 text-sm outline-none focus:border-indigo-500"
          />
          <button
            onClick={toggleMic}
            disabled={transcribing || sending}
            title="Голосовой ввод"
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition disabled:opacity-50
              ${recording ? "animate-pulse bg-red-600 hover:bg-red-500" : "bg-gray-800 hover:bg-gray-700"}`}
          >
            {transcribing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : recording ? (
              <Square className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </button>
          <button
            onClick={send}
            disabled={!input.trim() || sending || recording}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}