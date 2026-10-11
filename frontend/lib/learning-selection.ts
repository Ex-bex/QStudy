import type {
  LearningCourseOption,
  LearningSelection,
  LearningSourceContext,
} from "../types/learning";

export function emptyLearningSelection(): LearningSelection {
  return {
    course_id: null,
    module: "",
    week_numbers: [],
    work_ids: [],
    use_web: true,
  };
}

export function learningSelectionFromSource(
  source: LearningSourceContext | null | undefined,
  useWeb = true,
): LearningSelection {
  const selection = { ...emptyLearningSelection(), use_web: useWeb };
  if (!source?.course_id || source.mode === "personal") return selection;
  const weeks = source.weeks || [];
  const works = source.works || [];
  return {
    ...selection,
    course_id: source.course_id,
    module: source.module || "",
    week_numbers: weeks.length
      ? [...new Set(weeks.map((week) => week.week_number))]
      : [],
    work_ids:
      !weeks.length && works.length
        ? [
            ...(source.work_ids?.length
              ? source.work_ids
              : works.map((work) => work.id)),
          ]
        : [],
  };
}

export function learningSourceActivity(
  source: LearningSourceContext | null | undefined,
  useWeb = true,
) {
  const selection = learningSelectionFromSource(source, useWeb);
  return {
    course_id: selection.course_id || undefined,
    module: selection.course_id ? selection.module : undefined,
    week_numbers: selection.course_id ? selection.week_numbers : undefined,
    work_ids: selection.course_id ? selection.work_ids : undefined,
    use_web: useWeb,
    subject:
      source?.course_title || source?.subject_titles?.join(", ") || undefined,
    topic: source?.topic_titles?.join(", ") || undefined,
  };
}

function positiveIds(value: string | null): number[] {
  return [
    ...new Set(
      (value || "")
        .split(",")
        .filter((item) => /^\d+$/.test(item))
        .map(Number)
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    ),
  ];
}

export function learningSelectionFromQuery(query: string): LearningSelection {
  const params = new URLSearchParams(query);
  const course = params.get("course");
  const courseId = course && /^\d+$/.test(course) ? Number(course) : null;
  return {
    course_id:
      courseId && Number.isSafeInteger(courseId) && courseId > 0
        ? courseId
        : null,
    module: (params.get("module") || "").slice(0, 200),
    week_numbers: positiveIds(params.get("weeks")).slice(0, 100),
    work_ids: positiveIds(params.get("works")).slice(0, 200),
    use_web: params.get("use_web") !== "false",
  };
}

export function learningHref(
  path: string,
  selection: Partial<LearningSelection>,
): string {
  const params = new URLSearchParams();
  if (selection.course_id) params.set("course", String(selection.course_id));
  if (selection.module) params.set("module", selection.module);
  if (selection.week_numbers?.length)
    params.set("weeks", selection.week_numbers.join(","));
  if (selection.work_ids?.length)
    params.set("works", selection.work_ids.join(","));
  if (selection.use_web === false) params.set("use_web", "false");
  return `${path}${params.size ? `?${params}` : ""}`;
}

export function learningSelectionError(
  selection: LearningSelection,
  courses: LearningCourseOption[],
): string {
  if (selection.week_numbers.some((number) => !Number.isInteger(number) || number < 1 || number > 52)) return "Номер недели должен быть от 1 до 52.";
  const course = courses.find((item) => item.id === selection.course_id);
  if (!course)
    return "Выберите доступную дисциплину с опубликованным силабусом.";
  if (selection.module && !course.modules.includes(selection.module))
    return "Этот модуль недоступен. Выберите модуль из списка.";
  const weeks = course.weeks.filter(
    (week) => !selection.module || week.module === selection.module,
  );
  if (
    !selection.work_ids.length &&
    selection.week_numbers.some(
      (number) => !weeks.some((week) => week.week_number === number),
    )
  )
    return "Выбранная неделя недоступна в этом модуле. Уточните выбор.";
  const works = course.works.filter(
    (work) =>
      (!selection.module || work.module === selection.module) &&
      (!selection.week_numbers.length ||
        (work.week_number !== null &&
          selection.week_numbers.includes(work.week_number))),
  );
  if (selection.work_ids.some((id) => !works.some((work) => work.id === id)))
    return "Выбранная работа недоступна для этих недель. Уточните выбор.";
  if (selection.work_ids.length && selection.week_numbers.length) {
    const selectedWorks = works.filter((work) =>
      selection.work_ids.includes(work.id),
    );
    if (
      selection.week_numbers.some(
        (number) => !selectedWorks.some((work) => work.week_number === number),
      )
    )
      return "Для каждой выбранной недели выберите соответствующую работу.";
  }
  if (!weeks.length && !works.length)
    return "В этой части программы пока нет опубликованных занятий или работ.";
  return "";
}

export function safeResearchUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}
