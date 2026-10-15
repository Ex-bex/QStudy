// Keep authentication return paths within the shared QStudy/QBall site.
export function authReturnPath(value: string | null | undefined): string {
  if (typeof value !== "string") return "/dashboard";
  return /^\/(?:qball|lumaball)(?:\/play|\/room\/[a-f0-9]{32})?$/.test(value)
    ? value.replace(/^\/lumaball(?=\/|$)/, "/qball")
    : "/dashboard";
}
