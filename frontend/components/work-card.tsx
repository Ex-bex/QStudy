"use client";

import { useState } from "react";
import { CalendarDays, ChevronDown, Check, Send, Save } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  DeleteButton,
  ErrorNotice,
  RecordEditor,
  workFields,
  DetailBlock,
  errorMessage,
  Loading,
  localDateTime,
} from "@/components/academic";
import type { Submission, Work } from "@/types/academic";
import { LearningActions } from "@/components/learning-source";

const kinds: Record<string, string> = {
  assignment: "Задание",
  module: "Модульная работа",
  exam: "Экзамен",
  practice: "Практика",
};
export default function WorkCard({
  work,
  onChanged,
}: {
  work: Work;
  onChanged: () => void | Promise<void>;
}) {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const [open, setOpen] = useState(false);
  const [submission, setSubmission] = useState(work.my_submission);
  const [content, setContent] = useState(work.my_submission?.content || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const graded = submission?.grade != null;
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && admin) {
      setBusy(true);
      setError("");
      try {
        setSubmissions(
          await api<Submission[]>(`/works/${work.id}/submissions`),
        );
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    }
  }
  async function save(status: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await api<Submission>(`/works/${work.id}/submission`, {
        method: "PUT",
        body: JSON.stringify({ content, status }),
      });
      setSubmission(result);
      setSuccess(
        status === "submitted"
          ? "Работа отправлена на проверку."
          : "Черновик сохранён.",
      );
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function reloadSubmissions() {
    setSubmissions(await api<Submission[]>(`/works/${work.id}/submissions`));
  }
  return (
    <article className="panel academic-work">
      <div className="academic-card-top">
        <div>
          <div className="academic-meta" style={{ marginBottom: 10 }}>
            <span>{kinds[work.kind] || work.kind}</span>
            {work.module && <span>{work.module}</span>}
            {work.week_number && <span>Неделя {work.week_number}</span>}
          </div>
          <h3>{work.title}</h3>
          {work.course_title && (
            <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>
              {work.course_title} {work.group_name && `· ${work.group_name}`}
            </p>
          )}
        </div>
        <div className="academic-actions">
          {admin && (
            <>
              <RecordEditor
                compact
                title="Редактировать работу"
                fields={workFields}
                initial={{
                  ...work,
                  due_date: localDateTime(work.due_date),
                }}
                method="PUT"
                endpoint={`/works/${work.id}`}
                onSaved={onChanged}
              />
              <DeleteButton
                title="Удалить работу?"
                description="Задание и отправленные студентами ответы будут удалены."
                endpoint={`/works/${work.id}`}
                onDeleted={onChanged}
              />
            </>
          )}
          <span className="badge">
            {submission?.grade != null
              ? `${submission.grade} / ${work.max_score}`
              : `${work.max_score} баллов`}
          </span>
        </div>
      </div>
      <div className="academic-meta" style={{ marginTop: 16 }}>
        {work.due_date && (
          <span>
            <CalendarDays size={13} />
            {new Date(work.due_date).toLocaleString("ru-RU", {
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
        {submission && (
          <span>
            <Check size={13} />
            {submission.status === "submitted" ? "Сдано" : "Черновик"}
          </span>
        )}
      </div>
      <button
        type="button"
        className="academic-card-link"
        style={{
          width: "100%",
          background: "none",
          borderRight: 0,
          borderLeft: 0,
          borderBottom: 0,
          cursor: "pointer",
          marginTop: 18,
        }}
        onClick={toggle}
      >
        {open
          ? "Свернуть"
          : admin
            ? "Задание и ответы студентов"
            : "Открыть задание"}
        <ChevronDown
          size={16}
          style={{ transform: open ? "rotate(180deg)" : undefined }}
        />
      </button>
      {open && (
        <div className="academic-work-body">
          <LearningActions
            selection={{
              course_id: work.course_id,
              module: work.module,
              work_ids: [work.id],
            }}
            compact
          />
          <DetailBlock label="Задание">
            {work.description || "Описание пока не добавлено."}
          </DetailBlock>
          <ErrorNotice message={error} />
          {success && (
            <p className="academic-success" role="status">
              {success}
            </p>
          )}
          {admin ? (
            <>
              {busy && <Loading />}
              {submissions?.length === 0 && (
                <p className="muted" style={{ fontSize: 13, marginTop: 20 }}>
                  Студенты ещё не отправили работы.
                </p>
              )}
              {submissions?.map((item) => (
                <div className="academic-submission" key={item.id}>
                  <div className="academic-card-top">
                    <div>
                      <strong style={{ fontSize: 13 }}>
                        {item.student_name ||
                          item.student_email ||
                          `Студент №${item.user_id}`}
                      </strong>
                      <p
                        className="muted"
                        style={{ fontSize: 11, marginTop: 5 }}
                      >
                        {item.status === "submitted" ? "Сдано" : "Черновик"} ·{" "}
                        {new Date(item.updated_at).toLocaleDateString("ru-RU")}
                      </p>
                    </div>
                    <RecordEditor
                      title="Оценить"
                      label={
                        item.grade != null
                          ? `${item.grade} / ${work.max_score}`
                          : "Оценить"
                      }
                      endpoint={`/submissions/${item.id}/grade`}
                      method="PUT"
                      initial={{ grade: item.grade, feedback: item.feedback }}
                      fields={[
                        {
                          name: "grade",
                          label: `Балл (до ${work.max_score})`,
                          type: "number",
                          min: 0,
                          max: work.max_score,
                          nullable: true,
                          hint: "Оставьте пустым, чтобы снять оценку и разрешить редактирование ответа.",
                        },
                        {
                          name: "feedback",
                          label: "Комментарий студенту",
                          type: "textarea",
                        },
                      ]}
                      onSaved={reloadSubmissions}
                    />
                  </div>
                  <div className="academic-prose" style={{ marginTop: 15 }}>
                    {item.content}
                  </div>
                  {item.feedback && (
                    <div className="academic-feedback">{item.feedback}</div>
                  )}
                </div>
              ))}
            </>
          ) : (
            <div className="academic-response">
              <label className="academic-field">
                <span>{graded ? "Ваш оценённый ответ" : "Ваш ответ"}</span>
                <textarea
                  readOnly={graded}
                  className="field"
                  rows={5}
                  maxLength={100000}
                  placeholder="Напишите ответ, добавьте пояснения и ссылки на материалы…"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </label>
              <div className="academic-actions">
                <button
                  className="btn btn-secondary"
                  disabled={busy || graded || !content.trim()}
                  onClick={() => save("draft")}
                >
                  <Save size={15} /> Сохранить черновик
                </button>
                <button
                  className="btn btn-primary"
                  disabled={busy || graded || !content.trim()}
                  onClick={() => save("submitted")}
                >
                  <Send size={15} />
                  {busy ? "Сохраняем…" : "Сдать работу"}
                </button>
                {submission && !graded && (
                  <DeleteButton
                    title="Удалить свой ответ?"
                    endpoint={`/works/${work.id}/submission`}
                    onDeleted={async () => {
                      setSubmission(null);
                      setContent("");
                      setSuccess("");
                      await onChanged();
                    }}
                  />
                )}
              </div>
              {graded && (
                <p className="muted" style={{ fontSize: 12 }}>
                  Работа оценена. Чтобы изменить ответ, попросите администратора
                  снять оценку.
                </p>
              )}
              {submission?.feedback && (
                <div className="academic-feedback">
                  <strong>Комментарий преподавателя</strong>
                  <p>{submission.feedback}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
