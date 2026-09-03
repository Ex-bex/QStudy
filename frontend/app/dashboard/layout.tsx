"use client";
import { BookOpenCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { getToken, setToken } from "@/lib/api";
import {
  LayoutDashboard, BookOpen, StickyNote, FolderOpen,
  MessageSquare, LogOut, Sparkles, Mic, ListChecks,
  GraduationCap, Layers
} from "lucide-react";
import NotificationsBell from "@/lib/notifications";

const NAV = [
  { href: "/dashboard", label: "Обзор", icon: LayoutDashboard },
  { href: "/dashboard/lectures", label: "Лекции", icon: BookOpenCheck },
  { href: "/dashboard/subjects", label: "Предметы", icon: BookOpen },
  { href: "/dashboard/notes", label: "Заметки", icon: StickyNote },
  { href: "/dashboard/files", label: "Файлы", icon: FolderOpen },
  { href: "/dashboard/voice", label: "Диктофон", icon: Mic },
  // { href: "/dashboard/tasks", label: "Тренажёр", icon: ListChecks },
    { href: "/dashboard/tests", label: "Тестирование", icon: ListChecks },
  { href: "/dashboard/exam", label: "Экзаменатор", icon: GraduationCap },
  { href: "/dashboard/review", label: "Повторение", icon: Layers },
  { href: "/dashboard/chat", label: "Чат с ИИ", icon: MessageSquare },
]; 

// soon: true 

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
    } else {
      setReady(true);
    }
  }, [router]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center text-gray-400">
        Загрузка...
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Сайдбар */}
      <aside className="flex w-60 flex-col border-r border-gray-800 bg-gray-900 p-4">
        <div className="mb-8 flex items-center gap-2 px-2">
          <Sparkles className="h-6 w-6 text-indigo-400" />
<div className="mb-8 flex items-center justify-between px-2">
  <div className="flex items-center gap-2">
    <Sparkles className="h-6 w-6 text-indigo-400" />
    <span className="text-xl font-bold">StudyHub</span>
  </div>
  <NotificationsBell />
</div>
          <span className="text-xl font-bold">StudyHub</span>
        </div>

        <nav className="flex-1 space-y-1">
          {NAV.map(({ href, label, icon: Icon, soon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                onClick={soon ? (e) => e.preventDefault() : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition
                  ${active ? "bg-indigo-600/20 text-indigo-300" : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"}
                  ${soon ? "opacity-40" : ""}`}
              >
                <Icon className="h-4 w-4" />
                {label}
                {soon && <span className="ml-auto text-[10px] uppercase">скоро</span>}
              </Link>
            );
          })}
        </nav>

        <button
          onClick={() => {
            setToken(null);
            router.push("/login");
          }}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-red-400"
        >
          <LogOut className="h-4 w-4" />
          Выйти
        </button>
      </aside>

      {/* Контент */}
      <main className="flex-1 overflow-y-auto p-8">{children}</main>
    </div>
  );
}