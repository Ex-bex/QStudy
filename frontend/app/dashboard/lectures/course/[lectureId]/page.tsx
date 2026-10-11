"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { ArrowLeft } from "lucide-react";
import {
  DeleteButton,
  ErrorNotice,
  Loading,
  PageTitle,
  RecordEditor,
  useResource,
} from "@/components/academic";
import { LearningActions, SourceContext } from "@/components/learning-source";
import { setActivity } from "@/lib/context";
import {
  learningSelectionFromSource,
  learningSourceActivity,
} from "@/lib/learning-selection";
import { useJobRefresh } from "@/lib/notifications";
import type { Lecture } from "@/types";

export default function CourseLecturePage() {
  const { lectureId } = useParams<{ lectureId: string }>();
  const router = useRouter();
  const {
    data: lecture,
    loading,
    error,
    reload,
  } = useResource<Lecture>(`/lectures/${lectureId}`);
  useJobRefresh("lecture", reload);
  const provenance = lecture?.source_context;
  const title =
    provenance?.course_title ||
    lecture?.subject_name ||
    provenance?.subject_titles?.join(", ") ||
    "Учебный конспект";
  useEffect(() => {
    if (!lecture) return;
    setActivity({
      page: "lectures",
      ...learningSourceActivity(lecture.source_context),
      lecture: { title, content: lecture.content.slice(0, 9000) },
    });
  }, [lecture, title]);
  useEffect(() => {
    if (lecture?.status !== "generating") return;
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [lecture?.status, reload]);
  if (loading) return <Loading />;
  if (!lecture) return <ErrorNotice message={error || "Лекция недоступна"} />;
  return (
    <div>
      <Link href="/dashboard/lectures" className="academic-breadcrumb">
        <ArrowLeft size={14} /> Все лекции
      </Link>
      <PageTitle
        eyebrow="МОЙ КОНСПЕКТ"
        title={title}
        description="Лекция по выбранной учебной программе. Можно уточнить содержание и подготовиться по тем же темам."
      >
        <RecordEditor
          disabled={lecture.status === "generating"}
          title="Редактировать конспект"
          fields={[
            {
              name: "content",
              label: "Текст лекции",
              type: "textarea",
              required: true,
            },
          ]}
          initial={{ content: lecture.content }}
          endpoint={`/lectures/${lecture.id}`}
          method="PATCH"
          onSaved={reload}
        />
        <DeleteButton
          disabled={lecture.status === "generating"}
          title="Удалить конспект?"
          endpoint={`/lectures/${lecture.id}`}
          onDeleted={() => router.push("/dashboard/lectures")}
        />
      </PageTitle>
      <ErrorNotice message={error} />
      {lecture.status === "error" && (
        <ErrorNotice message="Генерация лекции не завершена. Сохранённый текст доступен ниже. Откройте «Задания ИИ» для причины ошибки или создайте лекцию заново с этой программой." />
      )}
      <SourceContext value={provenance} />
      {provenance?.course_id ? (
        <LearningActions
          selection={{
            ...learningSelectionFromSource(provenance),
          }}
        />
      ) : (
        <Link href="/dashboard/chat" className="btn btn-secondary">
          Разобрать с ИИ
        </Link>
      )}
      <article
        className="panel academic-prose"
        style={{
          padding: "clamp(20px, 4vw, 40px)",
          marginTop: 22,
          overflowWrap: "anywhere",
        }}
      >
        {lecture.status === "generating" ? (
          <p className="muted">
            ИИ готовит лекцию. Задача сохранена и продолжит работу после
            перезапуска.
          </p>
        ) : (
          <ReactMarkdown>
            {lecture.content || "Конспект пока пуст."}
          </ReactMarkdown>
        )}
      </article>
    </div>
  );
}
