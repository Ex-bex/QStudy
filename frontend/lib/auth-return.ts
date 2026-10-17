// Keep authentication return paths within the shared ecosystem.
export function authReturnPath(value: string | null | undefined): string {
  if (typeof value !== "string") return "/dashboard";
  if (value === "/qcareer" || value === "/qcareer/workspace") return value;
  return /^\/(?:qball|lumaball)(?:\/play|\/room\/[a-f0-9]{32})?$/.test(value)
    ? value.replace(/^\/lumaball(?=\/|$)/, "/qball")
    : "/dashboard";
}
