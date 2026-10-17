import { NextRequest, NextResponse } from "next/server";
import {
  sameSiteMutation,
  sessionCookieOptions,
  trustedClientIp,
} from "@/lib/proxy-security";
import {
  boundedUploadBody,
  isSystemImport,
  MAX_SYSTEM_ARCHIVE_BYTES,
} from "@/lib/system-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const COOKIE = "qstudy_session";
const GUEST_COOKIE = "lumaball_guest";
const MAX_BODY = 26 * 1024 * 1024;

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const systemImport = isSystemImport(request.method, path);
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
    /^(project|qcareer|qid|qcontrol|department-[1-9][0-9]*)$/.exec(
      path[2],
    )?.[0] === path[2] &&
    /^[a-f0-9]{64}\.png$/.exec(path[3])?.[0] === path[3];
  const brandingUpload =
    request.method === "PUT" &&
    ((path.length === 3 &&
      path[0] === "admin" &&
      path[1] === "lumaball" &&
      path[2] === "logo") ||
      (path[0] === "branding" &&
        ((path.length === 2 &&
          [
            "project-logo",
            "career-logo",
            "identity-logo",
            "control-logo",
          ].includes(path[1])) ||
          (path.length === 4 &&
            path[1] === "departments" &&
            /^[1-9][0-9]*$/.test(path[2]) &&
            path[3] === "logo"))));
  const bodyLimit = systemImport
    ? MAX_SYSTEM_ARCHIVE_BYTES
    : brandingUpload
      ? 2 * 1024 * 1024 + 64 * 1024
      : MAX_BODY;
  if (
    !backupDownload &&
    !brandingAsset &&
    path.some((segment) => !/^[a-zA-Z0-9_-]+$/.test(segment))
  ) {
    return NextResponse.json({ detail: "Некорректный путь" }, { status: 400 });
  }
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const originMatches = sameSiteMutation(
    request.headers.get("origin"),
    request.headers.get("host"),
    request.nextUrl.protocol,
    process.env.PUBLIC_BASE_URL,
    process.env.ALLOW_PUBLIC_HTTP,
    process.env.NODE_ENV,
    process.env.QSTUDY_ACCESS_MODE,
  );
  if (mutation && !originMatches) {
    return NextResponse.json(
      { detail: "Запрос с другого сайта запрещён" },
      { status: 403 },
    );
  }
  if (Number(request.headers.get("content-length") || 0) > bodyLimit) {
    return NextResponse.json(
      {
        detail: systemImport
          ? "Архив должен занимать не более 2 ГБ"
          : brandingUpload
            ? "PNG должен занимать не более 2 МБ"
            : "Файл слишком большой (максимум 25 МБ)",
      },
      { status: 413 },
    );
  }
  if (systemImport && !request.cookies.get(COOKIE)?.value) {
    return NextResponse.json(
      { detail: "Войдите в аккаунт администратора" },
      { status: 401 },
    );
  }
  let body: ArrayBuffer | ReadableStream<Uint8Array> | undefined;
  let importBody: ReturnType<typeof boundedUploadBody> | undefined;
  if (systemImport && request.body) {
    importBody = boundedUploadBody(request.body);
    body = importBody.body;
  } else if (mutation && request.body) {
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
  const clientIp = trustedClientIp(
    request.headers.get("x-real-ip"),
    process.env.TRUST_PROXY_HEADERS,
    process.env.NODE_ENV,
    process.env.BFF_PROXY_SECRET,
  );
  if (clientIp) {
    headers.set("X-QStudy-Client-IP", clientIp);
    headers.set("X-QStudy-Proxy-Key", process.env.BFF_PROXY_SECRET!);
  }
  if (request.headers.get("content-type"))
    headers.set("content-type", request.headers.get("content-type")!);
  const token = request.cookies.get(COOKIE)?.value;
  const guestCookie = request.cookies.get(GUEST_COOKIE)?.value;
  if (token && !brandingAsset) headers.set("Authorization", `Bearer ${token}`);
  if (path[0] === "lumaball") {
    if (guestCookie) headers.set("X-LumaBall-Session", guestCookie);
  }
  if (brandingAsset && request.headers.get("if-none-match"))
    headers.set("If-None-Match", request.headers.get("if-none-match")!);
  const endpoint = path.join("/");
  const cookieOptions = sessionCookieOptions(
    request.headers.get("host"),
    request.nextUrl.protocol,
    process.env.NODE_ENV,
    process.env.PUBLIC_BASE_URL,
    process.env.ALLOW_PUBLIC_HTTP,
    process.env.QSTUDY_ACCESS_MODE,
  );
  const clearSession = (response: NextResponse) =>
    response.cookies.set(COOKIE, "", {
      ...cookieOptions,
      maxAge: 0,
      expires: new Date(0),
    });
  try {
    const upstream = await fetch(
      `${backend}/api/${endpoint}${request.nextUrl.search}`,
      {
        method: request.method,
        headers,
        body,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(systemImport ? 30 * 60_000 : 180_000),
        ]),
        ...(systemImport && body ? { duplex: "half" } : {}),
      } as RequestInit & { duplex?: "half" },
    );
    const isAuth = ["auth/login", "auth/register", "auth/password"].includes(
      endpoint,
    );
    let response: NextResponse;
    if (
      endpoint === "lumaball/session" &&
      request.method === "POST" &&
      upstream.ok
    ) {
      const data = await upstream.json();
      const guest = data.guest_token;
      delete data.guest_token;
      response = NextResponse.json(data, { status: upstream.status });
      if (typeof guest === "string" && /^[A-Za-z0-9_-]{40,128}$/.test(guest))
        response.cookies.set(GUEST_COOKIE, guest, {
          ...cookieOptions,
          maxAge: 60 * 60 * 24 * 30,
        });
    } else if (isAuth && upstream.ok) {
      const data = await upstream.json();
      const session = data.access_token || data.token;
      delete data.access_token;
      delete data.token;
      response = NextResponse.json(data, { status: upstream.status });
      if (session)
        response.cookies.set(COOKIE, session, {
          ...cookieOptions,
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
      (upstream.status === 401 &&
        !isAuth &&
        !brandingAsset &&
        (path[0] !== "lumaball" || !!token))
    )
      clearSession(response);
    // Read-only identity checks can finish after a new guest signs in. They
    // must never erase the newer HttpOnly credential through a late response.
    if (
      upstream.status === 401 &&
      endpoint === "lumaball/session" &&
      request.method === "POST" &&
      guestCookie &&
      !token
    ) {
      response.cookies.set(GUEST_COOKIE, "", {
        ...cookieOptions,
        maxAge: 0,
        expires: new Date(0),
      });
      response.headers.set("X-QBall-Guest-Reset", "1");
    }
    return response;
  } catch {
    if (importBody?.tooLarge) {
      return NextResponse.json(
        { detail: "Архив должен занимать не более 2 ГБ" },
        { status: 413 },
      );
    }
    const response = NextResponse.json(
      {
        detail:
          "Сервер QStudy недоступен. Проверьте запуск сервера и повторите запрос.",
      },
      { status: 502 },
    );
    if (endpoint === "auth/logout") clearSession(response);
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
