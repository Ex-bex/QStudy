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
import type { LumaConfig, LumaIdentity, LumaSession } from "@/types/lumaball";
import { requestGameSession } from "@/lib/lumaball/session-queue";

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
  roomActive: boolean;
  setRoomActive: (active: boolean) => void;
  refresh: () => Promise<void>;
  enter: () => Promise<LumaIdentity>;
};

const LumaContext = createContext<LumaContextValue | null>(null);

export function QBallProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState(DEFAULT_LUMA_CONFIG);
  const [identity, setIdentity] = useState<LumaIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [roomActive, setRoomActive] = useState(false);
  const revision = useRef(0);
  const pendingEntry = useRef<Promise<LumaIdentity> | null>(null);
  const refresh = useCallback(async () => {
    const requestRevision = ++revision.current;
    try {
      const value = await lumaApi<LumaConfig>("/lumaball/config");
      if (requestRevision !== revision.current) return;
      setConfig(value);
      setError("");
      const response = await fetch("/api/lumaball/me", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (requestRevision !== revision.current) return;
      if (response.ok) {
        const current = (await response.json()) as {
          identity: LumaIdentity;
          config: LumaConfig;
        };
        if (requestRevision !== revision.current) return;
        setIdentity(current.identity);
        setConfig(current.config);
      } else if (response.status === 401) setIdentity(null);
    } catch (cause) {
      if (requestRevision !== revision.current) return;
      setError(
        cause instanceof Error ? cause.message : "Не удалось загрузить QBall.",
      );
    } finally {
      if (requestRevision === revision.current) setLoading(false);
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
  const enter = useCallback(() => {
    if (pendingEntry.current) return pendingEntry.current;
    ++revision.current;
    const operation = requestGameSession<LumaSession>().then((session) => {
      ++revision.current;
      setIdentity(session.identity);
      setConfig(session.config);
      setError("");
      setLoading(false);
      return session.identity;
    });
    pendingEntry.current = operation;
    void operation.then(
      () => {
        pendingEntry.current = null;
      },
      () => {
        pendingEntry.current = null;
        setLoading(false);
      },
    );
    return operation;
  }, []);
  return (
    <LumaContext.Provider
      value={{
        config,
        identity,
        loading,
        error,
        roomActive,
        setRoomActive,
        refresh,
        enter,
      }}
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
