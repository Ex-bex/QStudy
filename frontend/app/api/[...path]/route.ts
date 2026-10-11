import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const COOKIE = "qstudy_session";
const MAX_BODY = 26 * 1024 * 1024;

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const backupDownload =
    request.method === "GET" &&
    path.length === 4 &&
    path[0] === "admin" &&
    path[1] === "backups" &&
    path[3] === "download" &&
    /^qstudy-\d{8}-\d{6}-[a-f0-9]{8}\.zip$/.exec(path[2])?.[0] === path[2];
  const brandingAsset =
    ["GET", "HEAD"].includes(request.method) &&
    path.length === 4 &&
    path[0] === "branding" &&
    path[1] === "assets" &&
    /^(project|department-[1-9][0-9]*)$/.exec(path[2])?.[0] === path[2] &&
    /^[a-f0-9]{64}\.png$/.exec(path[3])?.[0] === path[3];
  const brandingUpload =
    request.method === "PUT" &&
    path[0] === "branding" &&
    ((path.length === 2 && path[1] === "project-logo") ||
      (path.length === 4 &&
        path[1] === "departments" &&
        /^[1-9][0-9]*$/.test(path[2]) &&
        path[3] === "logo"));
  const bodyLimit = brandingUpload ? 2 * 1024 * 1024 + 64 * 1024 : MAX_BODY;
  if (
    !backupDownload &&
    !brandingAsset &&
    path.some((segment) => !/^[a-zA-Z0-9_-]+$/.test(segment))
  ) {
    return NextResponse.json({ detail: "Некорректный путь" }, { status: 400 });
  }
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const origin = request.headers.get("origin");
  let originMatches = false;
  try {
    const parsedOrigin = origin ? new URL(origin) : null;
    originMatches =
      !!parsedOrigin &&
      parsedOrigin.host === request.headers.get("host") &&
      parsedOrigin.protocol === request.nextUrl.protocol;
  } catch {}
  if (mutation && !originMatches) {
    return NextResponse.json(
      { detail: "Запрос с другого сайта запрещён" },
      { status: 403 },
    );
  }
  if (Number(request.headers.get("content-length") || 0) > bodyLimit) {
    return NextResponse.json(
      { detail: brandingUpload ? "PNG должен занимать не более 2 МБ" : "Файл слишком большой (максимум 25 МБ)" },
      { status: 413 },
    );
  }
  let body: ArrayBuffer | undefined;
  if (mutation && request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > bodyLimit) {
          await reader.cancel();
          return NextResponse.json(
            { detail: "Превышен размер запроса" },
            { status: 413 },
          );
        }
        chunks.push(value);
      }
    } catch {
      return NextResponse.json(
        { detail: "Передача запроса прервана" },
        { status: 400 },
      );
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    body = merged.buffer;
  }
  const backend = (process.env.BACKEND_URL || "http://127.0.0.1:8000").replace(
    /\/$/,
    "",
  );
  const headers = new Headers();
  if (request.headers.get("content-type"))
    headers.set("content-type", request.headers.get("content-type")!);
  const token = request.cookies.get(COOKIE)?.value;
  if (token && !brandingAsset) headers.set("Authorization", `Bearer ${token}`);
  if (brandingAsset && request.headers.get("if-none-match"))
    headers.set("If-None-Match", request.headers.get("if-none-match")!);
  const endpoint = path.join("/");
  try {
    const upstream = await fetch(
      `${backend}/api/${endpoint}${request.nextUrl.search}`,
      {
        method: request.method,
        headers,
        body,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(180_000),
      },
    );
    const isAuth = ["auth/login", "auth/register", "auth/password"].includes(
      endpoint,
    );
    let response: NextResponse;
    if (isAuth && upstream.ok) {
      const data = await upstream.json();
      const session = data.access_token || data.token;
      delete data.access_token;
      delete data.token;
      response = NextResponse.json(data, { status: upstream.status });
      if (session)
        response.cookies.set(COOKIE, session, {
          httpOnly: true,
          secure:
            process.env.NODE_ENV === "production" ||
            request.nextUrl.protocol === "https:",
          sameSite: "strict",
          path: "/",
          maxAge: 60 * 60 * 8,
        });
    } else {
      const responseHeaders = new Headers({
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      for (const key of [
        "content-type",
        "content-disposition",
        "retry-after",
      ]) {
        const value = upstream.headers.get(key);
        if (value) responseHeaders.set(key, value);
      }
      if (brandingAsset && (upstream.ok || upstream.status === 304)) {
        for (const key of ["cache-control", "etag"]) {
          const value = upstream.headers.get(key);
          if (value) responseHeaders.set(key, value);
        }
      }
      response = new NextResponse(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }
    if (!brandingAsset) response.headers.set("Cache-Control", "no-store");
    if (
      endpoint === "auth/logout" ||
      (endpoint === "auth/reset-password" && upstream.ok) ||
      (upstream.status === 401 && !isAuth && !brandingAsset)
    )
      response.cookies.delete(COOKIE);
    return response;
  } catch {
    const response = NextResponse.json(
      {
        detail:
          "Сервер QStudy недоступен. Проверьте запуск сервера и повторите запрос.",
      },
      { status: 502 },
    );
    if (endpoint === "auth/logout") response.cookies.delete(COOKIE);
    return response;
  }
}

export {
  proxy as GET,
  proxy as HEAD,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
