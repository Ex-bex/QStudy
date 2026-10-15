"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  BookOpen,
  StickyNote,
  FolderOpen,
  MessageSquare,
  LogOut,
  Sparkles,
  Mic,
  ListChecks,
  GraduationCap,
  Layers,
  BookOpenCheck,
  FileText,
  ShieldCheck,
  ChevronRight,
  ArrowUpRight,
  Menu,
  X,
  Workflow,
  Gamepad2,
  Power,
} from "lucide-react";
import Brand from "@/components/brand";
import NotificationsBell from "@/lib/notifications";
import { AuthProvider, useAuth } from "@/lib/auth";
import { api, setToken } from "@/lib/api";
import LumaNavLink from "@/components/lumaball/nav-link";

const sections = [
  {
    title: "МОЁ ПРОСТРАНСТВО",
    items: [
      { href: "/dashboard", label: "Обзор", icon: LayoutDashboard },
      { href: "/dashboard/groups", label: "Группы и расписание", icon: Users },
      { href: "/dashboard/modules", label: "Модульные работы", icon: Layers },
      { href: "/dashboard/syllabi", label: "Силабусы", icon: FileText },
      {
        href: "/developers",
        label: "Связь с разработчиками",
        icon: MessageSquare,
      },
      { href: "/qball", label: "QBall", icon: Gamepad2 },
    ],
  },
  {
    title: "БАЗА ЗНАНИЙ",
    items: [
      { href: "/dashboard/subjects", label: "Предметы", icon: BookOpen },
      { href: "/dashboard/lectures", label: "Лекции", icon: BookOpenCheck },
      { href: "/dashboard/notes", label: "Мои заметки", icon: StickyNote },
      { href: "/dashboard/files", label: "Мои материалы", icon: FolderOpen },
      { href: "/dashboard/voice", label: "Диктофон", icon: Mic },
    ],
  },
  {
    title: "УЧИТЬСЯ С ИИ",
    items: [
      { href: "/dashboard/chat", label: "ИИ-помощник", icon: Sparkles },
      { href: "/dashboard/jobs", label: "Задания ИИ", icon: Workflow },
      { href: "/dashboard/tasks", label: "Тренажёр", icon: ListChecks },
      { href: "/dashboard/tests", label: "Тестирование", icon: ListChecks },
      { href: "/dashboard/exam", label: "Экзаменатор", icon: GraduationCap },
      { href: "/dashboard/review", label: "Повторение", icon: Layers },
    ],
  },
];
function Shell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const appBody = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 700px)");
    const navigation = sidebar.current;
    const background = appBody.current;
    if (!open || !mobile.matches || !navigation || !background) return;

    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    const wasInert = background.inert;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    background.inert = true;

    const focusable = () =>
      Array.from(
        navigation.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
    const initialFocus =
      navigation.querySelector<HTMLElement>('[aria-current="page"]') ||
      focusable()[0] ||
      navigation;
    initialFocus.focus();

    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) {
        event.preventDefault();
        navigation.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === navigation)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const keepFocus = (event: FocusEvent) => {
      if (!navigation.contains(event.target as Node)) {
        (focusable()[0] || navigation).focus();
      }
    };
    const resized = () => {
      if (!mobile.matches) setOpen(false);
    };
    document.addEventListener("keydown", keyDown);
    document.addEventListener("focusin", keepFocus);
    mobile.addEventListener("change", resized);
    return () => {
      document.removeEventListener("keydown", keyDown);
      document.removeEventListener("focusin", keepFocus);
      mobile.removeEventListener("change", resized);
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      background.inert = wasInert;
      if (mobile.matches) menuButton.current?.focus({ preventScroll: true });
    };
  }, [open]);
  const nav = sections.flatMap((s) => s.items);
  const label = pathname.startsWith("/dashboard/admin")
    ? "Администрирование"
    : pathname === "/dashboard/profile"
      ? "Мой профиль"
      : nav.find(
          (item) =>
            item.href !== "/dashboard" && pathname.startsWith(item.href),
        )?.label || "Обзор";
  const firstName = user.name || user.email.split("@")[0];
  async function logout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      await api("/auth/logout", { method: "POST" });
      setToken(null);
      router.replace("/login");
    } catch (e) {
      setLogoutError(e instanceof Error ? e.message : "Не удалось выйти");
      setLoggingOut(false);
    }
  }
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Перейти к содержимому
      </a>
      <button
        className={`sidebar-overlay ${open ? "is-open" : ""}`}
        onClick={() => setOpen(false)}
        aria-label="Закрыть меню"
        tabIndex={-1}
      />
      <aside
        id="dashboard-navigation"
        ref={sidebar}
        className={`sidebar ${open ? "is-open" : ""}`}
        aria-label="Боковая навигация"
        role={open ? "dialog" : undefined}
        aria-modal={open || undefined}
        tabIndex={-1}
      >
        <button
          type="button"
          className="menu-toggle"
          style={{ position: "absolute", top: 16, right: 12 }}
          onClick={() => setOpen(false)}
          aria-label="Закрыть меню"
        >
          <X size={17} />
        </button>
        <Brand />
        <div className="workspace-label">
          <GraduationCap size={18} />
          <span>Учебное пространство</span>
          <span>⌘</span>
        </div>
        <nav className="sidebar-nav">
          {sections.map((section) => (
            <div key={section.title}>
              <div className="nav-section">{section.title}</div>
              {section.items.map(({ href, label, icon: Icon }) => (
                <Link
                  href={href}
                  key={href}
                  onClick={() => setOpen(false)}
                  aria-current={
                    (
                      href === "/dashboard"
                        ? pathname === href
                        : pathname.startsWith(href)
                    )
                      ? "page"
                      : undefined
                  }
                  className={`nav-link ${(href === "/dashboard" ? pathname === href : pathname.startsWith(href)) ? "active" : ""}`}
                >
                  <Icon />
                  {label}
                </Link>
              ))}
            </div>
          ))}
          {user.role === "admin" && (
            <>
              <div className="nav-section">УПРАВЛЕНИЕ</div>
              <Link
                onClick={() => setOpen(false)}
                href="/dashboard/admin"
                className={`nav-link ${pathname.startsWith("/dashboard/admin") ? "active" : ""}`}
              >
                <ShieldCheck />
                Администратор
              </Link>
              <Link
                onClick={() => setOpen(false)}
                href="/dashboard/admin#system-host"
                className="nav-link"
              >
                <Power />
                Остановить сайт
              </Link>
            </>
          )}
        </nav>
        <div className="sidebar-tip">
          <Sparkles size={17} />
          <strong>Есть сложный вопрос?</strong>
          <p>Разберите его с ИИ-помощником.</p>
          <Link href="/dashboard/chat" onClick={() => setOpen(false)}>
            Начать диалог
            <ArrowUpRight size={13} />
          </Link>
        </div>
        <div className="sidebar-profile">
          <span className="avatar">{firstName.slice(0, 1).toUpperCase()}</span>
          <Link href="/dashboard/profile" onClick={() => setOpen(false)}>
            <strong>{firstName}</strong>
            <small>{user.role === "admin" ? "Администратор" : "Студент"}</small>
          </Link>
          <button
            onClick={logout}
            disabled={loggingOut}
            aria-label="Выйти из аккаунта"
            title="Выйти из аккаунта"
          >
            <LogOut size={15} />
          </button>
        </div>
        {logoutError && (
          <p role="alert" className="text-xs text-red-500">
            {logoutError}
          </p>
        )}
      </aside>
      <div className="app-body" ref={appBody}>
        <header className="app-topbar">
          <button
            ref={menuButton}
            className="menu-toggle"
            onClick={() => setOpen(!open)}
            aria-label={open ? "Закрыть меню" : "Открыть меню"}
            aria-expanded={open}
            aria-controls="dashboard-navigation"
          >
            {open ? <X size={17} /> : <Menu size={17} />}
          </button>
          <div className="breadcrumb">
            <Link href="/dashboard">Моё пространство</Link>
            <ChevronRight size={12} />
            <strong>{label}</strong>
          </div>
          <div className="topbar-right">
            <LumaNavLink />
            <span className="topbar-date">
              <CalendarDays
                size={13}
                style={{ display: "inline", marginRight: 7 }}
              />
              {new Date().toLocaleDateString("ru-RU", {
                day: "numeric",
                month: "long",
              })}
            </span>
            <NotificationsBell />
            <Link href="/dashboard/profile" aria-label="Мой профиль">
              <span className="avatar">
                {firstName.slice(0, 1).toUpperCase()}
              </span>
            </Link>
          </div>
        </header>
        <main id="main-content" className="app-main">
          {children}
        </main>
      </div>
    </div>
  );
}
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthProvider>
      <Shell>{children}</Shell>
    </AuthProvider>
  );
}
