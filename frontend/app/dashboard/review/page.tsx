"use client";

import { useEffect, useState } from "react";
import {
  Brain,
  Check,
  Eye,
  Layers,
  Minus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { setActivity } from "@/lib/context";
import { learningSourceActivity } from "@/lib/learning-selection";
import {
  LearningSourceSelector,
  SourceContext,
  useLearningSource,
} from "@/components/learning-source";
import { useJobRefresh } from "@/lib/notifications";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Empty,
  Loading,
  RecordEditor,
  DeleteButton,
  errorMessage,
  type FieldDefinition,
} from "@/components/academic";
import type { Subject, Topic, Flashcard } from "@/types";

export default function ReviewPage() {
  const source = useLearningSource();
  const { data: subjects } = useResource<Subject[]>("/subjects");
  const {
    data: cards,
    loading,
    error: loadError,
    reload: reloadCards,
  } = useResource<Flashcard[]>("/cards");
  const {
    data: due,
    reload: reloadDue,
    setData: setDue,
  } = useResource<Flashcard[]>("/cards/due");
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const { data: topics } = useResource<Topic[]>(
    subjectId ? `/subjects/${subjectId}/topics` : null,
  );
  const [count, setCount] = useState(10);
  const [tab, setTab] = useState("review");
  const [flipped, setFlipped] = useState(false);
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = due?.[0];
  useEffect(() => {
    setActivity({
      page: "review",
      course_id: source.courseMode
        ? source.selection.course_id || undefined
        : undefined,
      module: source.selection.module,
      week_numbers: source.selection.week_numbers,
      work_ids: source.selection.work_ids,
      use_web: source.selection.use_web,
      ...(current
        ? learningSourceActivity(
            current.source_context,
            source.selection.use_web,
          )
        : {}),
    });
  }, [current, source.courseMode, source.selection]);
  const fields: FieldDefinition[] = [
    { name: "front", label: "Вопрос", type: "textarea", required: true },
    { name: "back", label: "Ответ", type: "textarea", required: true },
  ];
  async function refresh() {
    await Promise.all([reloadCards(), reloadDue()]);
    setFlipped(false);
  }
  useJobRefresh("cards", refresh);
  async function generate() {
    if (
      (source.courseMode && source.selectionError) ||
      (!source.courseMode && !subjectId)
    ) {
      setError(source.courseMode ? source.selectionError : "Выберите предмет.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/cards/generate", {
        method: "POST",
        body: JSON.stringify({
          ...source.payload,
          subject_id: source.courseMode ? null : Number(subjectId),
          topic_id: !source.courseMode && topicId ? Number(topicId) : null,
          count,
        }),
      });
      await refresh();
      setTab("review");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function review(quality: number) {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      await api(`/cards/${current.id}/review`, {
        method: "POST",
        body: JSON.stringify({ quality }),
      });
      setDue(
        (previous) => previous?.filter((card) => card.id !== current.id) || [],
      );
      setDone((previous) => previous + 1);
      setFlipped(false);
      await reloadCards();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <PageTitle
        eyebrow="ЗНАНИЯ НАДОЛГО"
        title="Повторение"
        description="Короткие сессии с карточками помогут закрепить то, что вы уже изучили."
      >
        <RecordEditor
          title="Создать карточку"
          fields={[
            ...fields,
            {
              name: "subject_id",
              label: "Предмет",
              type: "select",
              nullable: true,
              options: [
                { value: "", label: "Без предмета" },
                ...(subjects || []).map((subject) => ({
                  value: subject.id,
                  label: subject.name,
                })),
              ],
            },
          ]}
          endpoint="/cards"
          onSaved={refresh}
        />
      </PageTitle>
      <div className="panel" style={{ padding: 22, marginBottom: 24 }}>
        <LearningSourceSelector source={source} disabled={busy} />
        <div className="academic-filter" style={{ marginBottom: 0 }}>
          {!source.courseMode && (
            <>
              <select
                className="field"
                value={subjectId}
                aria-label="Предмет"
                onChange={(e) => {
                  setSubjectId(e.target.value);
                  setTopicId("");
                }}
              >
                <option value="">Выберите предмет</option>
                {subjects?.map((subject) => (
                  <option value={subject.id} key={subject.id}>
                    {subject.name}
                  </option>
                ))}
              </select>
              <select
                className="field"
                value={topicId}
                disabled={!subjectId}
                aria-label="Тема"
                onChange={(e) => setTopicId(e.target.value)}
              >
                <option value="">Все темы</option>
                {subjectId &&
                  topics?.map((topic) => (
                    <option value={topic.id} key={topic.id}>
                      {topic.title}
                    </option>
                  ))}
              </select>
            </>
          )}
          <input
            className="field"
            style={{ maxWidth: 85, minWidth: 70 }}
            aria-label="Количество карточек"
            type="number"
            min={1}
            max={30}
            value={count}
            onChange={(e) =>
              setCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))
            }
          />
          <button
            className="btn btn-primary"
            disabled={
              busy ||
              (source.courseMode &&
                (source.loading || Boolean(source.selectionError)))
            }
            onClick={generate}
          >
            <Sparkles size={16} />
            {busy ? "Обрабатываем…" : "Создать с ИИ"}
          </button>
        </div>
      </div>
      <ErrorNotice message={error || loadError} />
      <div
        className="academic-stats"
        style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))" }}
      >
        {[
          { label: "Всего карточек", value: cards?.length || 0 },
          { label: "К повторению", value: due?.length || 0 },
          { label: "Повторено сейчас", value: done },
        ].map((stat) => (
          <div className="panel academic-stat" key={stat.label}>
            <p>{stat.label}</p>
            <strong>{stat.value}</strong>
          </div>
        ))}
      </div>
      <div className="academic-section-heading">
        <div className="academic-tabs" style={{ marginBottom: 0 }}>
          <button
            className={tab === "review" ? "active" : ""}
            onClick={() => setTab("review")}
          >
            Повторить
          </button>
          <button
            className={tab === "library" ? "active" : ""}
            onClick={() => setTab("library")}
          >
            Все карточки
          </button>
        </div>
        <button className="btn btn-secondary" onClick={refresh} disabled={busy}>
          <RefreshCw size={14} /> Обновить
        </button>
      </div>
      {loading ? (
        <Loading />
      ) : tab === "review" ? (
        current ? (
          <div
            className="panel"
            style={{ maxWidth: 760, margin: "0 auto", overflow: "hidden" }}
          >
            <div
              className="academic-card-top"
              style={{
                padding: "16px 23px",
                borderBottom: "1px solid #e7eae7",
              }}
            >
              <span className="academic-meta">
                Повторений: {current.repetitions} · Интервал: {current.interval}{" "}
                дн.
              </span>
              <div className="academic-actions">
                <RecordEditor
                  compact
                  title="Редактировать карточку"
                  fields={fields}
                  initial={{ ...current }}
                  endpoint={`/cards/${current.id}`}
                  method="PATCH"
                  onSaved={refresh}
                />
                <DeleteButton
                  title="Удалить карточку?"
                  endpoint={`/cards/${current.id}`}
                  onDeleted={refresh}
                />
              </div>
            </div>
            <div style={{ padding: "0 23px" }}>
              <SourceContext value={current.source_context} />
            </div>
            <button
              onClick={() => setFlipped(!flipped)}
              style={{
                display: "flex",
                width: "100%",
                minHeight: 280,
                padding: 35,
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                gap: 25,
                textAlign: "center",
                border: 0,
                background: "transparent",
                cursor: "pointer",
              }}
            >
              <span className="eyebrow">{flipped ? "ОТВЕТ" : "ВОПРОС"}</span>
              <span className="academic-prose" style={{ fontSize: 20 }}>
                {flipped ? current.back : current.front}
              </span>
              <span className="academic-meta">
                <Eye size={14} />{" "}
                {flipped ? "Посмотреть вопрос" : "Нажмите, чтобы увидеть ответ"}
              </span>
            </button>
            {flipped && (
              <div
                className="academic-actions"
                style={{
                  padding: 22,
                  borderTop: "1px solid #e7eae7",
                  justifyContent: "center",
                }}
              >
                {[
                  { value: 0, label: "Не помню", icon: X },
                  { value: 1, label: "С трудом", icon: Minus },
                  { value: 2, label: "Помню", icon: Check },
                ].map((option) => (
                  <button
                    key={option.value}
                    className={`btn ${option.value === 2 ? "btn-primary" : "btn-secondary"}`}
                    disabled={busy}
                    onClick={() => review(option.value)}
                  >
                    <option.icon size={16} />
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <Empty title={done ? "Сессия завершена" : "На сегодня всё повторено"}>
            <Brain size={30} style={{ margin: "15px auto" }} />
            {done
              ? `Вы повторили ${done} карточек. Следующая сессия появится, когда придёт время.`
              : "Создайте карточки вручную или из своих материалов с помощью ИИ."}
          </Empty>
        )
      ) : cards?.length ? (
        <div className="academic-grid two">
          {cards.map((card) => (
            <article className="panel academic-card" key={card.id}>
              <div className="academic-card-top">
                <Layers size={18} color="#779171" />
                <div className="academic-actions">
                  <RecordEditor
                    compact
                    title="Редактировать карточку"
                    fields={fields}
                    initial={{ ...card }}
                    endpoint={`/cards/${card.id}`}
                    method="PATCH"
                    onSaved={refresh}
                  />
                  <DeleteButton
                    title="Удалить карточку?"
                    endpoint={`/cards/${card.id}`}
                    onDeleted={refresh}
                  />
                </div>
              </div>
              <h3>{card.front}</h3>
              <SourceContext value={card.source_context} />
              <p className="academic-prose muted">{card.back}</p>
              <p className="academic-meta">
                Повторить:{" "}
                {new Date(card.next_review).toLocaleDateString("ru-RU")}
              </p>
            </article>
          ))}
        </div>
      ) : (
        <Empty title="Карточек ещё нет">
          Создайте первую карточку с вопросом и ответом.
        </Empty>
      )}
    </div>
  );
}
