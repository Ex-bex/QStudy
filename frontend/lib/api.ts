export const API_URL = "/api";

// The server keeps the session in an HttpOnly cookie. Remove legacy tokens.
export function setToken(token: string | null) {
  if (typeof window !== "undefined") {
    localStorage.removeItem("token");
    sessionStorage.removeItem("token");
    if (!token) {
      sessionStorage.removeItem("qstudy_activity");
      sessionStorage.removeItem("studyhub_activity");
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith("qmessage_draft_")) sessionStorage.removeItem(key);
      }
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("chat_draft_")) localStorage.removeItem(key);
      }
    }
  }
}
export function getToken(): string | null {
  return null;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const body = options.body;
  const isForm = body instanceof FormData || body instanceof URLSearchParams;
  const headers = new Headers(options.headers);
  if (body && !isForm && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const detail = data?.detail;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail.map((e: { msg: string }) => e.msg).join("; ")
          : `Ошибка ${res.status}`;
    if (
      res.status === 401 &&
      typeof window !== "undefined" &&
      !path.startsWith("/auth/")
    ) {
      window.dispatchEvent(new Event("qstudy:unauthorized"));
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
