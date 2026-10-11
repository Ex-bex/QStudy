"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, ExternalLink, Globe, Sparkles } from "lucide-react";
import { ErrorNotice, useResource } from "@/components/academic";
import {
  emptyLearningSelection,
  learningHref,
  learningSelectionError,
  learningSelectionFromQuery,
  safeResearchUrl,
} from "@/lib/learning-selection";
import type {
  LearningCourseOption,
  LearningSelection,
  LearningSourceContext,
} from "@/types/learning";
import { getActivity } from "@/lib/context";

export function useLearningSource(fromActivity = false) {
  const [selection, setSelection] = useState<LearningSelection>(
    emptyLearningSelection,
  );
  const [courseMode, setCourseMode] = useState(false);
  const resource = useResource<{ courses: LearningCourseOption[] }>(
    "/learning/options",
  );
  useEffect(() => {
    let initial = learningSelectionFromQuery(window.location.search);
    const activity = fromActivity ? getActivity() : null;
    if (!initial.course_id && activity?.course_id)
      initial = learningSelectionFromQuery(
        learningHref("", {
          course_id: activity.course_id,
          module: activity.module,
          week_numbers:
            activity.week_numbers ||
            (activity.week_number ? [activity.week_number] : []),
          work_ids: activity.work_ids,
          use_web: activity.use_web,
        }).slice(1),
      );
    queueMicrotask(() => {
      setSelection(initial);
      setCourseMode(Boolean(initial.course_id));
    });
  }, [fromActivity]);
  const courses = resource.data?.courses || [];
  const selectionError = courseMode
    ? learningSelectionError(selection, courses)
    : "";
  return {
    selection,
    setSelection,
    courseMode,
    setCourseMode,
    courses,
    loading: resource.loading,
    error: resource.error,
    selectionError,
    payload: courseMode
      ? selection
      : { ...emptyLearningSelection(), use_web: selection.use_web },
    course: courses.find((course) => course.id === selection.course_id),
  };
}

