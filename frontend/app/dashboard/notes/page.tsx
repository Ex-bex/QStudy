"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { api } from "@/lib/api";
import type { Note, Subject, Topic } from "@/types";
import { Plus, Trash2, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { setActivity } from "@/lib/context";
export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    content: "",
    subject_id: null as number | null,
    topic_id: null as number | null,
  });
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipAutosave = useRef(true);

  const loadNotes = useCallback(async () => {
    const list = await api<Note[]>("/notes");
    setNotes(list);
    return list;
  }, []);

  useEffect(() => {
    loadNotes().catch(() => {});
    api<Subject[]>("/subjects").then(setSubjects).catch(() => {});
  }, [loadNotes]);

  // Загрузка тем при смене предмета
  useEffect(() => {
    if (!draft.subject_id) {
      setTopics([]);
      return;
    }
    api<Topic[]>(`/subjects/${draft.subject_id}/topics`).then(setTopics).catch(() => {});
  }, [draft.subject_id]);
useEffect(() => {
  setActivity({
    page: "notes",
    subject: subjects.find((s) => s.id === draft.subject_id)?.name,
    topic: topics.find((t) => t.id === draft.topic_id)?.title,
  });
}, [draft.subject_id, draft.topic_id, subjects, topics]);
  function selectNote(n: Note) {
    skipAutosave.current = true;
    setSelectedId(n.id);
    setDraft({
      title: n.title,
      content: n.content,
      subject_id: n.subject_id,
      topic_id: n.topic_id,
    });
  }

  function newNote() {
    skipAutosave.current = true;
    setSelectedId(null);
    setDraft({ title: "", content: "", subject_id: null, topic_id: null });
  }

  async function save() {
    setSaving(true);
    try {
      if (selectedId) {
        const updated = await api<Note>(`/notes/${selectedId}`, {
          method: "PATCH",
          body: JSON.stringify(draft),
        });
        setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
      } else {
        const created = await api<Note>("/notes", {
          method: "POST",
          body: JSON.stringify({ ...draft, title: draft.title || "Без названия" }),
        });
        setNotes((prev) => [created, ...prev]);
        setSelectedId(created.id);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  // Автосохранение через 1.2с после остановки ввода
  useEffect(() => {
    if (skipAutosave.current) {
      skipAutosave.current = false;
      return;
    }
    if (!selectedId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save(), 1200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  async function deleteNote(id: number) {
    if (!confirm("Удалить заметку?")) return;
    await api(`/notes/${id}`, { method: "DELETE" });
    setNotes((prev) => prev.filter((n) => n.id !== id));
    if (selectedId === id) newNote();
  }

  return (
    <div className="flex h-full gap-6">
      {/* Список */}
      <div className="flex w-72 flex-col">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold">Заметки</h1>
          <button
            onClick={newNote}
            className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm hover:bg-indigo-500"
          >
            <Plus className="h-4 w-4" /> Новая
          </button>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto">
          {notes.map((n) => (
            <button
              key={n.id}
              onClick={() => selectNote(n)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition
                ${selectedId === n.id ? "bg-indigo-600/20 text-indigo-300" : "hover:bg-gray-800"}`}
            >
              <div className="truncate font-medium">{n.title}</div>
              <div className="text-xs text-gray-500">
                {new Date(n.updated_at).toLocaleString("ru", {
                  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                })}
              </div>
            </button>
          ))}
          {notes.length === 0 && <p className="px-3 text-sm text-gray-500">Пока пусто</p>}
        </div>
      </div>

      {/* Редактор */}
      <div className="flex flex-1 flex-col rounded-2xl border border-gray-800 bg-gray-900">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-800 p-3">
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Заголовок"
            className="min-w-40 flex-1 bg-transparent text-lg font-semibold outline-none"
          />

          {/* ПРЕДМЕТ — при смене сбрасываем тему */}
          <select
            value={draft.subject_id ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                subject_id: e.target.value ? Number(e.target.value) : null,
                topic_id: null,
              })
            }
            className="rounded-lg bg-gray-800 px-2 py-1.5 text-sm outline-none"
          >
            <option value="">Без предмета</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>

          {/* ТЕМА — появляется после выбора предмета */}
          <select
            value={draft.topic_id ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                topic_id: e.target.value ? Number(e.target.value) : null,
              })
            }
            disabled={!draft.subject_id}
            className="rounded-lg bg-gray-800 px-2 py-1.5 text-sm outline-none disabled:opacity-40"
          >
            <option value="">Без темы</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>

          <button
            onClick={() => setPreview(!preview)}
            className={`rounded-lg px-3 py-1.5 text-sm ${preview ? "bg-indigo-600" : "bg-gray-800 hover:bg-gray-700"}`}
          >
            {preview ? "Редактор" : "Превью"}
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm hover:bg-indigo-500 disabled:opacity-50"
          >
            {saved ? <Check className="h-4 w-4 text-green-400" /> : null}
            {saving ? "..." : saved ? "Сохранено" : "Сохранить"}
          </button>
        </div>

        {preview ? (
          <div className="prose prose-invert max-w-none flex-1 overflow-y-auto p-6 text-sm">
            <ReactMarkdown>{draft.content || "*Пусто* — напиши что-нибудь в режиме редактора"}</ReactMarkdown>
          </div>
        ) : (
          <textarea
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            placeholder="Пиши в Markdown: # заголовки, **жирный**, - списки..."
            className="flex-1 resize-none bg-transparent p-6 font-mono text-sm outline-none"
          />
        )}

        {selectedId && (
          <div className="flex items-center justify-between border-t border-gray-800 px-4 py-2 text-xs text-gray-500">
            <span>Автосохранение включено</span>
            <button
              onClick={() => deleteNote(selectedId)}
              className="flex items-center gap-1 hover:text-red-400"
            >
              <Trash2 className="h-3 w-3" /> Удалить
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
