"use client";
import { setActivity } from "@/lib/context";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import type { Subject, Topic } from "@/types";
import { Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899"];

export default function SubjectsPage() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [topics, setTopics] = useState<Record<number, Topic[]>>({});
  const [openId, setOpenId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [topicTitle, setTopicTitle] = useState("");

  const loadTopics = useCallback(async (subjectId: number) => {
    const t = await api<Topic[]>(`/subjects/${subjectId}/topics`);
    setTopics((prev) => ({ ...prev, [subjectId]: t }));
  }, []);

  useEffect(() => {
    api<Subject[]>("/subjects").then(setSubjects).catch(() => {});
  }, []);
useEffect(() => { setActivity({ page: "review" }); }, []);
  async function createSubject(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const s = await api<Subject>("/subjects", {
      method: "POST",
      body: JSON.stringify({ name, color }),
    });
    setSubjects((prev) => [...prev, s]);
    setName("");
  }

  async function deleteSubject(id: number) {
    if (!confirm("Удалить предмет вместе с темами?")) return;
    await api(`/subjects/${id}`, { method: "DELETE" });
    setSubjects((prev) => prev.filter((s) => s.id !== id));
  }

  async function toggleOpen(s: Subject) {
    if (openId === s.id) {
      setOpenId(null);
      return;
    }
    setOpenId(s.id);
    if (!topics[s.id]) await loadTopics(s.id);
  }

  async function createTopic(subjectId: number) {
    if (!topicTitle.trim()) return;
    const t = await api<Topic>(`/subjects/${subjectId}/topics`, {
      method: "POST",
      body: JSON.stringify({ title: topicTitle }),
    });
    setTopics((prev) => ({ ...prev, [subjectId]: [...(prev[subjectId] || []), t] }));
    setTopicTitle("");
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold">Предметы</h1>
      <p className="mb-8 text-gray-400">Структура: предмет → темы → материалы</p>

      <form onSubmit={createSubject} className="mb-6 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Название предмета, напр. Математический анализ"
          className="flex-1 rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 outline-none focus:border-indigo-500"
        />
        <div className="flex gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-8 w-8 rounded-full border-2 transition ${color === c ? "border-white" : "border-transparent"}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <button type="submit" className="flex items-center gap-1 rounded-lg bg-indigo-600 px-4 hover:bg-indigo-500">
          <Plus className="h-4 w-4" /> Добавить
        </button>
      </form>

      <div className="space-y-3">
        {subjects.map((s) => (
          <div key={s.id} className="rounded-xl border border-gray-800 bg-gray-900">
            <div className="flex items-center gap-3 p-4">
              <button onClick={() => toggleOpen(s)} className="flex flex-1 items-center gap-3 text-left">
                {openId === s.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                <span className="h-3 w-3 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="font-medium">{s.name}</span>
                <span className="text-sm text-gray-500">{topics[s.id]?.length ?? 0} тем</span>
              </button>
              <button
                onClick={() => deleteSubject(s.id)}
                className="text-gray-500 hover:text-red-400"
                title="Удалить предмет"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            {openId === s.id && (
              <div className="border-t border-gray-800 p-4 pt-3">
                <div className="mb-3 flex gap-2">
                  <input
                    value={topicTitle}
                    onChange={(e) => setTopicTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && createTopic(s.id)}
                    placeholder="Новая тема..."
                    className="flex-1 rounded-lg bg-gray-800 px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    onClick={() => createTopic(s.id)}
                    className="rounded-lg bg-gray-700 px-3 text-sm hover:bg-gray-600"
                  >
                    + Тема
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(topics[s.id] || []).map((t) => (
                    <span key={t.id} className="rounded-full bg-gray-800 px-3 py-1 text-sm text-gray-300">
                      {t.title}
                    </span>
                  ))}
                  {(topics[s.id] || []).length === 0 && (
                    <span className="text-sm text-gray-500">Тем пока нет</span>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {subjects.length === 0 && (
        <p className="text-gray-500">Создай первый предмет — например, «Матанализ» или «Физика».</p>
      )}
    </div>
  );
}
