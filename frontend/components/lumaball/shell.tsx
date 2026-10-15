"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ArrowUpRight, ShieldCheck, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { LumaBrand } from "./brand";
import { useLumaBall } from "./context";

export default function LumaShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { identity, config } = useLumaBall();
  const room = pathname.startsWith("/lumaball/room/");
  return (
    <div className={`lb-site ${room ? "lb-site-room" : ""}`}>
      <header className="lb-header">
        <div className="lb-header-inner">
          <LumaBrand />
          <nav className="lb-nav" aria-label="Навигация LumaBall">
            <Link
              href="/lumaball/play"
              aria-current={pathname === "/lumaball/play" ? "page" : undefined}
            >
              Комнаты
            </Link>
            <Link href="/lumaball#how-to-play">Как играть</Link>
            <Link href="/lumaball#rules">Правила</Link>
          </nav>
          <div className="lb-header-actions">
            <Link
              href={identity?.kind === "user" ? "/dashboard" : "/"}
              className="lb-qstudy-link"
            >
              <ArrowLeft size={14} /> QStudy
            </Link>
            {identity?.is_admin && (
              <Link
                href="/dashboard/admin/lumaball"
                className="lb-icon-link"
                aria-label="Управление LumaBall"
              >
                <ShieldCheck size={18} />
              </Link>
            )}
            {identity ? (
              <Link
                className="lb-identity"
                href="/lumaball/play"
                title={identity.name}
              >
                <UserRound size={14} />
                <span>{identity.name}</span>
              </Link>
            ) : (
              <Link
                className="lb-header-login"
                href="/login?next=%2Flumaball%2Fplay"
              >
                Войти <ArrowUpRight size={14} />
              </Link>
            )}
          </div>
        </div>
      </header>
      {config.announcement && (
        <div className="lb-announcement" role="status">
          {config.announcement}
        </div>
      )}
      {children}
      {!room && (
        <footer className="lb-footer">
          <LumaBrand compact />
          <p>Тот самый перерыв, который объединяет.</p>
          <div>
            <Link href="/developers">
              Команда QForce <ArrowUpRight size={13} />
            </Link>
            <span>LumaBall · QStudy © {new Date().getFullYear()}</span>
          </div>
        </footer>
      )}
    </div>
  );
}
