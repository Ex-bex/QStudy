"use client";

import { Suspense, useState } from "react";
import {
  useParams,
  useRouter,
  usePathname,
  useSearchParams,
} from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  MapPin,
  Search,
  Users,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  civilDate,
  isoWeekStart,
  isoWeekNumber,
  shiftCivilDate,
  isEntryOnDate,
  scheduleTimeLabel,
  weekPatternLabel,
  timetableCsv,
} from "@/lib/timetable";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Empty,
  Loading,
  RecordEditor,
  DeleteButton,
  groupFields,
  courseFields,
  weekdays,
  type FieldDefinition,
} from "@/components/academic";
import { TimetableSourceInfo } from "@/components/timetable-source";
import type { GroupDetail } from "@/types/academic";

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("ru", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

export default function GroupPage() {
  return (
    <Suspense fallback={<Loading />}>
      <GroupContent />
    </Suspense>
  );
}

function GroupContent() {
  const { groupId } = useParams<{ groupId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const {
    data: group,
    loading,
    error,
    reload,
  } = useResource<GroupDetail>(`/groups/${groupId}`);
  const [today] = useState(() => civilDate());
  const [query, setQuery] = useState("");
  const requestedWeek = isoWeekStart(params.get("view_week") || "");
  const week =
    requestedWeek && shiftCivilDate(requestedWeek, 6)
      ? requestedWeek
      : isoWeekStart(today);
  const selectedDay = /^[1-7]$/.test(params.get("day") || "")
    ? params.get("day")!
    : "all";
  const updateView = (nextWeek: string, day = selectedDay) => {
    const normalized = isoWeekStart(nextWeek);
    if (!normalized || !shiftCivilDate(normalized, 6)) return;
    const next = new URLSearchParams(params.toString());
    next.set("view_week", normalized);
    if (day === "all") next.delete("day");
    else next.set("day", day);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  if (loading) return <Loading />;
  if (!group) return <ErrorNotice message={error || "Группа не найдена"} />;
  const scheduleFields: FieldDefinition[] = [
    {
      name: "course_id",
      label: "Дисциплина",
      type: "select",
      required: true,
      options: group.courses.map((course) => ({
        value: course.id,
        label: course.title,
      })),
    },
    {
      name: "day_of_week",
      label: "День недели",
      type: "select",
      options: weekdays.map((day, i) => ({ value: i + 1, label: day })),
    },
    {
      name: "start_times",
      label: "Начало занятий",
      type: "times",
      required: true,
      placeholder: "09:00 / 10:05",
      hint: "Перечислите все начала через /. Это отдельные временные слоты, а не начало и конец.",
    },
    {
      name: "end_time",
      label: "Окончание занятия",
      type: "time",
      nullable: true,
      hint: "Оставьте пустым, если время окончания неизвестно.",
    },
    { name: "teacher", label: "Преподаватель этого занятия" },
    { name: "room", label: "Кабинет" },
    {
      name: "lesson_type",
      label: "Тип занятия",
      required: true,
      placeholder: "Лекция, практика, лабораторная",
    },
    {
      name: "week_pattern",
      label: "Периодичность",
      type: "select",
      options: ["unspecified", "every", "odd", "even"].map((value) => ({
        value,
        label: weekPatternLabel(value),
      })),
      hint: "Чётность определяется номером календарной недели ISO.",
    },
    { name: "notes", label: "Примечания к занятию", type: "textarea" },
  ];
  const needle = query.normalize("NFKC").trim().toLocaleLowerCase("ru");
  const dayColumns = weekdays.flatMap((day, index) => {
    if (selectedDay !== "all" && Number(selectedDay) !== index + 1) return [];
    const date = shiftCivilDate(week, index);
    const lessons = group.schedule
      .filter(
        (entry) =>
          isEntryOnDate(entry, date) &&
          `${entry.course_title} ${entry.teacher || ""} ${entry.room} ${entry.notes || ""}`
            .normalize("NFKC")
            .toLocaleLowerCase("ru")
            .includes(needle),
      )
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
    return [{ day, date, lessons }];
  });
  const visibleCount = dayColumns.reduce(
    (sum, day) => sum + day.lessons.length,
    0,
  );
  function downloadCsv() {
    if (!group) return;
    const url = URL.createObjectURL(
      new Blob([timetableCsv(group.schedule)], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `QStudy-${group.name.replace(/[^\p{L}\p{N}_-]/gu, "_")}-расписание.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  return (
    <div>
      <Link className="academic-breadcrumb" href="/dashboard/groups">
        <ArrowLeft size={14} /> Все группы
      </Link>
      <PageTitle
        eyebrow="ВАШ УЧЕБНЫЙ МАРШРУТ"
        title={group.name}
        description={
          group.program ||
          group.description ||
          "Расписание на неделю и все дисциплины вашей группы."
        }
      >
        {admin && (
          <>
            <RecordEditor
              title="Редактировать"
              fields={groupFields}
              initial={{ ...group }}
              method="PUT"
              endpoint={`/groups/${group.id}`}
              onSaved={reload}
            />
            <DeleteButton
              title="Удалить группу?"
              description="Будут удалены дисциплины, расписание и учебный план этой группы."
              endpoint={`/groups/${group.id}`}
              onDeleted={() => router.push("/dashboard/groups")}
            />
          </>
        )}
      </PageTitle>
      <ErrorNotice message={error} />
      <div className="academic-banner">
        <div>
          <h2>Расписание и учебная программа</h2>
          <p>
            {[
              group.academic_year,
              group.study_year == null
                ? "Курс обучения не подтверждён"
                : `${group.study_year} курс`,
              group.semester == null ? "" : `Семестр: ${group.semester}`,
              group.curator ? `Куратор: ${group.curator}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="academic-meta">
          <span>
            <Users size={16} /> Студентов: {group.student_count}
          </span>
          <span>
            <BookOpen size={16} /> Дисциплин: {group.courses.length}
          </span>
        </div>
      </div>
      {!!group.warnings?.length && (
        <div className="academic-source-warning" role="note">
          <strong>В исходном расписании есть уточнения</strong>
          <ul>
            {group.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <section className="academic-section">
        <div className="academic-section-heading">
          <h2>Расписание занятий</h2>
          <div className="academic-actions">
            {!!group.schedule.length && (
              <button
                className="btn btn-secondary"
                onClick={downloadCsv}
                title="Скачать все записи группы: без фильтров и выдуманных календарных дат"
              >
                <Download size={16} /> Скачать CSV
              </button>
            )}
            {admin && !!group.courses.length && (
              <RecordEditor
                title="Добавить занятие"
                fields={scheduleFields}
                initial={{
                  start_times: ["09:00"],
                  end_time: "",
                  lesson_type: "Практика",
                  week_pattern: "unspecified",
                }}
                endpoint={`/groups/${group.id}/schedule`}
                onSaved={reload}
              />
            )}
          </div>
        </div>
        {group.schedule.length ? (
          <>
            <div className="panel academic-timetable-controls">
              <div className="academic-week-nav">
                <button
                  className="academic-icon-button"
                  aria-label="Предыдущая неделя"
                  onClick={() => updateView(shiftCivilDate(week, -7))}
                >
                  <ChevronLeft size={18} />
                </button>
                <label className="academic-field">
                  <span>Календарная неделя · ISO {isoWeekNumber(week)}</span>
                  <input
                    className="field"
                    type="date"
                    aria-label="Дата в выбранной неделе"
                    value={week}
                    onChange={(e) => updateView(e.target.value)}
                  />
                </label>
                <button
                  className="academic-icon-button"
                  aria-label="Следующая неделя"
                  onClick={() => updateView(shiftCivilDate(week, 7))}
                >
                  <ChevronRight size={18} />
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => updateView(today, "all")}
                >
                  <CalendarDays size={15} /> Эта неделя
                </button>
              </div>
              <div className="academic-timetable-filters">
                <label className="academic-field">
                  <span>День недели</span>
                  <select
                    className="field"
                    value={selectedDay}
                    onChange={(e) => updateView(week, e.target.value)}
                  >
                    <option value="all">Вся неделя</option>
                    {weekdays.map((day, i) => (
                      <option key={day} value={i + 1}>
                        {day}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="academic-field">
                  <span>Найти занятие</span>
                  <div className="academic-search-input">
                    <Search size={16} />
                    <input
                      className="field"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Предмет, преподаватель, кабинет"
                    />
                  </div>
                </label>
              </div>
              <p className="muted" role="status">
                {dateLabel(week)} {week.slice(0, 4)} —{" "}
                {dateLabel(shiftCivilDate(week, 6))}{" "}
                {shiftCivilDate(week, 6).slice(0, 4)} · Записей: {visibleCount}{" "}
                · UTC+5
              </p>
            </div>
            <p className="muted academic-timetable-caption">
              Время через «/» обозначает несколько начал занятий. Периодичность
              и границы учебного периода в исходном справочнике не заданы;
              показанные даты служат для просмотра недельного шаблона.
            </p>
            {visibleCount ? (
              <div
                className={`academic-schedule${selectedDay !== "all" ? " academic-schedule-single" : ""}`}
              >
                {dayColumns
                  .filter((column) => column.lessons.length > 0)
                  .map(({ day, date, lessons }) => (
                    <div className="panel academic-day" key={day}>
                      <h3>
                        {day}
                        <span>
                          {dateLabel(date)}
                          {date === today ? " · Сегодня" : ""}
                        </span>
                      </h3>
                      {lessons.map((lesson) => (
                        <article className="academic-lesson" key={lesson.id}>
                          <div className="academic-lesson-time">
                            <div>
                              <small>
                                {lesson.end_time
                                  ? "Время занятия"
                                  : "Начало занятий"}
                              </small>
                              <strong>{scheduleTimeLabel(lesson)}</strong>
                            </div>
                            {admin && (
                              <div className="academic-actions">
                                <RecordEditor
                                  compact
                                  title="Редактировать занятие"
                                  fields={scheduleFields}
                                  initial={{
                                    ...lesson,
                                    start_times: lesson.start_times?.length
                                      ? lesson.start_times
                                      : [lesson.start_time],
                                  }}
                                  method="PUT"
                                  endpoint={`/schedule/${lesson.id}`}
                                  onSaved={reload}
                                />
                                <DeleteButton
                                  title="Удалить занятие?"
                                  endpoint={`/schedule/${lesson.id}`}
                                  onDeleted={reload}
                                />
                              </div>
                            )}
                          </div>
                          <Link
                            href={`/dashboard/groups/${group.id}/courses/${lesson.course_id}`}
                          >
                            {lesson.course_title ||
                              group.courses.find(
                                (course) => course.id === lesson.course_id,
                              )?.title}
                            <ArrowUpRight
                              size={14}
                              style={{ display: "inline", marginLeft: 7 }}
                            />
                          </Link>
                          <p className="academic-lesson-teacher">
                            <Users size={13} />
                            {lesson.teacher || "Преподаватель не указан"}
                          </p>
                          <div className="academic-meta">
                            <span>
                              <MapPin size={13} />
                              {lesson.room || "Кабинет не указан"}
                            </span>
                            {lesson.lesson_type && (
                              <span>{lesson.lesson_type}</span>
                            )}
                            <span>{weekPatternLabel(lesson.week_pattern)}</span>
                          </div>
                          {lesson.notes && (
                            <p className="academic-lesson-notes">
                              {lesson.notes}
                            </p>
                          )}
                          {!!(
                            lesson.source_file ||
                            lesson.source_name ||
                            lesson.warnings?.length
                          ) && (
                            <details className="academic-source-details">
                              <summary>Исходная запись</summary>
                              <p>
                                {lesson.source_file || lesson.source_name}
                                {lesson.source_sheet
                                  ? ` · Лист: ${lesson.source_sheet}`
                                  : ""}
                                {lesson.source_cell
                                  ? ` · Ячейка: ${lesson.source_cell}`
                                  : ""}
                                {lesson.source_row_id
                                  ? ` · Запись: ${lesson.source_row_id}`
                                  : ""}
                              </p>
                              {lesson.source_updated_at && (
                                <p>
                                  Обновление источника:{" "}
                                  {lesson.source_updated_at}
                                </p>
                              )}
                              {lesson.source_raw && (
                                <p className="academic-source-raw">
                                  {lesson.source_raw}
                                </p>
                              )}
                              {!!lesson.warnings?.length && (
                                <ul>
                                  {lesson.warnings.map((warning, i) => (
                                    <li key={i}>{warning}</li>
                                  ))}
                                </ul>
                              )}
                            </details>
                          )}
                        </article>
                      ))}
                    </div>
                  ))}
              </div>
            ) : (
              <Empty title="По выбранным условиям занятий нет">
                Измените день, календарную неделю или поисковый запрос.
              </Empty>
            )}
            <TimetableSourceInfo warnings={group.warnings} />
          </>
        ) : (
          <Empty title="Расписание скоро появится">
            {admin
              ? "Добавьте дисциплины, затем укажите время занятий и кабинеты."
              : "Администратор ещё не добавил занятия для этой группы."}
          </Empty>
        )}
      </section>
      <section className="academic-section">
        <div className="academic-section-heading">
          <h2>Дисциплины</h2>
          {admin && (
            <RecordEditor
              title="Добавить дисциплину"
              fields={courseFields}
              initial={{ credits: 0 }}
              endpoint={`/groups/${group.id}/courses`}
              onSaved={reload}
            />
          )}
        </div>
        {group.courses.length ? (
          <div className="academic-grid">
            {group.courses.map((course) => (
              <article className="panel academic-card" key={course.id}>
                <div className="academic-card-top">
                  <div className="academic-card-icon">
                    <BookOpen size={21} />
                  </div>
                  {admin && (
                    <div className="academic-actions">
                      <RecordEditor
                        compact
                        title="Редактировать дисциплину"
                        fields={courseFields}
                        initial={{ ...course }}
                        method="PUT"
                        endpoint={`/courses/${course.id}`}
                        onSaved={reload}
                      />
                      <DeleteButton
                        title="Удалить дисциплину?"
                        description="Будут удалены её занятия, недельный план, силабусы и работы."
                        endpoint={`/courses/${course.id}`}
                        onDeleted={reload}
                      />
                    </div>
                  )}
                </div>
                <div>
                  <h3>{course.title}</h3>
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    {course.teacher ||
                      (group.schedule.some(
                        (entry) =>
                          entry.course_id === course.id && entry.teacher,
                      )
                        ? "Преподаватели — в расписании"
                        : "Преподаватель курса не указан")}
                  </p>
                </div>
                {course.description && (
                  <p
                    className="muted academic-clamp-three"
                    style={{ fontSize: 13, lineHeight: 1.6 }}
                  >
                    {course.description}
                  </p>
                )}
                <Link
                  href={`/dashboard/groups/${group.id}/courses/${course.id}`}
                  className="academic-card-link"
                >
                  Программа и задания <ArrowUpRight size={17} />
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="Пока нет дисциплин">
            Программа появится после добавления дисциплин администратором.
          </Empty>
        )}
      </section>
    </div>
  );
}
