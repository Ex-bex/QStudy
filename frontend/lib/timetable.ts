import type { Schedule } from "@/types/academic";

export const TIMETABLE_TIME_ZONE = "Asia/Almaty";

/** Calendar date in the institution's time zone, independent of the device zone. */
export function civilDate(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMETABLE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) =>
    parts.find((value) => value.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function parseCivilDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? date
    : null;
}

export function shiftCivilDate(value: string, days: number): string {
  const date = parseCivilDate(value);
  if (!date) return "";
  date.setUTCDate(date.getUTCDate() + days);
  const result = date.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : "";
}

export function isoWeekStart(value: string): string {
  const date = parseCivilDate(value);
  return date ? shiftCivilDate(value, 1 - (date.getUTCDay() || 7)) : "";
}

export function isoWeekNumber(value: string): number | null {
  const date = parseCivilDate(value);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

export function weekPatternLabel(pattern: string): string {
  const labels: Record<string, string> = {
    every: "Каждую неделю",
    odd: "Нечётная неделя",
    even: "Чётная неделя",
    unspecified: "Периодичность не указана",
  };
  return labels[pattern] || "Периодичность не указана";
}

/** A source times[] array contains start slots, never an inferred ending. */
export function scheduleTimeLabel(
  entry: Pick<Schedule, "start_time" | "start_times" | "end_time">,
): string {
  const starts = entry.start_times?.length
    ? entry.start_times
    : [entry.start_time.slice(0, 5)];
  if (starts.length > 1)
    return (
      starts.join(" / ") +
      (entry.end_time ? ` · до ${entry.end_time.slice(0, 5)}` : "")
    );
  return entry.end_time
    ? `${starts[0]} — ${entry.end_time.slice(0, 5)}`
    : starts[0];
}

/** Match day and known ISO-week parity; unspecified source patterns stay visible. */
export function isEntryOnDate(
  entry: Pick<Schedule, "day_of_week" | "week_pattern">,
  value: string,
): boolean {
  const date = parseCivilDate(value);
  if (!date || (date.getUTCDay() || 7) !== entry.day_of_week) return false;
  const week = isoWeekNumber(value);
  if (entry.week_pattern === "odd") return week !== null && week % 2 === 1;
  if (entry.week_pattern === "even") return week !== null && week % 2 === 0;
  return true;
}

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  const spreadsheetText = Array.from(text)
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .trimStart();
  if (/^[=+@-]/.test(spreadsheetText) || /^[\t\r\n]/.test(text))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Export recurring source records, without inventing calendar dates or durations. */
export function timetableCsv(entries: Schedule[]): string {
  const days = [
    "Понедельник",
    "Вторник",
    "Среда",
    "Четверг",
    "Пятница",
    "Суббота",
    "Воскресенье",
  ];
  const rows: unknown[][] = [
    [
      "Дисциплина",
      "День недели",
      "Все начала занятий",
      "Окончание",
      "Преподаватель",
      "Кабинет",
      "Вид занятия",
      "Периодичность",
      "Примечание",
      "Источник",
      "Лист",
      "Ячейка",
      "Уточнения источника",
    ],
  ];
  for (const entry of [...entries].sort(
    (a, b) =>
      a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time),
  )) {
    rows.push([
      entry.course_title,
      days[entry.day_of_week - 1],
      (entry.start_times?.length ? entry.start_times : [entry.start_time]).join(
        " / ",
      ),
      entry.end_time || "",
      entry.teacher,
      entry.room,
      entry.lesson_type,
      weekPatternLabel(entry.week_pattern),
      entry.notes,
      entry.source_file || entry.source_name,
      entry.source_sheet,
      entry.source_cell,
      entry.warnings?.join("; "),
    ]);
  }
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
}
