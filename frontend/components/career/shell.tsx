"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ArrowUpRight, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import CareerBrand from "./brand";
import { useCareer } from "./context";
import styles from "./career.module.css";
import { AppInstallButton } from "@/components/app-install";

export default function CareerShell({ children }: { children: ReactNode }) {
  const { config, user, error, refresh } = useCareer();
  const pathname = usePathname();
  return (
    <div className={styles.root}>
      <a href="#career-main" className={styles.skip}>
        Перейти к содержимому
      </a>
      <header className={styles.header}>
        <CareerBrand />
        <nav aria-label="Навигация QCareer" className={styles.headerNav}>
          <AppInstallButton compact />
          <Link href="/dashboard" className={styles.backLink}>
            <ArrowLeft size={15} /> QStudy
          </Link>
          <Link
            href="/qcareer"
            aria-current={pathname === "/qcareer" ? "page" : undefined}
          >
            О проекте
          </Link>
          {user?.role === "admin" && (
            <Link href="/qcontrol/qcareer" className={styles.adminLink}>
              <ShieldCheck size={16} />
              <span>Управление</span>
            </Link>
          )}
          <Link
            className={styles.smallButton}
            href={
              user ? "/qcareer/workspace" : "/login?next=%2Fqcareer%2Fworkspace"
            }
          >
            {user ? "Моя траектория" : "Войти"}
            <ArrowUpRight size={16} />
          </Link>
        </nav>
      </header>
      {config?.announcement && (
        <div className={styles.announcement}>{config.announcement}</div>
      )}
      {error && (
        <div className={styles.notice} role="alert">
          QCareer сейчас недоступен: {error}.{" "}
          <button onClick={() => void refresh()}>Повторить</button>
        </div>
      )}
      {children}
      <footer className={styles.footer}>
        <CareerBrand />
        <p>Ваши знания обретают направление.</p>
        <div>
          <Link href="/qstudy">QStudy</Link>
          <Link href="/">QForce</Link>
          <Link href="/qball">QBall</Link>
          <Link href="/qtests">QTests</Link>
          <Link href="/developers">Разработчики</Link>
        </div>
      </footer>
    </div>
  );
}
