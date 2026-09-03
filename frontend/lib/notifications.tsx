"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { Bell, CheckCircle2, XCircle, X } from "lucide-react";

interface Notif {
  id: string; kind: string; title: string; status: string; error: string;
}

export function useNotifications() {
  const [unread, setUnread] = useState<Notif[]>([]);

  const poll = useCallback(async () => {
    try {
      const fresh = await api<Notif[]>("/notifications");
      if (fresh.length) setUnread((prev) => [...fresh, ...prev].slice(0, 30));
    } catch {}
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 15000);
    return () => clearInterval(t);
  }, [poll]);

  const markRead = useCallback((id: string) => {
    setUnread((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return { unread, markRead };
}

export default function NotificationsBell() {
  const { unread, markRead } = useNotifications();
  const [toasts, setToasts] = useState<Notif[]>([]);
  const [open, setOpen] = useState(false);

  // Новые уведомления -> тост на 6 сек
  useEffect(() => {
    if (unread.length === 0) return;
    setToasts((prev) => {
      const ids = new Set(prev.map((t) => t.id));
      const fresh = unread.filter((n) => !ids.has(n.id)).slice(0, 3);
      return [...fresh, ...prev].slice(0, 3);
    });
  }, [unread]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setTimeout(() => setToasts((p) => p.slice(0, -1)), 6000);
    return () => clearTimeout(t);
  }, [toasts]);

  return (
    <>
      {/* Колокольчик */}
      <div className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="relative rounded-lg p-2 hover:bg-gray-800"
          title="Уведомления"
        >
          <Bell className="h-5 w-5 text-gray-400" />
          {unread.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {unread.length}
            </span>
          )}
        </button>
        {open && (
          <div className="absolute left-0 top-11 z-50 w-80 rounded-xl border border-gray-700 bg-gray-900 p-2 shadow-xl">
            {unread.length === 0 && (
              <p className="p-3 text-sm text-gray-500">Новых уведомлений нет</p>
            )}
            {unread.map((n) => (
              <div key={n.id}
                className="flex items-start gap-2 rounded-lg p-2.5 hover:bg-gray-800">
                {n.status === "done"
                  ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-400" />
                  : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{n.title}</p>
                  <p className="text-xs text-gray-500">
                    {n.status === "done" ? "готово" : `ошибка: ${n.error}`}
                  </p>
                </div>
                <button onClick={() => markRead(n.id)} className="text-gray-600 hover:text-gray-400">
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
          <div key={n.id}
            className={`flex items-start gap-2 rounded-xl border p-3.5 shadow-lg backdrop-blur
              ${n.status === "done"
                ? "border-green-500/40 bg-green-950/80" : "border-red-500/40 bg-red-950/80"}`}>
            {n.status === "done"
              ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-400" />
              : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />}
            <div>
              <p className="text-sm font-medium">{n.title}</p>
              <p className="text-xs text-gray-400">
                {n.status === "done" ? "Готово — результат ждёт на своей странице" : n.error}
              </p>
            </div>
            <button onClick={() => setToasts((p) => p.filter((t) => t.id !== n.id))}>
              <X className="h-4 w-4 text-gray-500" />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}