export function LearningSourceSelector({
  source,
  disabled = false,
}: {
  source: ReturnType<typeof useLearningSource>;
  disabled?: boolean;
}) {
  const [groupId, setGroupId] = useState("");
  const {
    selection,
    setSelection,
    courseMode,
    setCourseMode,
    courses,
    course,
  } = source;
  const groups = [
    ...new Map(
      courses.map((item) => [item.group_id, item.group_name]),
    ).entries(),
  ];
  const activeGroup = groupId || (course ? String(course.group_id) : "");
  const weeks = (course?.weeks || []).filter(
    (week) => !selection.module || week.module === selection.module,
  );
  const works = (course?.works || []).filter(
    (work) =>
      (!selection.module || work.module === selection.module) &&
      (!selection.week_numbers.length ||
        (work.week_number !== null &&
          selection.week_numbers.includes(work.week_number))),
  );
  const labelStyle = { flex: "1 1 220px", minWidth: 0 };
  const fieldStyle = { width: "100%", minWidth: 0, maxWidth: "none" };
  function toggle(values: number[], id: number) {
    return values.includes(id)
      ? values.filter((value) => value !== id)
      : [...values, id];
  }
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        className="academic-tabs"
        style={{ marginBottom: 15 }}
        aria-label="Источник учебного материала"
      >
        <button
          type="button"
          className={courseMode ? "active" : ""}
          disabled={disabled}
          onClick={() => setCourseMode(true)}
        >
          <BookOpen size={14} /> По силабусу
        </button>
        <button
          type="button"
          className={!courseMode ? "active" : ""}
          disabled={disabled}
          onClick={() => setCourseMode(false)}
        >
          Мои предметы
        </button>
      </div>
      {courseMode && (
        <>
          <ErrorNotice message={source.error} />
          {source.loading ? (
            <p className="muted">Загружаем доступную программу…</p>
          ) : (
            <>
              <div className="academic-filter">
                <label className="academic-field" style={labelStyle}>
                  <span>Группа</span>
                  <select
                    className="field"
                    style={fieldStyle}
                    value={activeGroup}
                    disabled={disabled}
                    onChange={(event) => {
                      setGroupId(event.target.value);
                      setSelection({
                        ...emptyLearningSelection(),
                        use_web: selection.use_web,
                      });
                    }}
                  >
                    <option value="">Все доступные группы</option>
                    {groups.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="academic-field" style={labelStyle}>
                  <span>Дисциплина</span>
                  <select
                    className="field"
                    style={fieldStyle}
                    value={selection.course_id || ""}
                    disabled={disabled}
                    onChange={(event) =>
                      setSelection({
                        ...emptyLearningSelection(),
                        use_web: selection.use_web,
                        course_id: event.target.value
                          ? Number(event.target.value)
                          : null,
                      })
                    }
                  >
                    <option value="">Выберите дисциплину</option>
                    {courses
                      .filter(
                        (item) =>
                          !activeGroup || String(item.group_id) === activeGroup,
                      )
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                          {!activeGroup ? ` · ${item.group_name}` : ""}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="academic-field" style={labelStyle}>
                  <span>Модуль</span>
                  <select
                    className="field"
                    style={fieldStyle}
                    value={selection.module}
                    disabled={disabled || !course}
                    onChange={(event) =>
                      setSelection({
                        ...selection,
                        module: event.target.value,
                        week_numbers: [],
                        work_ids: [],
                      })
                    }
                  >
                    <option value="">Вся дисциплина</option>
                    {course?.modules.map((module) => (
                      <option key={module} value={module}>
                        {module}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {course && (
                <div
                  className="academic-grid two"
                  style={{ gap: 12, marginBottom: 14 }}
                >
                  <details className="panel" style={{ padding: 14 }}>
                    <summary style={{ cursor: "pointer" }}>
                      Недели:{" "}
                      {selection.week_numbers.length
                        ? selection.week_numbers.join(", ")
                        : "все в выбранном модуле"}
                    </summary>
                    <div
                      className="academic-stack"
                      style={{
                        maxHeight: 250,
                        overflowY: "auto",
                        marginTop: 12,
                      }}
                    >
                      {weeks.map((week) => (
                        <label
                          key={week.week_number}
                          style={{
                            display: "flex",
                            gap: 9,
                            alignItems: "baseline",
                            fontSize: 13,
                          }}
                        >
                          <input
                            type="checkbox"
                            disabled={disabled}
                            checked={selection.week_numbers.includes(
                              week.week_number,
                            )}
                            onChange={() =>
                              setSelection({
                                ...selection,
                                week_numbers: toggle(
                                  selection.week_numbers,
                                  week.week_number,
                                ),
                                work_ids: [],
                              })
                            }
                          />
                          <span>
                            {week.week_number}. {week.title}
                          </span>
                        </label>
                      ))}
                      {!weeks.length && (
                        <p className="muted">Недель в этом модуле нет.</p>
                      )}
                    </div>
                  </details>
                  <details className="panel" style={{ padding: 14 }}>
                    <summary style={{ cursor: "pointer" }}>
                      Работы:{" "}
                      {selection.work_ids.length
                        ? `выбрано ${selection.work_ids.length}`
                        : "вся выбранная программа"}
                    </summary>
                    <div
                      className="academic-stack"
                      style={{
                        maxHeight: 250,
                        overflowY: "auto",
                        marginTop: 12,
                      }}
                    >
                      {works.map((work) => (
                        <label
                          key={work.id}
                          style={{
                            display: "flex",
                            gap: 9,
                            alignItems: "baseline",
                            fontSize: 13,
                          }}
                        >
                          <input
                            type="checkbox"
                            disabled={disabled}
                            checked={selection.work_ids.includes(work.id)}
                            onChange={() =>
                              setSelection({
                                ...selection,
                                work_ids: toggle(selection.work_ids, work.id),
                              })
                            }
                          />
                          <span>
                            {work.title}
                            {work.week_number
                              ? ` · неделя ${work.week_number}`
                              : ""}
                          </span>
                        </label>
                      ))}
                      {!works.length && (
                        <p className="muted">Работ для этого выбора нет.</p>
                      )}
                    </div>
                  </details>
                </div>
              )}
              {!courses.length && (
                <p className="muted">
                  Для вашей группы пока нет доступной программы. Администратор
                  может загрузить и опубликовать силабус.
                </p>
              )}
              {source.selectionError && (
                <p
                  className="muted"
                  role="status"
                  style={{ fontSize: 12, marginBottom: 12 }}
                >
                  {source.selectionError}
                </p>
              )}
              {course &&
                (selection.module ||
                  selection.week_numbers.length > 0 ||
                  selection.work_ids.length > 0) && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={disabled}
                    onClick={() =>
                      setSelection({
                        ...selection,
                        module: "",
                        week_numbers: [],
                        work_ids: [],
                      })
                    }
                    style={{ marginBottom: 13, fontSize: 12 }}
                  >
                    Сбросить фильтры программы
                  </button>
                )}
            </>
          )}
        </>
      )}
      <label
        style={{
          display: "flex",
          gap: 9,
          alignItems: "center",
          flexWrap: "wrap",
          fontSize: 13,
        }}
      >
        <input
          type="checkbox"
          checked={selection.use_web}
          disabled={disabled}
          onChange={(event) =>
            setSelection({ ...selection, use_web: event.target.checked })
          }
        />
        <Globe size={15} /> Интернет: актуальные источники
      </label>
      <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Учебная программа задаёт тему. При включённом интернете ИИ ищет
        дополнительные источники; найденные ссылки появятся рядом с результатом.
      </p>
    </div>
  );
}

export function SourceContext({
  value,
  compact = false,
}: {
  value?: LearningSourceContext | null;
  compact?: boolean;
}) {
  if (!value) return null;
  const research = value.research;
  const title = value.course_title || value.subject_titles?.join(", ");
  const sources = (research?.sources || []).flatMap((source) => {
    const url = safeResearchUrl(source.url);
    return url ? [{ ...source, url }] : [];
  });
  const checkedAt = research?.checked_at ? new Date(research.checked_at) : null;
  const html = research?.search_suggestions_html || "";
  return (
    <div style={{ margin: "12px 0", fontSize: 12 }}>
      <div className="academic-meta" style={{ gap: 8 }}>
        {title && (
          <span
            className="badge"
            style={{
              maxWidth: "100%",
              whiteSpace: "normal",
              overflowWrap: "anywhere",
            }}
          >
            <BookOpen size={12} /> {title}
          </span>
        )}
        {value.group_name && <span>{value.group_name}</span>}
        {value.module && <span>{value.module}</span>}
        {!!value.week_numbers?.length && (
          <span>Недели: {value.week_numbers.join(", ")}</span>
        )}
        {!!value.work_ids?.length && (
          <span>Работ: {value.work_ids.length}</span>
        )}
        {compact && research && (
          <span>
            {research.status === "verified" && sources.length
              ? `Интернет: ${sources.length} источников`
              : research.status === "disabled"
                ? "Без интернета"
                : "Актуальность не подтверждена"}
          </span>
        )}
      </div>
      {!compact && (
        <>
          {!!value.syllabi?.length && (
            <p className="muted" style={{ marginTop: 7 }}>
              Силабусы: {value.syllabi.map((item) => item.title).join(", ")}
            </p>
          )}
          {!!value.works?.length && (
            <p className="muted" style={{ marginTop: 7 }}>
              Работы: {value.works.map((item) => item.title).join(", ")}
            </p>
          )}
          {research && (
            <div style={{ marginTop: 10 }}>
              <p className="muted">
                {research.status === "verified" && sources.length
                  ? "Найденные источники в интернете"
                  : research.status === "disabled"
                    ? "Интернет выключен: использована учебная база и знания модели."
                    : research.status === "unavailable"
                      ? "Поиск в интернете недоступен. Актуальность сведений не подтверждена."
                      : "Подтверждённые интернет источники не найдены."}
                {checkedAt && !Number.isNaN(checkedAt.getTime())
                  ? ` · ${checkedAt.toLocaleString("ru-RU")}`
                  : ""}
              </p>
              {!!sources.length && (
                <ul style={{ paddingLeft: 18, marginTop: 7 }}>
                  {sources.map((source, index) => (
                    <li key={`${source.url}-${index}`} style={{ marginTop: 5 }}>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {source.title || new URL(source.url).hostname}{" "}
                        <ExternalLink size={11} style={{ display: "inline" }} />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {(research.warnings || []).map((warning, index) => (
                <p key={index} className="muted" style={{ marginTop: 5 }}>
                  {warning}
                </p>
              ))}
              {html && html.length <= 32768 && (
                <iframe
                  title="Поисковые подсказки источника"
                  srcDoc={html}
                  sandbox="allow-popups"
                  referrerPolicy="no-referrer"
                  style={{
                    width: "100%",
                    maxWidth: 640,
                    height: 115,
                    border: 0,
                    marginTop: 9,
                  }}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const tools = [
  ["tests", "Тест по модулю"],
  ["tasks", "Тренажёр"],
  ["review", "Карточки"],
  ["exam", "Экзамен"],
  ["lectures", "Лекция"],
  ["chat", "Разобрать с ИИ"],
];
export function LearningActions({
  selection,
  compact = false,
}: {
  selection: Partial<LearningSelection>;
  compact?: boolean;
}) {
  return (
    <div
      className="academic-actions"
      style={{ flexWrap: "wrap", margin: "16px 0" }}
    >
      {tools.map(([path, label]) => (
        <Link
          key={path}
          href={learningHref(`/dashboard/${path}`, selection)}
          className={`btn ${path === "tests" && !compact ? "btn-primary" : "btn-secondary"}`}
          style={{ fontSize: 12 }}
        >
          <Sparkles size={13} />
          {compact && path === "tests" ? "Тест" : label}
        </Link>
      ))}
    </div>
  );
}
