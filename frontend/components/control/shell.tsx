"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  BookOpen,
  Boxes,
  Compass,
  Gamepad2,
  History,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  MessagesSquare,
  Palette,
  Server,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { api, setToken } from "@/lib/api";
import { EcosystemLogo } from "@/components/ecosystem-branding";
import styles from "./control.module.css";

const navigation = [
  { href: "/qcontrol", label: "Обзор", icon: LayoutDashboard },
  { href: "/qcontrol/qstudy", label: "QStudy", icon: BookOpen },
  { href: "/qcontrol/qcareer", label: "QCareer", icon: Compass },
  { href: "/qcontrol/qball", label: "QBall", icon: Gamepad2 },
  { href: "/qcontrol/qtests", label: "QTests", icon: ListChecks },
  { href: "/qcontrol/qmessage", label: "QMessage", icon: MessagesSquare },
  { href: "/qcontrol/accounts", label: "Аккаунты Q-ID", icon: Users },
  { href: "/qcontrol/branding", label: "Брендинг и команда", icon: Palette },
  { href: "/qcontrol/system", label: "Сервер и перенос", icon: Server },
  { href: "/qcontrol/operations", label: "Копии и журнал", icon: History },
];

const mobileQuery = "(max-width: 950px)";
const subscribeMobile = (callback: () => void) => {
  const media = window.matchMedia(mobileQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
};
const getMobile = () => window.matchMedia(mobileQuery).matches;
const getServerMobile = () => false;

function ControlWorkspace({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const mobile = useSyncExternalStore(
    subscribeMobile,
    getMobile,
    getServerMobile,
  );
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const current =
    navigation.find((item) => item.href === pathname) ||
    navigation.find(
      (item) =>
        item.href !== "/qcontrol" && pathname.startsWith(`${item.href}/`),
    ) ||
    navigation[0];
  useEffect(() => {
    const media = window.matchMedia(mobileQuery);
    const resized = () => {
      if (!media.matches) setMenuOpen(false);
    };
    media.addEventListener("change", resized);
    return () => media.removeEventListener("change", resized);
  }, []);
  useEffect(() => {
    const navigation = sidebar.current;
    const background = workspace.current;
    if (
      !menuOpen ||
      !mobile ||
      !navigation ||
      !background ||
      user.role !== "admin"
    )
      return;
    const trigger = menuButton.current;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    const wasInert = background.inert;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    background.inert = true;
    const focusable = () =>
      Array.from(
        navigation.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
    (
      navigation.querySelector<HTMLElement>('[aria-current="page"]') ||
      focusable()[0] ||
      navigation
    ).focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
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
      if (!navigation.contains(event.target as Node))
        (focusable()[0] || navigation).focus();
    };
    document.addEventListener("keydown", keyDown);
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("keydown", keyDown);
      document.removeEventListener("focusin", keepFocus);
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      background.inert = wasInert;
      if (window.matchMedia(mobileQuery).matches)
        trigger?.focus({ preventScroll: true });
    };
  }, [menuOpen, mobile, user.role]);

  async function logout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      await api("/auth/logout", { method: "POST" });
      setToken(null);
      router.replace("/login");
    } catch (cause) {
      setLogoutError(
        cause instanceof Error ? cause.message : "Не удалось завершить сеанс.",
      );
      setLoggingOut(false);
    }
  }

  if (user.role !== "admin")
    return (
      <div className={styles.denied}>
        <ShieldCheck size={42} />
        <h1>QControl доступен администратору</h1>
        <p>Ваш аккаунт Q-ID сохраняет доступ к обучению, карьере и игре.</p>
        <Link href="/dashboard" className="btn btn-primary">
          Перейти в QStudy <ArrowUpRight size={16} />
        </Link>
      </div>
    );

  return (
    <div className={styles.root}>
      <a href="#qcontrol-content" className={styles.skip}>
        Перейти к содержимому
      </a>
      {menuOpen && mobile && (
        <button
          className={styles.backdrop}
          onClick={() => setMenuOpen(false)}
          aria-label="Закрыть навигацию"
          tabIndex={-1}
        />
      )}
      <aside
        ref={sidebar}
        className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ""}`}
        id="qcontrol-navigation"
        aria-label="Центр управления"
        inert={mobile && !menuOpen}
        role={mobile && menuOpen ? "dialog" : undefined}
        aria-modal={mobile && menuOpen ? true : undefined}
        tabIndex={-1}
      >
        <div className={styles.brandRow}>
          <Link
            href="/qcontrol"
            className={styles.brand}
            onClick={() => setMenuOpen(false)}
          >
            <EcosystemLogo kind="control" alt="" width={44} height={44} />
            <span>
              <strong>
                QControl<span className={styles.brandDot}>.</span>
              </strong>
              <small>Управление экосистемой</small>
            </span>
          </Link>
          <button
            className={styles.closeMenu}
            type="button"
            onClick={() => setMenuOpen(false)}
            aria-label="Закрыть меню"
          >
            <X size={19} />
          </button>
        </div>
        <p className={styles.navLabel}>РАБОЧЕЕ ПРОСТРАНСТВО</p>
        <nav className={styles.navigation}>
          {navigation.map((item) => {
            const active = current.href === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={active ? styles.active : ""}
                onClick={() => setMenuOpen(false)}
              >
                <item.icon size={18} />
                <span>{item.label}</span>
                {active && <span className={styles.activeDot} />}
              </Link>
            );
          })}
        </nav>
        <div className={styles.sidebarBottom}>
          <div className={styles.ecosystemLabel}>
            <Boxes size={16} /> Перейти в проекты
          </div>
          <div className={styles.projectShortcuts}>
            <Link href="/dashboard">
              QStudy <ArrowUpRight size={13} />
            </Link>
            <Link href="/qcareer">
              QCareer <ArrowUpRight size={13} />
            </Link>
            <Link href="/qball">
              QBall <ArrowUpRight size={13} />
            </Link>
          </div>
          <div className={styles.accessNote}>
            <ShieldCheck size={16} />
            <span>
              Один аккаунт Q-ID.
              <br />
              Полный контроль экосистемы.
            </span>
          </div>
        </div>
      </aside>
      <div className={styles.workspace} ref={workspace}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}>
            <button
              ref={menuButton}
              type="button"
              className={styles.menuButton}
              onClick={() => setMenuOpen(!menuOpen)}
              aria-expanded={menuOpen && mobile}
              aria-controls="qcontrol-navigation"
              aria-label={menuOpen ? "Закрыть меню" : "Открыть меню"}
            >
              {menuOpen ? <X size={21} /> : <Menu size={21} />}
            </button>
            <span className={styles.topBrand}>QControl</span>
            <span className={styles.breadcrumbDivider}>/</span>
            <strong>{current.label}</strong>
          </div>
          <div className={styles.userArea}>
            <span className={styles.adminBadge}>
              <ShieldCheck size={13} /> Администратор
            </span>
            <span className={styles.avatar} aria-hidden="true">
              {(user.name || user.email).slice(0, 1).toUpperCase()}
            </span>
            <span className={styles.userName}>{user.name || user.email}</span>
            <button
              className={styles.logoutButton}
              type="button"
              onClick={() => void logout()}
              disabled={loggingOut}
              aria-label="Выйти из аккаунта Q-ID"
              title="Выйти из Q-ID"
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <main className={styles.content} id="qcontrol-content" tabIndex={-1}>
          {logoutError && (
            <p className={styles.error} role="alert">
              {logoutError}
            </p>
          )}
          {children}
        </main>
        <footer className={styles.footer}>
          <span>QControl · Единый центр управления</span>
          <span>
            Экосистема QForce · QStudy / QTests / QCareer / QBall / QMessage /
            Q-ID
          </span>
        </footer>
      </div>
    </div>
  );
}

export default function ControlShell({ children }: { children: ReactNode }) {
  return (
    <AuthProvider
      loginPath="/login?next=%2Fqcontrol"
      loadingMark={
        <EcosystemLogo kind="control" alt="QControl" width={48} height={48} />
      }
    >
      <ControlWorkspace>{children}</ControlWorkspace>
    </AuthProvider>
  );
}
