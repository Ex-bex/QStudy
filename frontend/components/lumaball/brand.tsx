"use client";

import Image from "next/image";
import Link from "next/link";
import { useLumaBall } from "./context";

export function LumaMark({ className = "" }: { className?: string }) {
  const { config } = useLumaBall();
  return (
    <span className={`lb-brand-mark ${className}`}>
      {config.logo_url ? (
        <Image
          src={config.logo_url}
          alt=""
          width={44}
          height={44}
          unoptimized
        />
      ) : (
        <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <rect
            x="1"
            y="1"
            width="46"
            height="46"
            rx="15"
            fill="currentColor"
          />
          <path d="M17 13v22h16v-7H24V13h-7Z" fill="#fff" />
          <circle cx="33" cy="15" r="5" fill="#CFC0FF" />
          <path d="m30 15 2-2 3 1 1 3-3 2-3-2v-2Z" fill="#7143D8" />
        </svg>
      )}
    </span>
  );
}

export function LumaBrand({ compact = false }: { compact?: boolean }) {
  const { config } = useLumaBall();
  return (
    <Link
      className={`lb-brand ${compact ? "lb-brand-compact" : ""}`}
      href="/lumaball"
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
