"use client";

import { useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth, type User } from "@/lib/auth";
import { useResource, ErrorNotice } from "@/components/academic";
import styles from "./control.module.css";

export type ControlLesson = {
  id: number;
  title: string;
  description: string;
  bank_count: number;
  question_count: number;
  owner: { id: number; name: string; email: string };
};

export default function QTestsLessonsControl({
  lessons,
  reload,
}: {
  lessons: ControlLesson[];
  reload: () => Promise<void>;
}) {
  const { user } = useAuth();
  const accounts = useResource<User[]>("/admin/users");
  const [editing, setEditing] = useState<ControlLesson | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ownerId, setOwnerId] = useState(user.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  function edit(lesson: ControlLesson | "new") {
    setEditing(lesson);
    setTitle(lesson === "new" ? "" : lesson.title);
    setDescription(lesson === "new" ? "" : lesson.description);
    setOwnerId(lesson === "new" ? user.id : lesson.owner.id);
    setError("");
    setNotice("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/qtests/lessons${editing === "new" ? "" : `/${editing.id}`}`, {
        method: editing === "new" ? "POST" : "PATCH",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          ...(editing === "new" ? { owner_id: ownerId } : {}),
        }),
      });
      setEditing(null);
      await reload();
      setNotice("Урок сохранён. Документы и результаты остаются в общей базе.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось сохранить урок",
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove(lesson: ControlLesson) {
    if (
      !window.confirm(
        `Удалить урок «${lesson.title}»? Его банки останутся в разделе «Без урока», документы и результаты сохранятся.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/qtests/lessons/${lesson.id}`, { method: "DELETE" });
      if (editing !== "new" && editing?.id === lesson.id) setEditing(null);
      await reload();
      setNotice("Урок удалён. Банки, документы и попытки сохранены.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось удалить урок",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section style={{ marginTop: 30 }} aria-labelledby="control-qtests-lessons">
      <div className={styles.sectionHeading}>
        <h2 id="control-qtests-lessons">Уроки участников</h2>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => edit("new")}
        >
          <Plus size={14} />
          Создать урок
        </button>
      </div>
      <ErrorNotice message={error} />
      {notice && <p role="status">{notice}</p>}
      {editing && (
        <form
          className="panel"
          onSubmit={save}
          style={{ padding: 24, marginBottom: 18 }}
        >
          <h3>{editing === "new" ? "Новый урок" : "Редактирование урока"}</h3>
          <div className="academic-form-grid">
            <label className="academic-field">
              Название
              <input
                className="field"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                required
                disabled={busy}
              />
            </label>
            {editing === "new" && (
              <label className="academic-field">
                Владелец
                <select
                  className="field"
                  value={ownerId}
                  onChange={(event) => setOwnerId(Number(event.target.value))}
                  disabled={busy || accounts.loading}
                >
                  <option value={user.id}>
                    {user.name || user.email} — мой аккаунт
                  </option>
                  {(accounts.data || [])
                    .filter(
                      (account) => account.id !== user.id && account.is_active,
                    )
                    .map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name} · {account.email}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label className="academic-field">
              Описание
              <textarea
                className="field"
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2000}
                disabled={busy}
              />
            </label>
          </div>
          {editing === "new" && <ErrorNotice message={accounts.error} />}
          <div className="academic-actions">
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Сохраняем…" : "Сохранить урок"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              <X size={14} />
              Отмена
            </button>
          </div>
        </form>
      )}
      <div className={`panel academic-table-wrap ${styles.table}`}>
        <table className="academic-table">
          <thead>
            <tr>
              <th>Урок</th>
              <th>Владелец</th>
              <th>Банков / вопросов</th>
              <th>Управление</th>
            </tr>
          </thead>
          <tbody>
            {lessons.map((lesson) => (
              <tr key={lesson.id}>
                <td>
                  <strong>{lesson.title}</strong>
                  {lesson.description && <p>{lesson.description}</p>}
                </td>
                <td>
                  {lesson.owner?.name}
                  <br />
                  <small>{lesson.owner?.email}</small>
                </td>
                <td>
                  {lesson.bank_count} / {lesson.question_count}
                </td>
                <td>
                  <div className="academic-actions">
                    <button
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => edit(lesson)}
                    >
                      <Pencil size={14} />
                      Изменить
                    </button>
                    <button
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={() => void remove(lesson)}
                      aria-label={`Удалить урок ${lesson.title}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!lessons.length && (
              <tr>
                <td colSpan={4}>
                  Уроков пока нет. Создайте урок, затем выберите его при
                  загрузке Word или в редакторе банка.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
