"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ArrowUpRight, ShieldCheck, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { LumaBrand } from "./brand";
import { useQBall } from "./context";
import { AppInstallButton } from "@/components/app-install";

export default function LumaShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { identity, config, roomActive } = useQBall();
  const room = pathname.startsWith("/qball/room/");
  const preserveRoom = room && roomActive;
  const navigation = preserveRoom
    ? { target: "_blank", rel: "noopener noreferrer" }
    : {};
  return (
    <div
      className={`lb-site ${room ? "lb-site-room" : ""} ${room || pathname === "/qball/play" ? "lb-site-original" : ""}`}
    >
      <header className="lb-header">
        <div className="lb-header-inner">
          <LumaBrand newTab={preserveRoom} />
          <nav className="lb-nav" aria-label="Навигация QBall">
            <Link
              href="/qball/play"
              {...navigation}
              aria-current={pathname === "/qball/play" ? "page" : undefined}
            >
              Комнаты
            </Link>
            <Link href="/qball#how-to-play" {...navigation}>
              Как играть
            </Link>
            <Link href="/qball#rules" {...navigation}>
              Правила
            </Link>
            <Link href="/qcareer" {...navigation}>
              QCareer
            </Link>
            <Link href="/qtests" {...navigation}>
              QTests
            </Link>
          </nav>
          <div className="lb-header-actions">
            {!room && <AppInstallButton compact />}
            <Link
              href={identity?.kind === "user" ? "/dashboard" : "/qstudy"}
              {...navigation}
              className="lb-qstudy-link"
            >
              <ArrowLeft size={14} /> QStudy
            </Link>
            {identity?.is_admin && (
              <Link
                href="/qcontrol/qball"
                {...navigation}
                className="lb-icon-link"
                aria-label="Управление QBall"
              >
                <ShieldCheck size={18} />
              </Link>
            )}
            {identity ? (
              <Link
                className="lb-identity"
                href="/qball/play"
                {...navigation}
                title={identity.name}
              >
                <UserRound size={14} />
                <span>{identity.name}</span>
              </Link>
            ) : (
              <Link
                className="lb-header-login"
                href="/login?next=%2Fqball%2Fplay"
                {...navigation}
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
            <span>QBall · QStudy © {new Date().getFullYear()}</span>
          </div>
        </footer>
      )}
    </div>
  );
}
