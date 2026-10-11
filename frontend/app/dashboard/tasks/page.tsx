"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Lightbulb,
  ListChecks,
  Send,
  Sparkles,
  MessageSquare,
  ChevronRight,
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
import type { Subject, Topic, Task, TaskCheck } from "@/types";

const difficulties = [
  { value: "easy", label: "Легко" },
  { value: "medium", label: "Средне" },
  { value: "hard", label: "Сложно" },
];
const statuses: Record<string, string> = {
  new: "Новая",
  solved: "Решена",
  partial: "Частично",
  failed: "Нужно повторить",
};
const verdicts: Record<string, string> = {
  correct: "Верно",
  partial: "Частично верно",
  wrong: "Есть ошибки",
};
export default function TasksPage() {
  const source = useLearningSource();
  const { data: subjects, error: subjectError } =
    useResource<Subject[]>("/subjects");
  const {
    data: tasks,
    loading,
    error: taskError,
    reload,
    setData: setTasks,
  } = useResource<Task[]>("/tasks");
  useJobRefresh("tasks", reload);
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const { data: topics } = useResource<Topic[]>(
    subjectId ? `/subjects/${subjectId}/topics` : null,
  );
  const [difficulty, setDifficulty] = useState("medium");
  const [count, setCount] = useState(5);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<TaskCheck | null>(null);
  const [showHint, setShowHint] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [sources, setSources] = useState<string[] | null>(null);
  const current = tasks?.find((task) => task.id === selectedId) || null;
  useEffect(() => {
    setActivity({
      page: "tasks",
      course_id: source.courseMode
        ? source.selection.course_id || undefined
        : undefined,
      module: source.courseMode ? source.selection.module : undefined,
      week_numbers: source.courseMode
        ? source.selection.week_numbers
        : undefined,
      work_ids: source.courseMode ? source.selection.work_ids : undefined,
      use_web: source.selection.use_web,
      subject: subjects?.find((subject) => subject.id === Number(subjectId))
        ?.name,
      ...(current
        ? learningSourceActivity(
            current.source_context,
            source.selection.use_web,
          )
        : {}),
      task: current
        ? { question: current.question, status: current.status }
        : null,
    });
  }, [current, subjectId, subjects, source.courseMode, source.selection]);
  const taskFields: FieldDefinition[] = [
    {
      name: "question",
      label: "Вопрос или условие",
      type: "textarea",
      required: true,
    },
    { name: "hint", label: "Подсказка", type: "textarea" },
    {
      name: "difficulty",
      label: "Сложность",
      type: "select",
      options: difficulties,
    },
  ];
  const createFields: FieldDefinition[] = [
    ...taskFields,
    {
      name: "answer",
      label: "Эталонный ответ",
      type: "textarea",
      hint: "Необязательно. ИИ использует этот ответ при проверке.",
    },
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
  ];
  function selectTask(task: Task) {
    setSelectedId(task.id);
    setAnswer(task.user_answer || "");
    setFeedback(null);
    setShowHint(false);
    setError("");
  }
  async function generate() {
    if (
      (source.courseMode && source.selectionError) ||
      (!source.courseMode && !subjectId)
    ) {
      setError(
        source.courseMode
          ? source.selectionError
          : "Выберите предмет для генерации.",
      );
      return;
    }
    setGenerating(true);
    setError("");
    try {
      const result = await api<{ tasks: Task[]; sources: string[] }>(
        "/tasks/generate",
        {
          method: "POST",
          body: JSON.stringify({
            ...source.payload,
            subject_id: source.courseMode ? null : Number(subjectId),
            topic_id: !source.courseMode && topicId ? Number(topicId) : null,
            difficulty,
            count,
          }),
        },
      );
      setTasks((previous) => [
        ...result.tasks,
        ...(previous || []).filter(
          (task) => !result.tasks.some((created) => created.id === task.id),
        ),
      ]);
      setSources(result.sources);
      if (result.tasks[0]) selectTask(result.tasks[0]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  }
  async function submit() {
    if (!current || !answer.trim()) return;
    setChecking(true);
    setError("");
    try {
      const result = await api<TaskCheck>(`/tasks/${current.id}/answer`, {
        method: "POST",
        body: JSON.stringify({ answer }),
      });
      setFeedback(result);
      setTasks(
        (previous) =>
          previous?.map((task) =>
            task.id === result.task.id ? result.task : task,
          ) || [],
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }
  return (
    <div>
      <PageTitle
        eyebrow="ПРАКТИКА С ИИ"
        title="Тренажёр"
        description="Решайте задачи, разбирайте ошибки и двигайтесь дальше в своём темпе."
      >
        <RecordEditor
          title="Создать задачу"
          fields={createFields}
          initial={{ difficulty: "medium", subject_id: subjectId || "" }}
          endpoint="/tasks"
          onSaved={reload}
        />
      </PageTitle>
      <div className="panel" style={{ padding: 22, marginBottom: 24 }}>
        <LearningSourceSelector source={source} disabled={generating} />
        <div className="academic-filter" style={{ marginBottom: 0 }}>
          {!source.courseMode && (
            <>
              <select
                className="field"
                aria-label="Предмет"
                value={subjectId}
                onChange={(e) => {
                  setSubjectId(e.target.value);
                  setTopicId("");
                }}
              >
                <option value="">Выберите предмет</option>
                {subjects?.map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.name}
                  </option>
                ))}
              </select>
              <select
                className="field"
                aria-label="Тема"
                value={topicId}
                disabled={!subjectId}
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
          <select
            className="field"
            aria-label="Сложность"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
          >
            {difficulties.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            className="field"
            aria-label="Количество задач"
            style={{ maxWidth: 80, minWidth: 70 }}
            type="number"
            min={1}
            max={10}
            value={count}
            onChange={(e) =>
              setCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))
            }
          />
          <button
            className="btn btn-primary"
            disabled={
              generating ||
              (source.courseMode &&
                (source.loading || Boolean(source.selectionError)))
            }
            onClick={generate}
          >
            <Sparkles size={16} />
            {generating ? "Создаём задачи…" : "Создать с ИИ"}
          </button>
        </div>
        {sources !== null && current?.source_context?.mode !== "course" && (
          <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
            {sources.length
              ? `По вашим материалам: ${sources.join(", ")}`
              : "Материалы по выбранной теме не найдены: задачи составлены из общих знаний."}
          </p>
        )}
      </div>
      <ErrorNotice message={error || taskError || subjectError} />
      {loading ? (
        <Loading />
      ) : (
        <div className="study-split academic-practice">
          <aside className="study-list">
            <div className="academic-section-heading">
              <h2 style={{ fontSize: 16 }}>Мои задачи</h2>
              <span className="badge">
                {tasks?.filter((task) => task.status === "solved").length || 0}{" "}
                / {tasks?.length || 0}
              </span>
            </div>
            <div className="academic-stack">
              {tasks?.map((task) => (
                <button
                  key={task.id}
                  disabled={checking}
                  className="panel"
                  onClick={() => selectTask(task)}
                  style={{
                    padding: 18,
                    textAlign: "left",
                    cursor: "pointer",
                    borderColor:
                      current?.id === task.id ? "#81a38b" : undefined,
                    background: current?.id === task.id ? "#f1f6ed" : undefined,
                  }}
                >
                  <span className="academic-meta" style={{ marginBottom: 10 }}>
                    {statuses[task.status] || task.status} ·{" "}
                    {
                      difficulties.find(
                        (item) => item.value === task.difficulty,
                      )?.label
                    }
                  </span>
                  <SourceContext value={task.source_context} compact />
                  <span
                    style={{ fontSize: 13, lineHeight: 1.6, display: "block" }}
                  >
                    {task.question.length > 180
                      ? `${task.question.slice(0, 180)}…`
                      : task.question}
                  </span>
                </button>
              ))}
              {!tasks?.length && (
                <Empty title="Задач пока нет">
                  Создайте собственную задачу или выберите предмет и попросите
                  ИИ подготовить упражнения.
                </Empty>
              )}
            </div>
          </aside>
          <section className="study-editor panel" style={{ padding: 26 }}>
            {!current ? (
              <Empty title="Выберите задачу">
                <ListChecks size={30} style={{ margin: "15px auto" }} />
                Откройте задачу из списка, чтобы начать практику.
              </Empty>
            ) : (
              <>
                <SourceContext value={current.source_context} />
                <div className="academic-card-top">
                  <span className="badge">{statuses[current.status]}</span>
                  <div className="academic-actions">
                    <RecordEditor
                      disabled={checking}
                      compact
                      title="Редактировать задачу"
                      fields={[
                        ...taskFields,
                        {
                          name: "answer",
                          label: "Новый эталонный ответ",
                          type: "textarea",
                          omitWhenEmpty: true,
                          hint: "Оставьте пустым, чтобы сохранить существующий эталон.",
                        },
                      ]}
                      initial={{ ...current }}
                      endpoint={`/tasks/${current.id}`}
                      method="PATCH"
                      onSaved={async () => {
                        await reload();
                        setFeedback(null);
                        setAnswer("");
                      }}
                    />
                    <DeleteButton
                      disabled={checking}
                      title="Удалить задачу?"
                      endpoint={`/tasks/${current.id}`}
                      onDeleted={async () => {
                        setSelectedId(null);
                        await reload();
                      }}
                    />
                  </div>
                </div>
                <p
                  className="academic-prose"
                  style={{ fontSize: 17, margin: "25px 0" }}
                >
                  {current.question}
                </p>
                {current.hint && (
                  <div style={{ marginBottom: 20 }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setShowHint(!showHint)}
                    >
                      <Lightbulb size={15} />
                      {showHint ? "Скрыть подсказку" : "Показать подсказку"}
                    </button>
                    {showHint && (
                      <p className="academic-feedback">{current.hint}</p>
                    )}
                  </div>
                )}
                <label className="academic-field">
                  <span>Ваш ответ</span>
                  <textarea
                    className="field"
                    rows={7}
                    maxLength={20000}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    disabled={checking}
                    placeholder="Объясните решение своими словами…"
                  />
                </label>
                {feedback && (
                  <div className="academic-feedback" role="status">
                    <div className="academic-card-top">
                      <strong>{verdicts[feedback.verdict]}</strong>
                      <span>{feedback.score} / 100</span>
                    </div>
                    <p className="academic-prose" style={{ marginTop: 10 }}>
                      {feedback.feedback}
                    </p>
                  </div>
                )}
                <div className="academic-actions" style={{ marginTop: 22 }}>
                  <button
                    className="btn btn-primary"
                    disabled={checking || !answer.trim()}
                    onClick={submit}
                  >
                    <Send size={15} />
                    {checking ? "Проверяем…" : "Проверить ответ"}
                  </button>
                  <Link href="/dashboard/chat" className="btn btn-secondary">
                    <MessageSquare size={15} /> Спросить ИИ
                  </Link>
                  {feedback &&
                    tasks &&
                    tasks.findIndex((task) => task.id === current.id) <
                      tasks.length - 1 && (
                      <button
                        className="btn btn-secondary"
                        onClick={() =>
                          selectTask(
                            tasks[
                              tasks.findIndex(
                                (task) => task.id === current.id,
                              ) + 1
                            ],
                          )
                        }
                      >
                        Следующая <ChevronRight size={15} />
                      </button>
                    )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
