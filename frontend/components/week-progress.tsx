"use client";

import { useState } from "react";
import { CheckCheck } from "lucide-react";
import { api } from "@/lib/api";
import { DeleteButton, ErrorNotice, errorMessage } from "@/components/academic";
import type { Week } from "@/types/academic";

export default function WeekProgress({ week }: { week: Week }) {
  const [completed, setCompleted] = useState(
    week.my_progress?.completed || false,
  );
  const [note, setNote] = useState(week.my_progress?.note || "");
  const [saved, setSaved] = useState(Boolean(week.my_progress));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(`/weeks/${week.id}/progress`, {
        method: "PUT",
        body: JSON.stringify({ completed, note }),
      });
      setSaved(true);
      setMessage("Ваш прогресс сохранён.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ borderTop: "1px solid #e7eae7", paddingTop: 20 }}>
      <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 13 }}>
        Мой прогресс
      </h4>
      <label
        style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 13 }}
      >
        <input
          type="checkbox"
          checked={completed}
          onChange={(e) => setCompleted(e.target.checked)}
        />{" "}
        Неделя пройдена
      </label>
      <label className="academic-field" style={{ marginTop: 16 }}>
        <span>Личная заметка</span>
        <textarea
          className="field"
          rows={3}
          maxLength={10000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Что повторить, на что обратить внимание…"
        />
      </label>
      <ErrorNotice message={error} />
      {message && (
        <p className="academic-success" role="status">
          {message}
        </p>
      )}
      <div className="academic-actions" style={{ marginTop: 13 }}>
        <button className="btn btn-secondary" disabled={busy} onClick={save}>
          <CheckCheck size={15} />
          {busy ? "Сохраняем…" : "Сохранить прогресс"}
        </button>
        {saved && (
          <DeleteButton
            title="Сбросить прогресс недели?"
            endpoint={`/weeks/${week.id}/progress`}
            onDeleted={() => {
              setCompleted(false);
              setNote("");
              setSaved(false);
              setMessage("");
            }}
          />
        )}
      </div>
    </div>
  );
}
