"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, BookOpen, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { setActivity } from "@/lib/context";
import { useJobRefresh } from "@/lib/notifications";
import {
  LearningSourceSelector,
  SourceContext,
  useLearningSource,
} from "@/components/learning-source";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Empty,
  Loading,
  errorMessage,
} from "@/components/academic";
import type { Subject, Topic, Lecture } from "@/types";

export default function LecturesPage() {
  const source = useLearningSource();
  const {
    data: subjects,
    loading,
    error,
  } = useResource<Subject[]>("/subjects");
  const {
    data: lectures,
    error: lectureError,
    reload: reloadLectures,
  } = useResource<Lecture[]>("/lectures");
  const [topics, setTopics] = useState<Record<number, Topic[]>>({});
  const [topicError, setTopicError] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [notice, setNotice] = useState("");
  useJobRefresh("lecture", reloadLectures);
  useEffect(() => {
    setActivity({
      page: "lectures",
      course_id: source.courseMode
        ? source.selection.course_id || undefined
        : undefined,
      module: source.courseMode ? source.selection.module : undefined,
      week_numbers: source.courseMode
        ? source.selection.week_numbers
        : undefined,
      work_ids: source.courseMode ? source.selection.work_ids : undefined,
      use_web: source.selection.use_web,
    });
  }, [source.courseMode, source.selection]);
  useEffect(() => {
    let active = true;
    if (!subjects) return;
    Promise.all(
      subjects.map(async (subject) => ({
        id: subject.id,
        topics: await api<Topic[]>(`/subjects/${subject.id}/topics`),
      })),
    )
      .then((rows) => {
        if (active)
          setTopics(
            Object.fromEntries(rows.map((row) => [row.id, row.topics])),
          );
      })
      .catch((e) => {
        if (active) setTopicError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [subjects]);
  async function generate() {
    if (
      (source.courseMode && source.selectionError) ||
      (!source.courseMode && !subjectId)
    ) {
      setGenerationError(
        source.courseMode ? source.selectionError : "Выберите предмет.",
      );
      return;
    }
    setGenerating(true);
    setGenerationError("");
    try {
      await api("/lectures/generate", {
        method: "POST",
        body: JSON.stringify({
          ...source.payload,
          subject_ids: source.courseMode ? [] : [Number(subjectId)],
          topic_ids: !source.courseMode && topicId ? [Number(topicId)] : [],
        }),
      });
      setNotice(
        "Лекция сохранена в очереди ИИ. Готовый конспект появится ниже; состояние задачи доступно в разделе «Задания ИИ».",
      );
      await reloadLectures();
    } catch (e) {
      setGenerationError(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  }
  return (
    <div>
      <PageTitle
        eyebrow="ЛИЧНАЯ БАЗА ЗНАНИЙ"
        title="Лекции"
        description="Создавайте конспекты по силабусу или своим предметам, дополняйте их и разбирайте вместе с ИИ."
      />
      <div className="panel" style={{ padding: 22, marginBottom: 24 }}>
        <LearningSourceSelector source={source} disabled={generating} />
        <div className="academic-filter" style={{ marginBottom: 0 }}>
          {!source.courseMode && (
            <>
              <select
                className="field"
                aria-label="Предмет для лекции"
                value={subjectId}
                onChange={(event) => {
                  setSubjectId(event.target.value);
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
                aria-label="Тема для лекции"
                disabled={!subjectId}
                value={topicId}
                onChange={(event) => setTopicId(event.target.value)}
              >
                <option value="">Все темы</option>
                {(topics[Number(subjectId)] || []).map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.title}
                  </option>
                ))}
              </select>
            </>
          )}
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
            {generating ? "Добавляем в очередь…" : "Создать лекцию с ИИ"}
          </button>
        </div>
        {notice && (
          <p
            className="academic-success"
            role="status"
            style={{ marginTop: 14 }}
          >
            {notice} <Link href="/dashboard/jobs">Открыть задания</Link>
          </p>
        )}
      </div>
      <ErrorNotice
        message={generationError || error || lectureError || topicError}
      />
      {!!lectures?.some((lecture) => lecture.topic_id === null) && (
        <section className="academic-section">
          <div className="academic-section-heading">
            <h2>Мои конспекты по программе</h2>
          </div>
          <div className="academic-grid">
            {lectures
              .filter((lecture) => lecture.topic_id === null)
              .map((lecture) => (
                <article className="panel academic-card" key={lecture.id}>
                  <h3>
                    {lecture.source_context?.course_title ||
                      lecture.subject_name ||
                      lecture.source_context?.subject_titles?.join(", ") ||
                      "Учебный конспект"}
                  </h3>
                  <SourceContext value={lecture.source_context} />
                  <p className="muted">
                    {lecture.status === "ready"
                      ? lecture.content.slice(0, 180)
                      : "ИИ составляет лекцию…"}
                  </p>
                  <Link
                    href={`/dashboard/lectures/course/${lecture.id}`}
                    className="academic-card-link"
                  >
                    Открыть конспект <ArrowUpRight size={17} />
                  </Link>
                </article>
              ))}
          </div>
        </section>
      )}
      <div className="academic-section-heading">
        <h2>Лекции по предметам</h2>
      </div>
      {loading ? (
        <Loading />
      ) : subjects?.length ? (
        <div className="academic-grid">
          {subjects.map((subject) => (
            <article className="panel academic-card" key={subject.id}>
              <div className="academic-card-icon">
                <BookOpen size={22} />
              </div>
              <h3>{subject.name}</h3>
              <div className="academic-meta">
                <span>{topics[subject.id]?.length ?? "—"} тем</span>
                <span>
                  {
                    (topics[subject.id] || []).filter((topic) =>
                      lectures?.some(
                        (lecture) =>
                          lecture.topic_id === topic.id &&
                          lecture.status === "ready",
                      ),
                    ).length
                  }{" "}
                  готовых лекций
                </span>
              </div>
              <Link
                className="academic-card-link"
                href={`/dashboard/lectures/${subject.id}`}
              >
                Открыть лекции <ArrowUpRight size={17} />
              </Link>
            </article>
          ))}
        </div>
      ) : (
        <Empty title="Предметы ещё не добавлены">
          После добавления предметов и тем администратором здесь можно будет
          создавать собственные лекции.
        </Empty>
      )}
    </div>
  );
}
