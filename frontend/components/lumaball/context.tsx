"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { LumaConfig, LumaIdentity, LumaSession } from "@/types/lumaball";

export const DEFAULT_LUMA_CONFIG: LumaConfig = {
  enabled: true,
  title: "QBall",
  description:
    "Маленькое поле. Большие эмоции. Футбол в браузере, где решают реакция и командная игра.",
  announcement: "",
  rules:
    "Играйте честно, уважайте соперников и получайте удовольствие от матча.",
  logo_url: null,
  guests_enabled: true,
  guest_create_rooms: true,
  max_rooms: 20,
  max_players: 8,
  default_players: 4,
  score_limit: 5,
  time_limit: 5,
  chat_enabled: true,
};

export async function lumaApi<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers.has("content-type")
  )
    headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = data.detail;
    throw new Error(
      typeof detail === "string"
        ? detail
        : "Не удалось выполнить действие. Попробуйте ещё раз.",
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

type LumaContextValue = {
  config: LumaConfig;
  identity: LumaIdentity | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  enter: () => Promise<LumaIdentity>;
};

const LumaContext = createContext<LumaContextValue | null>(null);

export function QBallProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState(DEFAULT_LUMA_CONFIG);
  const [identity, setIdentity] = useState<LumaIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const value = await lumaApi<LumaConfig>("/lumaball/config");
      setConfig(value);
      setError("");
      const response = await fetch("/api/lumaball/me", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.ok) {
        const current = (await response.json()) as {
          identity: LumaIdentity;
          config: LumaConfig;
        };
        setIdentity(current.identity);
        setConfig(current.config);
      } else if (response.status === 401) setIdentity(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить QBall.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void refresh();
    });
    const update = () => {
      void refresh();
    };
    window.addEventListener("lumaball:updated", update);
    window.addEventListener("focus", update);
    return () => {
      active = false;
      window.removeEventListener("lumaball:updated", update);
      window.removeEventListener("focus", update);
    };
  }, [refresh]);
  const enter = useCallback(async () => {
    const session = await lumaApi<LumaSession>("/lumaball/session", {
      method: "POST",
    });
    setIdentity(session.identity);
    setConfig(session.config);
    setError("");
    return session.identity;
  }, []);
  return (
    <LumaContext.Provider
      value={{ config, identity, loading, error, refresh, enter }}
    >
      {children}
    </LumaContext.Provider>
  );
}

export function useQBall() {
  const value = useContext(LumaContext);
  if (!value) throw new Error("QBallProvider is required");
  return value;
}
