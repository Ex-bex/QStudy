"use client";

import Image from "next/image";
import Link from "next/link";
import { useQBall } from "./context";

export function LumaMark({ className = "" }: { className?: string }) {
  const { config } = useQBall();
  return (
    <span className={`lb-brand-mark ${className}`}>
      <Image
        src={config.logo_url || "/branding/qball-logo.png"}
        alt=""
        width={44}
        height={44}
        unoptimized
      />
    </span>
  );
}

export function LumaBrand({ compact = false }: { compact?: boolean }) {
  const { config } = useQBall();
  return (
    <Link
      className={`lb-brand ${compact ? "lb-brand-compact" : ""}`}
      href="/qball"
      aria-label={`${config.title} — главная`}
    >
      <LumaMark />
      <span>
        {config.title}
        <small>PLAY A LITTLE. FEEL A LOT.</small>
      </span>
    </Link>
  );
}
