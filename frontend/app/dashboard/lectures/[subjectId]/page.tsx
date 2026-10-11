"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ArrowUpRight, FileText } from "lucide-react";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Empty,
  Loading,
} from "@/components/academic";
import type { Subject, Topic, Lecture } from "@/types";

export default function SubjectLecturesPage() {
  const { subjectId } = useParams<{ subjectId: string }>();
  const { data: subjects } = useResource<Subject[]>("/subjects");
  const {
    data: topics,
    loading,
    error,
  } = useResource<Topic[]>(`/subjects/${subjectId}/topics`);
  const { data: lectures, error: lectureError } =
    useResource<Lecture[]>("/lectures");
  const subject = subjects?.find((item) => item.id === Number(subjectId));
  return (
    <div>
      <Link className="academic-breadcrumb" href="/dashboard/lectures">
        <ArrowLeft size={14} /> Все лекции
      </Link>
      <PageTitle
        eyebrow="ТЕМЫ ПРЕДМЕТА"
        title={subject?.name || "Лекции по предмету"}
        description="Каждая тема — отдельная лекция с вашим конспектом и обсуждением."
      />
      <ErrorNotice message={error || lectureError} />
      {loading ? (
        <Loading />
      ) : topics?.length ? (
        <div className="academic-stack">
          {topics.map((topic, index) => {
            const lecture = lectures?.find(
              (item) => item.topic_id === topic.id,
            );
            return (
              <Link
                className="panel academic-lecture-row"
                key={topic.id}
                href={`/dashboard/lectures/${subjectId}/${topic.id}`}
              >
                <span className="academic-week-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3>{topic.title}</h3>
                  {topic.description && (
                    <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>
                      {topic.description}
                    </p>
                  )}
                </div>
                <span className="badge">
                  {lecture?.status === "generating"
                    ? "Составляется"
                    : lecture?.status === "error"
                      ? "Нужна повторная попытка"
                      : lecture?.status === "ready"
                        ? "Готова"
                        : "Создать лекцию"}
                </span>
                <ArrowUpRight size={17} />
              </Link>
            );
          })}
        </div>
      ) : (
        <Empty title="Темы ещё не добавлены">
          <FileText size={28} style={{ margin: "15px auto" }} />
          Администратор добавляет темы в разделе предметов.
        </Empty>
      )}
    </div>
  );
}
