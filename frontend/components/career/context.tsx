"use client";

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
import type { User } from "@/lib/auth";
import type { CareerConfig } from "@/types/career";

type CareerContextValue = {
  config: CareerConfig | null;
  user: User | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
};
const CareerContext = createContext<CareerContextValue | null>(null);

export function CareerProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<CareerConfig | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const value = await api<CareerConfig>("/career/config");
      if (request !== revision.current) return;
      setConfig(value);
      setError("");
      const response = await fetch("/api/auth/me", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (request !== revision.current) return;
      if (response.ok) setUser(await response.json());
      else if (response.status === 401) setUser(null);
    } catch (cause) {
      if (request !== revision.current) return;
      setError(
        cause instanceof Error ? cause.message : "Не удалось загрузить QCareer",
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
    const updated = () => void refresh();
    const storage = (event: StorageEvent) => {
      if (event.key === "qcareer:updated") updated();
    };
    window.addEventListener("qcareer:updated", updated);
    window.addEventListener("focus", updated);
    window.addEventListener("storage", storage);
    return () => {
      active = false;
      invalidate();
      window.removeEventListener("qcareer:updated", updated);
      window.removeEventListener("focus", updated);
      window.removeEventListener("storage", storage);
    };
  }, [refresh, invalidate]);
  useEffect(() => {
    if (!config) return;
    const title = document.title;
    document.title = `${config.title || "QCareer"} — из учёбы в будущее · QStudy`;
    const url = config.logo_url || "/brand/qforcelogo_qcareer.png";
    const icons = Array.from(
      document.querySelectorAll<HTMLLinkElement>(
        'link[rel="icon"], link[rel="apple-touch-icon"]',
      ),
    );
    const previous = icons.map((icon) => ({
      icon,
      href: icon.getAttribute("href"),
      type: icon.getAttribute("type"),
    }));
    let created: HTMLLinkElement | null = null;
    if (!icons.length) {
      created = document.createElement("link");
      created.rel = "icon";
      document.head.appendChild(created);
      icons.push(created);
    }
    for (const icon of icons) {
      icon.href = url;
      icon.type = url.split("?")[0].endsWith(".svg")
        ? "image/svg+xml"
        : "image/png";
    }
    return () => {
      document.title = title;
      created?.remove();
      for (const { icon, href, type } of previous) {
        if (href === null) icon.removeAttribute("href");
        else icon.setAttribute("href", href);
        if (type === null) icon.removeAttribute("type");
        else icon.setAttribute("type", type);
      }
    };
  }, [config]);
  return (
    <CareerContext.Provider value={{ config, user, loading, error, refresh }}>
      {children}
    </CareerContext.Provider>
  );
}

export function useCareer() {
  const context = useContext(CareerContext);
  if (!context) throw new Error("useCareer requires CareerProvider");
  return context;
}
