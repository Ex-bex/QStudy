// Keep authentication return paths within the shared ecosystem.
export function authReturnPath(value: string | null | undefined): string {
  if (typeof value !== "string") return "/dashboard";
  if (/^\/qmessage(?:\/chats(?:\?chat=[1-9]\d{0,14})?)?$/.test(value))
    return value;
  if (value === "/qcareer" || value === "/qcareer/workspace") return value;
  if (/^\/qtests(?:\/library|\/(?:banks|attempts)\/[1-9]\d*)?$/.test(value))
    return value;
  if (
    [
      "/qcontrol",
      "/qcontrol/accounts",
      "/qcontrol/qcareer",
      "/qcontrol/qball",
      "/qcontrol/qtests",
      "/qcontrol/qmessage",
      "/qcontrol/branding",
      "/qcontrol/system",
      "/qcontrol/operations",
      "/qcontrol/qstudy",
      "/qcontrol/qstudy/groups",
      "/qcontrol/qstudy/modules",
      "/qcontrol/qstudy/syllabi",
      "/qcontrol/qstudy/subjects",
    ].includes(value)
  )
    return value;
  if (
    /^\/qcontrol\/qstudy\/groups\/[1-9]\d*(?:\/courses\/[1-9]\d*)?$/.test(value)
  )
    return value;
  return /^\/(?:qball|lumaball)(?:\/play|\/room\/[a-f0-9]{32})?$/.test(value)
    ? value.replace(/^\/lumaball(?=\/|$)/, "/qball")
    : "/dashboard";
}
