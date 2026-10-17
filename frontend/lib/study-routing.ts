export function isStudyManagement(role: string | undefined, pathname: string) {
  return (
    role === "admin" &&
    (pathname === "/qcontrol" || pathname.startsWith("/qcontrol/"))
  );
}

export function studyPath(href: string, pathname: string) {
  if (pathname !== "/qcontrol" && !pathname.startsWith("/qcontrol/"))
    return href;
  return href.replace(
    /^\/dashboard\/(groups|syllabi|modules|subjects)(?=\/|\?|#|$)/,
    "/qcontrol/qstudy/$1",
  );
}
