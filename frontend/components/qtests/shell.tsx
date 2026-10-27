"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, ArrowUpRight, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import type { User } from "@/lib/auth";
import type { QTestsConfig } from "@/lib/qtests";
import { QTestsLogo } from "@/components/qtests-brand";
import styles from "./qtests.module.css";
import { AppInstallButton } from "@/components/app-install";

const ConfigContext = createContext<QTestsConfig | null>(null);
export function useQTestsConfig() {
  return useContext(ConfigContext);
}

export default function QTestsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<QTestsConfig | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const [profile, current] = await Promise.allSettled([
        fetch("/api/auth/me", {
          credentials: "same-origin",
          cache: "no-store",
        }).then(async (res) => (res.ok ? ((await res.json()) as User) : null)),
        api<QTestsConfig>("/qtests/config"),
      ]);
      if (!active) return;
      if (profile.status === "fulfilled") setUser(profile.value);
      if (current.status === "fulfilled") setConfig(current.value);
    };
    void load();
    window.addEventListener("focus", load);
    window.addEventListener("qstudy:account-updated", load);
    return () => {
      active = false;
      window.removeEventListener("focus", load);
      window.removeEventListener("qstudy:account-updated", load);
    };
  }, []);
  return (
    <ConfigContext.Provider value={config}>
      <div className={styles.root}>
        <a href="#qtests-main" className={styles.skip}>
          Перейти к содержимому
        </a>
        <header className={styles.header}>
          <Link
            href="/qtests"
            className={styles.brand}
            aria-label="QTests — главная"
          >
            <QTestsLogo width={42} height={42} />
            <strong>{config?.title || "QTests"}</strong>
          </Link>
          <nav aria-label="Навигация QTests" className={styles.headerNav}>
            <AppInstallButton compact />
            <Link href="/dashboard" className={styles.ecosystem}>
              <ArrowLeft size={15} /> QStudy
            </Link>
            <Link
              href="/qtests"
              aria-current={pathname === "/qtests" ? "page" : undefined}
            >
              О проекте
            </Link>
            {user?.role === "admin" && (
              <Link
                href="/qcontrol/qtests"
                aria-label="Управление QTests в QControl"
              >
                <ShieldCheck size={17} />
                <span>Управление</span>
              </Link>
            )}
            <Link
              className={styles.headerButton}
              href={
                user ? "/qtests/library" : "/login?next=%2Fqtests%2Flibrary"
              }
            >
              {user ? "Мои тесты" : "Войти через Q-ID"}
              <ArrowUpRight size={16} />
            </Link>
          </nav>
        </header>
        {config?.enabled === false && (
          <p className={styles.maintenance} role="status">
            QTests временно закрыт для тренировок. Ваши банки вопросов и
            результаты сохранены.
          </p>
        )}
        {config?.announcement && (
          <p className={styles.announcement} role="status">
            {config.announcement}
          </p>
        )}
        {children}
        <footer className={styles.footer}>
          <span>
            QTests <b>·</b> Разобраться, а не угадать.
          </span>
          <nav aria-label="Проекты экосистемы">
            <Link href="/qstudy">QStudy</Link>
            <Link href="/">QForce</Link>
            <Link href="/qcareer">QCareer</Link>
            <Link href="/qball">QBall</Link>
            <Link href="/developers">Команда</Link>
          </nav>
        </footer>
      </div>
    </ConfigContext.Provider>
  );
}
