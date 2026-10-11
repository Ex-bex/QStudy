"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { Bell, CheckCircle2, XCircle, X } from "lucide-react";

interface Notif {
  id: string;
  kind: string;
  title: string;
  status: string;
  error: string;
  result?: Record<string, unknown>;
}

export function useJobRefresh(kind: string, refresh: () => Promise<void>) {
  const latestRefresh = useRef(refresh);
  useEffect(() => {
    latestRefresh.current = refresh;
  }, [refresh]);
  useEffect(() => {
    const listener = (event: Event) => {
      const job = (event as CustomEvent<Notif>).detail;
      if (job?.kind === kind && job.status === "done")
        void latestRefresh.current().catch(() => {});
    };
    window.addEventListener("qstudy:job", listener);
    return () => window.removeEventListener("qstudy:job", listener);
  }, [kind]);
}

export function useNotifications() {
  const [unread, setUnread] = useState<Notif[]>([]);
  const [toasts, setToasts] = useState<Notif[]>([]);
  const seen = useRef(new Set<string>());
  const [error, setError] = useState("");

  const poll = useCallback(async () => {
    try {
      const fresh = await api<Notif[]>("/notifications");
      setUnread(fresh.slice(0, 100));
      const newlySeen = fresh.filter((job) => !seen.current.has(job.id));
      newlySeen.forEach((job) => seen.current.add(job.id));
      if (newlySeen.length)
        setToasts((prev) => [...newlySeen, ...prev].slice(0, 3));
      newlySeen.forEach((job) =>
        window.dispatchEvent(new CustomEvent("qstudy:job", { detail: job })),
      );
    } catch {}
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 15000);
    return () => clearInterval(t);
  }, [poll]);

  const markRead = useCallback(async (id: string) => {
    try {
      await api(`/notifications/${id}/ack`, { method: "POST" });
      setUnread((prev) => prev.filter((n) => n.id !== id));
      setError("");
    } catch {
      setError("Не удалось отметить уведомление прочитанным. Повторите попытку.");
    }
  }, []);

  return { unread, markRead, toasts, setToasts, error };
}

export default function NotificationsBell() {
  const { unread, markRead, toasts, setToasts, error } = useNotifications();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setTimeout(() => setToasts((p) => p.slice(0, -1)), 6000);
    return () => clearTimeout(t);
  }, [toasts, setToasts]);

  return (
    <>
      {/* Колокольчик */}
      <div className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="relative rounded-lg p-2 hover:bg-gray-800"
          title="Уведомления"
          aria-label="Уведомления"
          aria-expanded={open}
        >
          <Bell className="h-5 w-5 text-gray-400" />
          {unread.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {unread.length}
            </span>
          )}
        </button>
        {open && (
          <div className="absolute right-0 top-11 z-50 max-h-[70vh] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-gray-700 bg-gray-900 p-2 shadow-xl">
            {error && <p className="p-3 text-xs text-red-300">{error}</p>}
            {unread.length === 0 && (
              <p className="p-3 text-sm text-gray-500">Новых уведомлений нет</p>
            )}
            {unread.map((n) => (
              <div
                key={n.id}
                className="flex items-start gap-2 rounded-lg p-2.5 hover:bg-gray-800"
              >
                {n.status === "done" ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-400" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{n.title}</p>
                  <p className="text-xs text-gray-500">
                    {n.status === "done" ? "готово" : `ошибка: ${n.error}`}
                  </p>
                </div>
                <button
                  onClick={() => markRead(n.id)}
                  aria-label="Отметить прочитанным"
                  className="text-gray-600 hover:text-gray-400"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Тосты */}
      <div className="fixed bottom-5 right-5 z-[60] space-y-2">
        {toasts.map((n) => (
          <div
            key={n.id}
            className={`flex items-start gap-2 rounded-xl border p-3.5 shadow-lg backdrop-blur
              ${
                n.status === "done"
                  ? "border-green-500/40 bg-green-950/80"
                  : "border-red-500/40 bg-red-950/80"
              }`}
          >
            {n.status === "done" ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-400" />
            ) : (
              <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
            )}
            <div>
              <p className="text-sm font-medium">{n.title}</p>
              <p className="text-xs text-gray-400">
                {n.status === "done"
                  ? "Готово — результат ждёт на своей странице"
                  : n.error}
              </p>
            </div>
            <button
              onClick={() => setToasts((p) => p.filter((t) => t.id !== n.id))}
            >
              <X className="h-4 w-4 text-gray-500" />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
