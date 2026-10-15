// Keep authentication return paths within the shared QStudy/LumaBall site.
export function authReturnPath(value: string | null | undefined): string {
  if (typeof value !== "string") return "/dashboard";
  return /^\/lumaball(?:\/play|\/room\/[a-f0-9]{32})?$/.test(value)
    ? value
    : "/dashboard";
}
