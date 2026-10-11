"use client";

import Link from "next/link";
import { useEffect } from "react";
import { setActivity } from "@/lib/context";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  FileText,
  GraduationCap,
  UserRound,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Empty,
  Loading,
  RecordEditor,
  DeleteButton,
  courseFields,
  weekFields,
  workFields,
  DetailBlock,
} from "@/components/academic";
import WorkCard from "@/components/work-card";
import WeekProgress from "@/components/week-progress";
import { LearningActions } from "@/components/learning-source";
import type { Course } from "@/types/academic";

export default function CoursePage() {
  const { groupId, courseId } = useParams<{
    groupId: string;
    courseId: string;
  }>();
  const router = useRouter();
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const {
    data: course,
    loading,
    error,
    reload,
  } = useResource<Course>(`/courses/${courseId}`);
  useEffect(() => {
    setActivity({ page: "course", course_id: Number(courseId) });
  }, [courseId]);
  if (loading) return <Loading />;
  if (!course)
    return <ErrorNotice message={error || "Дисциплина не найдена"} />;
  if (course.group_id !== Number(groupId))
    return (
      <ErrorNotice message="Эта дисциплина не относится к выбранной группе." />
    );
  return (
    <div>
      <Link
        className="academic-breadcrumb"
        href={`/dashboard/groups/${groupId}`}
      >
        <ArrowLeft size={14} />
        {course.group_name || "Назад к группе"}
      </Link>
      <PageTitle
        eyebrow="ДИСЦИПЛИНА"
        title={course.title}
        description="Темы занятий, задания, материалы и ваш прогресс по дисциплине."
      >
        {admin && (
          <>
            <RecordEditor
              title="Редактировать"
              fields={courseFields}
              initial={{ ...course }}
              endpoint={`/courses/${course.id}`}
              method="PUT"
              onSaved={reload}
            />
            <DeleteButton
              title="Удалить дисциплину?"
              description="Будут удалены занятия, программа, силабусы и работы этой дисциплины."
              endpoint={`/courses/${course.id}`}
              onDeleted={() => router.push(`/dashboard/groups/${groupId}`)}
            />
          </>
        )}
      </PageTitle>
      <ErrorNotice message={error} />
      <div className="academic-meta">
        <span>
          <UserRound size={15} />
          {course.teacher || "Преподаватель курса не указан"}
        </span>
        <span>
          <GraduationCap size={15} />
          {course.credits > 0
            ? `${course.credits} кредитов`
            : "Кредиты не указаны"}
        </span>
        <span>{course.weeks?.length || 0} недель в программе</span>
        <Link
          href={`/dashboard/syllabi?course=${course.id}`}
          className="btn btn-secondary"
          style={{ marginLeft: "auto" }}
        >
          <FileText size={15} /> Силабусы
        </Link>
      </div>
      <LearningActions selection={{ course_id: course.id }} />
      {!![...(course.weeks || []), ...(course.works || [])].some(
        (item) => item.module,
      ) && (
        <div className="panel" style={{ padding: 20, marginTop: 15 }}>
          <h3>Подготовка по модулю</h3>
          {[
            ...new Set(
              [...(course.weeks || []), ...(course.works || [])]
                .map((item) => item.module)
                .filter(Boolean),
            ),
          ].map((module) => (
            <div key={module}>
              <p className="muted" style={{ marginTop: 15 }}>
                {module}
              </p>
              <LearningActions
                selection={{ course_id: course.id, module }}
                compact
              />
            </div>
          ))}
        </div>
      )}
      {course.description && (
        <details className="panel academic-week" style={{ marginTop: 25 }}>
          <summary>
            <div>
              <h3>О дисциплине и требованиях</h3>
              <p>Описание программы, правила и примечания к источникам</p>
            </div>
            <ChevronDown size={17} />
          </summary>
          <div className="academic-week-content academic-prose">
            {course.description}
          </div>
        </details>
      )}
      <section className="academic-section">
        <div className="academic-section-heading">
          <h2>План по неделям</h2>
          {admin && (
            <RecordEditor
              title="Добавить неделю"
              fields={weekFields}
              initial={{
                week_number: (course.weeks?.length || 0) + 1,
                hours: 2,
              }}
              endpoint={`/courses/${course.id}/weeks`}
              onSaved={reload}
            />
          )}
        </div>
        {course.weeks?.length ? (
          course.weeks
            .slice()
            .sort((a, b) => a.week_number - b.week_number)
            .map((week) => (
              <details className="panel academic-week" key={week.id}>
                <summary>
                  <span className="academic-week-number">
                    {String(week.week_number).padStart(2, "0")}
                  </span>
                  <div>
                    <h3>{week.title}</h3>
                    <p>
                      {week.module ? `${week.module} · ` : ""}Неделя{" "}
                      {week.week_number}
                      {week.hours ? ` · ${week.hours} ч.` : ""}
                    </p>
                  </div>
                  <ChevronDown size={17} />
                </summary>
                <div className="academic-week-content">
                  <LearningActions
                    selection={{
                      course_id: course.id,
                      module: week.module,
                      week_numbers: [week.week_number],
                    }}
                    compact
                  />
                  <DetailBlock label="Содержание занятия">
                    {week.content}
                  </DetailBlock>
                  <DetailBlock label="Что нужно сделать">
                    {week.tasks}
                  </DetailBlock>
                  <DetailBlock label="Оценивание">
                    {week.assessment}
                  </DetailBlock>
                  <DetailBlock label="Материалы">{week.resources}</DetailBlock>
                  {!admin && <WeekProgress week={week} />}
                  {!week.content &&
                    !week.tasks &&
                    !week.assessment &&
                    !week.resources && (
                      <p className="muted">
                        Подробности занятия ещё не добавлены.
                      </p>
                    )}
                  {admin && (
                    <div className="academic-actions">
                      <RecordEditor
                        title="Редактировать неделю"
                        fields={weekFields}
                        initial={{ ...week }}
                        endpoint={`/weeks/${week.id}`}
                        method="PUT"
                        onSaved={reload}
                      />
                      <DeleteButton
                        title="Удалить неделю?"
                        endpoint={`/weeks/${week.id}`}
                        onDeleted={reload}
                      />
                    </div>
                  )}
                </div>
              </details>
            ))
        ) : (
          <Empty title="Учебная программа пока не опубликована">
            {admin
              ? "Добавьте недели вручную или загрузите силабус, проверьте извлечённую программу и опубликуйте её."
              : "Для этой дисциплины ещё не опубликован силабус. После его добавления появятся темы каждой недели, задания, критерии оценивания и материалы."}
          </Empty>
        )}
      </section>
      <section className="academic-section">
        <div className="academic-section-heading">
          <h2>Задания и модульные работы</h2>
          {admin && (
            <RecordEditor
              title="Создать работу"
              fields={workFields}
              initial={{ max_score: 100, kind: "assignment" }}
              endpoint={`/courses/${course.id}/works`}
              onSaved={reload}
            />
          )}
        </div>
        {course.works?.length ? (
          course.works.map((work) => (
            <WorkCard key={work.id} work={work} onChanged={reload} />
          ))
        ) : (
          <Empty title="Заданий пока нет">
            Когда появятся работы, вы сможете прочитать требования и отправить
            свой ответ здесь.
          </Empty>
        )}
      </section>
    </div>
  );
}
