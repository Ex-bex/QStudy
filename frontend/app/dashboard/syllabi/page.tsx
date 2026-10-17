"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowUpRight, FileUp, Sparkles } from "lucide-react";
import { useAuth, type User } from "@/lib/auth";
import { api } from "@/lib/api";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Empty,
  Loading,
  errorMessage,
} from "@/components/academic";
import SyllabusDocument from "@/components/syllabus-document";
import type { Course, Group, GroupDetail, Syllabus } from "@/types/academic";

export default function SyllabiPage() {
  const { user } = useAuth();
  return (
    <SyllabiContent
      key={`${user.id}:${user.role}:${user.group_id ?? "unassigned"}`}
      user={user}
    />
  );
}

function SyllabiContent({ user }: { user: User }) {
  const admin = user.role === "admin";
  const [courseId, setCourseId] = useState("");
  const [courses, setCourses] = useState<Course[]>([]);
  const [coursesLoading, setCoursesLoading] = useState(true);
  const [coursesError, setCoursesError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [success, setSuccess] = useState("");
  const selectedCourse = courses.some(
    (course) => String(course.id) === courseId,
  )
    ? courseId
    : "";
  const query = new URLSearchParams();
  if (selectedCourse) query.set("course_id", selectedCourse);
  if (!admin && user.group_id) query.set("group_id", String(user.group_id));
  const canLoad =
    admin || Boolean(user.group_id && !coursesLoading && !coursesError);
  const {
    data: documents,
    loading,
    error,
    reload,
  } = useResource<Syllabus[]>(canLoad ? `/syllabi?${query.toString()}` : null);
  const importing = documents?.some((document) =>
    ["queued", "running"].includes(document.status),
  );
  useEffect(() => {
    if (!importing) return;
    const timer = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(timer);
  }, [importing, reload]);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const details = admin
          ? await api<Group[]>("/groups").then((groups) =>
              Promise.all(
                groups.map((group) => api<GroupDetail>(`/groups/${group.id}`)),
              ),
            )
          : user.group_id
            ? [await api<GroupDetail>(`/groups/${user.group_id}`)]
            : [];
        if (active) {
          const availableCourses = details.flatMap((group) =>
            group.courses.map((course) => ({
              ...course,
              group_name: group.name,
            })),
          );
          setCourses(availableCourses);
          const selected = new URLSearchParams(window.location.search).get(
            "course",
          );
          if (
            selected &&
            availableCourses.some((course) => String(course.id) === selected)
          )
            setCourseId(selected);
        }
      } catch (e) {
        if (active) setCoursesError(errorMessage(e));
      } finally {
        if (active) setCoursesLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [admin, user.group_id]);
  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const element = e.currentTarget;
    const form = new FormData(element);
    const file = form.get("file") as File;
    setUploadError("");
    setSuccess("");
    if (!file?.size) {
      setUploadError("Файл пустой. Выберите PDF или DOCX с содержимым.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setUploadError("Максимальный размер документа — 20 МБ.");
      return;
    }
    setBusy(true);
    try {
      const document = await api<Syllabus>("/syllabi/upload", {
        method: "POST",
        body: form,
      });
      await reload();
      element.reset();
      setSuccess(
        document.duplicate
          ? "Этот документ уже загружен в выбранную дисциплину. Откройте его, чтобы увидеть результат импорта."
          : document.status === "needs_configuration"
            ? "Документ сохранён. Для автоматического импорта настройте ключ ИИ на сервере, затем повторите импорт в карточке документа."
            : document.status === "needs_ocr"
              ? "Документ сохранён. Откройте его карточку: для PDF доступно автоматическое распознавание текста. Если текст не распознаётся, проверьте качество документа."
              : "Силабус загружен. ИИ автоматически добавит недели и работы в выбранную дисциплину. Если учебный план уже есть, результат останется черновиком для проверки.",
      );
    } catch (e) {
      setUploadError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <PageTitle
        eyebrow="ИСТОЧНИК УЧЕБНОЙ ПРОГРАММЫ"
        title="Силабусы"
        description="От учебного документа — к понятному плану на каждую неделю."
      >
        <Link
          href={
            !admin && user.group_id
              ? `/dashboard/groups/${user.group_id}`
              : "/dashboard/groups"
          }
          className="btn btn-secondary"
        >
          {!admin && user.group_id ? "Моя группа" : "К группам"}{" "}
          <ArrowUpRight size={16} />
        </Link>
      </PageTitle>
      {admin && (
        <section className="panel" style={{ padding: 26, marginBottom: 28 }}>
          <div className="academic-section-heading">
            <div>
              <h2>Добавить силабус</h2>
              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Выберите дисциплину и загрузите документ. ИИ извлечёт программу
                и автоматически добавит недели и работы. Если план уже заполнен,
                система сохранит черновик для проверки.
              </p>
            </div>
            <Sparkles size={23} color="#638361" />
          </div>
          {coursesLoading ? (
            <Loading />
          ) : courses.length ? (
            <form onSubmit={upload} className="academic-stack">
              <div className="form-grid">
                <label className="academic-field">
                  <span>Дисциплина</span>
                  <select
                    name="course_id"
                    className="field"
                    defaultValue={selectedCourse}
                    required
                    key={selectedCourse}
                  >
                    <option value="">Выберите дисциплину</option>
                    {courses.map((course) => (
                      <option value={course.id} key={course.id}>
                        {course.title} · {course.group_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="academic-field">
                  <span>Название документа</span>
                  <input
                    className="field"
                    name="title"
                    maxLength={200}
                    placeholder="Например, Силабус на 2026–2027"
                  />
                </label>
              </div>
              <label className="academic-upload">
                <FileUp size={29} color="#52754c" />
                <strong style={{ fontSize: 15 }}>
                  Выберите учебный документ
                </strong>
                <input
                  type="file"
                  name="file"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  required
                />
                <p>
                  PDF или DOCX до 20 МБ. Текст сканированных PDF распознаётся
                  автоматически.
                </p>
              </label>
              <button
                className="btn btn-primary"
                style={{ justifySelf: "start" }}
                disabled={busy}
              >
                <FileUp size={16} />
                {busy ? "Загружаем и читаем документ…" : "Загрузить силабус"}
              </button>
            </form>
          ) : (
            <Empty title="Сначала добавьте дисциплину">
              Создайте дисциплину на странице группы, чтобы связать с ней
              силабус.
            </Empty>
          )}
        </section>
      )}
      <ErrorNotice message={coursesError} />
      <ErrorNotice message={uploadError} />
      {success && (
        <p className="academic-success" role="status">
          {success}
        </p>
      )}
      {!admin && !user.group_id ? (
        <Empty title="Учебная группа пока не назначена">
          Попросите администратора назначить вашу группу в настройках аккаунта.
          После назначения здесь появятся опубликованные силабусы её дисциплин,
          а на странице группы — расписание и учебные модули.
        </Empty>
      ) : (
        <>
          <div className="academic-section-heading">
            <h2>{admin ? "Документы и черновики" : "Учебные документы"}</h2>
          </div>
          <div className="academic-filter">
            <label className="academic-field">
              <span className="sr-only">Фильтр по дисциплине</span>
              <select
                className="field"
                value={selectedCourse}
                onChange={(e) => setCourseId(e.target.value)}
              >
                <option value="">
                  {admin ? "Все дисциплины" : "Все дисциплины моей группы"}
                </option>
                {courses.map((course) => (
                  <option value={course.id} key={course.id}>
                    {course.title} · {course.group_name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ErrorNotice message={error} />
          {loading || coursesLoading ? (
            <Loading />
          ) : documents?.length ? (
            documents.map((document) => (
              <SyllabusDocument
                key={document.id}
                document={document}
                onChanged={reload}
              />
            ))
          ) : (
            <Empty
              title={
                admin
                  ? "Силабусы ещё не добавлены"
                  : "Силабусы ещё не опубликованы"
              }
            >
              {admin
                ? "Выберите дисциплину и загрузите её силабус. Автоматический импорт заполнит учебные недели и работы."
                : "Учебные документы появятся здесь после обработки и публикации силабуса."}
            </Empty>
          )}
        </>
      )}
    </div>
  );
}
