"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Plus,
  Save,
  Eye,
  PencilLine,
  StickyNote,
  Check,
  Search,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { api } from "@/lib/api";
import { setActivity } from "@/lib/context";
import {
  PageTitle,
  ErrorNotice,
  Loading,
  DeleteButton,
} from "@/components/academic";
import type { Note, Subject, Topic } from "@/types";

type Draft = {
  title: string;
  content: string;
  subject_id: number | null;
  topic_id: number | null;
};
const blank: Draft = {
  title: "",
  content: "",
  subject_id: null,
  topic_id: null,
};
export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState(false);
  const savingRef = useRef(false);
  const revision = useRef(0);
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  useEffect(() => {
    let active = true;
    Promise.all([api<Note[]>("/notes"), api<Subject[]>("/subjects")])
      .then(([n, s]) => {
        if (active) {
          setNotes(n);
          setSubjects(s);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (!draft.subject_id) {
      setTopics([]);
      return;
    }
    api<Topic[]>(`/subjects/${draft.subject_id}/topics`)
      .then((rows) => {
        if (active) setTopics(rows);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [draft.subject_id]);
  useEffect(() => {
    setActivity({
      page: "notes",
      subject: subjects.find((s) => s.id === draft.subject_id)?.name,
      topic: topics.find((t) => t.id === draft.topic_id)?.title,
    });
  }, [draft.subject_id, draft.topic_id, subjects, topics]);
  const save = useCallback(async () => {
    if (savingRef.current) return false;
    if (!draft.title.trim() && !draft.content.trim()) return true;
    savingRef.current = true;
    setSaving(true);
    setError("");
    const version = revision.current;
    try {
      const result = await api<Note>(
        selectedId ? `/notes/${selectedId}` : "/notes",
        {
          method: selectedId ? "PATCH" : "POST",
          body: JSON.stringify({
            ...draft,
            title: draft.title.trim() || "Без названия",
          }),
        },
      );
      setNotes((prev) => [result, ...prev.filter((n) => n.id !== result.id)]);
      setSelectedId(result.id);
      if (revision.current === version) {
        setDirty(false);
        setSaved(true);
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить заметку");
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [draft, selectedId]);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => {
    if (!dirty || !selectedId) return;
    const timer = setTimeout(() => {
      void saveRef.current();
    }, 1200);
    return () => clearTimeout(timer);
  }, [draft, dirty, selectedId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", before);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", before);
    };
  }, [dirty]);
  function update(change: Partial<Draft>) {
    revision.current += 1;
    setDraft((prev) => ({ ...prev, ...change }));
    setDirty(true);
    setSaved(false);
  }
  async function select(note?: Note) {
    if (savingRef.current) return;
    if (dirty && !(await save())) return;
    revision.current += 1;
    setSelectedId(note?.id || null);
    setDraft(
      note
        ? {
            title: note.title,
            content: note.content,
            subject_id: note.subject_id,
            topic_id: note.topic_id,
          }
        : blank,
    );
    setDirty(false);
    setSaved(false);
    setPreview(false);
    setError("");
  }
  return (
    <div>
      <PageTitle
        eyebrow="ЛИЧНАЯ БАЗА ЗНАНИЙ"
        title="Мои заметки"
        description="Собирайте идеи, конспектируйте главное и возвращайтесь к своим открытиям."
      >
        <button
          className="btn btn-primary"
          onClick={() => select()}
          disabled={saving}
        >
          <Plus size={16} />
          Новая заметка
        </button>
      </PageTitle>
      <ErrorNotice message={error} />
      {loading ? (
        <Loading />
      ) : (
        <div className="study-split">
          <aside className="study-list">
            <div style={{ position: "relative", marginBottom: 15 }}>
              <Search
                size={15}
                style={{
                  position: "absolute",
                  top: 14,
                  left: 12,
                  color: "#93a188",
                }}
              />
              <input
                className="field"
                aria-label="Поиск заметок"
                placeholder="Найти заметку…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ paddingLeft: 35 }}
              />
            </div>
            <div
              style={{
                display: "grid",
                gap: 6,
                overflowY: "auto",
                maxHeight: 590,
              }}
            >
              {notes
                .filter((n) =>
                  (n.title + " " + n.content)
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((n) => (
                  <button
                    key={n.id}
                    disabled={saving}
                    onClick={() => select(n)}
                    style={{
                      textAlign: "left",
                      padding: "13px 15px",
                      borderRadius: 9,
                      border: `1px solid ${selectedId === n.id ? "#cedcc2" : "transparent"}`,
                      background:
                        selectedId === n.id ? "#eaf1e4" : "transparent",
                    }}
                  >
                    <strong
                      style={{
                        fontSize: 12,
                        fontWeight: 550,
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {n.title}
                    </strong>
                    <span className="muted" style={{ fontSize: 10 }}>
                      {new Date(n.updated_at).toLocaleDateString("ru-RU", {
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                  </button>
                ))}
            </div>
            {!notes.length && (
              <div className="empty-state">
                <StickyNote size={25} />
                <p>С первой заметки начинается ваша база знаний.</p>
              </div>
            )}
          </aside>
          <section
            className="study-editor panel"
            style={{
              padding: 0,
              flex: 1,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: 20, borderBottom: "1px solid var(--line)" }}>
              <input
                value={draft.title}
                onChange={(e) => update({ title: e.target.value })}
                placeholder="Название вашей заметки"
                maxLength={200}
                aria-label="Название заметки"
                style={{
                  fontSize: 22,
                  fontWeight: 500,
                  width: "100%",
                  outline: "none",
                  marginBottom: 17,
                  background: "transparent",
                }}
              />
              <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                <select
                  className="field"
                  style={{ flex: 1, minWidth: 130 }}
                  value={draft.subject_id || ""}
                  onChange={(e) =>
                    update({
                      subject_id: e.target.value
                        ? Number(e.target.value)
                        : null,
                      topic_id: null,
                    })
                  }
                  aria-label="Предмет заметки"
                >
                  <option value="">Без предмета</option>
                  {subjects.map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <select
                  className="field"
                  style={{ flex: 1, minWidth: 120 }}
                  value={draft.topic_id || ""}
                  onChange={(e) =>
                    update({
                      topic_id: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                  disabled={!draft.subject_id}
                  aria-label="Тема заметки"
                >
                  <option value="">Без темы</option>
                  {topics.map((t) => (
                    <option value={t.id} key={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-secondary"
                  onClick={() => setPreview(!preview)}
                >
                  {preview ? <PencilLine size={15} /> : <Eye size={15} />}
                  <span>{preview ? "Редактор" : "Просмотр"}</span>
                </button>
                <button
                  className="btn btn-primary"
                  onClick={save}
                  disabled={
                    saving ||
                    (!dirty && !!selectedId) ||
                    (!draft.title.trim() && !draft.content.trim())
                  }
                >
                  {saved ? <Check size={15} /> : <Save size={15} />}
                  <span>
                    {saving ? "Сохраняем…" : saved ? "Сохранено" : "Сохранить"}
                  </span>
                </button>
              </div>
            </div>
            {preview ? (
              <div
                className="prose"
                style={{
                  flex: 1,
                  padding: 25,
                  overflowY: "auto",
                  overflowWrap: "anywhere",
                  fontSize: 13,
                }}
              >
                <ReactMarkdown>
                  {draft.content || "*Здесь появится текст вашей заметки.*"}
                </ReactMarkdown>
              </div>
            ) : (
              <textarea
                aria-label="Текст заметки"
                value={draft.content}
                onChange={(e) => update({ content: e.target.value })}
                maxLength={150000}
                placeholder="Начните с мысли, которую не хочется потерять.\n\nМожно использовать Markdown: # заголовок, **выделение**, - список."
                style={{
                  flex: 1,
                  padding: 25,
                  minHeight: 330,
                  outline: "none",
                  resize: "none",
                  fontSize: 13,
                  lineHeight: 1.9,
                  background: "transparent",
                }}
              />
            )}
            <div
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                justifyContent: "space-between",
                borderTop: "1px solid var(--line)",
                padding: "10px 18px",
                fontSize: 10,
                color: "#9da992",
              }}
            >
              <span>
                {selectedId
                  ? dirty
                    ? "Есть несохранённые изменения"
                    : "Автосохранение включено"
                  : "Ctrl + S — сохранить заметку"}{" "}
                · {draft.content.length} символов
              </span>
              {selectedId && (
                <DeleteButton
                  endpoint={`/notes/${selectedId}`}
                  title="Удалить заметку"
                  onDeleted={() => {
                    setNotes((prev) => prev.filter((n) => n.id !== selectedId));
                    setSelectedId(null);
                    setDraft(blank);
                    setDirty(false);
                    setSaved(false);
                  }}
                />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
