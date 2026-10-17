export const CAREER_TABS = [
  "overview",
  "skills",
  "directions",
  "plan",
  "opportunities",
  "profile",
] as const;
export type CareerTab = (typeof CAREER_TABS)[number];

function unsafeURLCharacters(value: string): boolean {
  return [...value].some(
    (character) =>
      character === "\\" ||
      character.charCodeAt(0) <= 32 ||
      character.charCodeAt(0) === 127,
  );
}

export function careerTab(value: string | null | undefined): CareerTab {
  return CAREER_TABS.includes(value as CareerTab)
    ? (value as CareerTab)
    : "overview";
}

// Curriculum links may navigate only to the existing authenticated learning UI.
export function careerLearningHref(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string" || unsafeURLCharacters(value)) return null;
  try {
    const url = new URL(value, "https://qstudy.invalid");
    if (
      !value.startsWith("/dashboard/") ||
      url.origin !== "https://qstudy.invalid"
    )
      return null;
    if (
      !/^\/dashboard\/(?:groups\/\d+\/courses\/\d+|tests|modules|syllabi)(?:\/|$)/.test(
        url.pathname,
      )
    )
      return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function careerExternalHref(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string" || !value || unsafeURLCharacters(value))
    return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function careerPercent(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : null;
}

export function careerInterests(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,;\n]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function careerDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : date.toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}
