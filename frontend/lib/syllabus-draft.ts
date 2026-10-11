import type {
  CourseFacts,
  DraftWeek,
  DraftWork,
  SyllabusDraft,
} from "@/types/academic";

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : {};
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rows(value: unknown): Fields[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is Fields =>
          row !== null && typeof row === "object" && !Array.isArray(row),
      )
    : [];
}

function week(value: Fields): DraftWeek {
  return {
    // An absent week number remains invalid for saving until the editor supplies
    // it; assigning an invented week could silently change an old curriculum.
    week_number: number(value.week_number, 0),
    title: text(value.title),
    content: text(value.content),
    tasks: text(value.tasks),
    assessment: text(value.assessment),
    hours: number(value.hours, 0),
    module: text(value.module),
    resources: text(value.resources),
  };
}

function work(value: Fields): DraftWork {
  return {
    title: text(value.title),
    description: text(value.description),
    module: text(value.module),
    week_number:
      typeof value.week_number === "number" &&
      Number.isFinite(value.week_number)
        ? value.week_number
        : null,
    max_score: number(value.max_score, 100),
    kind: text(value.kind, "assignment"),
  };
}

function factNumber(value: unknown, maximum: number) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= maximum
    ? value
    : null;
}

function factText(value: unknown, maximum: number) {
  const result = text(value).trim();
  return result.length <= maximum && !["-", "—", "–"].includes(result)
    ? result
    : "";
}

function courseFacts(value: unknown): CourseFacts | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const facts = fields(value);
  const semester = factNumber(facts.semester, 16);
  return {
    credits: factNumber(facts.credits, 100),
    teacher: factText(facts.teacher, 200),
    total_hours: factNumber(facts.total_hours, 10000),
    source_group: factText(facts.source_group, 300),
    semester: semester !== null && Number.isInteger(semester) ? semester : null,
  };
}

/** Normalize an API boundary: legacy drafts may be {}, null or partially filled. */
export function normalizeSyllabusDraft(
  value: unknown,
  fallback: unknown = {},
): SyllabusDraft {
  const draft = fields(value);
  const defaults = fields(fallback);
  return {
    title: text(draft.title, text(defaults.title)),
    summary: text(draft.summary, text(defaults.summary)),
    weeks: rows(Array.isArray(draft.weeks) ? draft.weeks : defaults.weeks).map(
      week,
    ),
    works: rows(draft.works).map(work),
    course_facts: courseFacts(
      draft.course_facts === undefined
        ? defaults.course_facts
        : draft.course_facts,
    ),
  };
}
