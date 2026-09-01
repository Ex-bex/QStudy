export const API_URL = "http://localhost:8000/api";

export function setToken(t: string | null) {
  if (typeof window !== "undefined") {
    t ? localStorage.setItem("token", t) : localStorage.removeItem("token");
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const body = options.body;
  // FormData и URLSearchParams сами ставят правильный Content-Type — не мешаем им
  const isForm = body instanceof FormData || body instanceof URLSearchParams;

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const detail = data?.detail;
    let message = `Ошибка ${res.status}`;
    if (typeof detail === "string") message = detail;
    else if (Array.isArray(detail)) message = detail.map((e: any) => e.msg).join("; ");
    throw new Error(message);
  }
  return res.json();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}