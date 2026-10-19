"use client";

import Image, { type ImageProps } from "next/image";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";
import {
  DEFAULT_QMESSAGE_BRANDING,
  QMESSAGE_LOGO,
  normalizeQMessageBranding,
  type QMessageBranding,
} from "@/lib/qmessage-branding";

export { QMESSAGE_LOGO, type QMessageBranding } from "@/lib/qmessage-branding";
const EVENT = "qmessage:branding-updated";
const Context = createContext({
  branding: DEFAULT_QMESSAGE_BRANDING,
  loading: true,
  error: "",
  refresh: async () => {},
});

export function notifyQMessageBranding(value: QMessageBranding) {
  window.dispatchEvent(
    new CustomEvent(EVENT, { detail: normalizeQMessageBranding(value) }),
  );
  try {
    localStorage.setItem(EVENT, String(Date.now()));
  } catch {}
}

export function QMessageBrandingProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [branding, setBranding] = useState(DEFAULT_QMESSAGE_BRANDING);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const value = await api<QMessageBranding>("/branding/message");
      if (request !== revision.current) return;
      setBranding(normalizeQMessageBranding(value));
      setError("");
    } catch (cause) {
      if (request === revision.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить логотип QMessage",
        );
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void refresh();
    });
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && event.detail) {
        invalidate();
        setBranding(normalizeQMessageBranding(event.detail));
        setLoading(false);
        setError("");
      } else void refresh();
    };
    const focus = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === EVENT) void refresh();
    };
    window.addEventListener(EVENT, changed);
    window.addEventListener("focus", focus);
    window.addEventListener("storage", storage);
    return () => {
      active = false;
      invalidate();
      window.removeEventListener(EVENT, changed);
      window.removeEventListener("focus", focus);
      window.removeEventListener("storage", storage);
    };
  }, [refresh, invalidate]);
  return (
    <Context.Provider value={{ branding, loading, error, refresh }}>
      {children}
    </Context.Provider>
  );
}

export function useQMessageBranding() {
  return useContext(Context);
}

export function QMessageLogo({
  alt = "QMessage",
  width = 40,
  height = 40,
  ...props
}: Omit<ImageProps, "src" | "alt"> & { alt?: string }) {
  const { branding } = useQMessageBranding();
  const [failed, setFailed] = useState("");
  return (
    <Image
      {...props}
      src={failed === branding.logo_url ? QMESSAGE_LOGO : branding.logo_url}
      width={width}
      height={height}
      alt={alt}
      unoptimized
      onError={() => setFailed(branding.logo_url)}
    />
  );
}
