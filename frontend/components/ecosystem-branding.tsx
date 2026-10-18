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
import { CONTROL_LOGO, QID_LOGO } from "@/lib/identity-brand";
import {
  DEFAULT_ECOSYSTEM_BRANDING,
  FORCE_LOGO,
  normalizeEcosystemBranding,
  type EcosystemBranding,
} from "@/lib/ecosystem-branding";

const EVENT = "qstudy:ecosystem-branding-updated";
const Context = createContext({
  branding: DEFAULT_ECOSYSTEM_BRANDING,
  error: "",
  refresh: async () => {},
});

export function notifyEcosystemBrandingChanged(value: EcosystemBranding) {
  window.dispatchEvent(
    new CustomEvent(EVENT, { detail: normalizeEcosystemBranding(value) }),
  );
  try {
    localStorage.setItem(EVENT, String(Date.now()));
  } catch {}
}

export function EcosystemBrandingProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [branding, setBranding] = useState(DEFAULT_ECOSYSTEM_BRANDING);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const value = await api<EcosystemBranding>("/branding/ecosystem");
      if (request !== revision.current) return;
      setBranding(normalizeEcosystemBranding(value));
      setError("");
    } catch (cause) {
      if (request === revision.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить логотипы",
        );
    }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void refresh();
    });
    const updated = (event: Event) => {
      if (event instanceof CustomEvent && event.detail) {
        invalidate();
        setBranding(normalizeEcosystemBranding(event.detail));
        setError("");
      } else void refresh();
    };
    const focus = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === EVENT) void refresh();
    };
    window.addEventListener(EVENT, updated);
    window.addEventListener("focus", focus);
    window.addEventListener("storage", storage);
    return () => {
      active = false;
      invalidate();
      window.removeEventListener(EVENT, updated);
      window.removeEventListener("focus", focus);
      window.removeEventListener("storage", storage);
    };
  }, [refresh, invalidate]);
  return (
    <Context.Provider value={{ branding, error, refresh }}>
      {children}
    </Context.Provider>
  );
}

export function useEcosystemBranding() {
  return useContext(Context);
}

export function EcosystemLogo({
  kind,
  ...props
}: Omit<ImageProps, "src"> & { kind: "force" | "identity" | "control" }) {
  const { branding } = useEcosystemBranding();
  const requested =
    kind === "force"
      ? branding.force_logo_url
      : kind === "identity"
        ? branding.identity_logo_url
        : branding.control_logo_url;
  const fallback =
    kind === "force"
      ? FORCE_LOGO
      : kind === "identity"
        ? QID_LOGO
        : CONTROL_LOGO;
  const [failed, setFailed] = useState("");
  return (
    <Image
      {...props}
      src={failed === requested ? fallback : requested}
      unoptimized
      onError={() => setFailed(requested)}
    />
  );
}
