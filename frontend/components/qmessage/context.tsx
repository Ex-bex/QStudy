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
import type { MessageConfig } from "@/lib/qmessage";

const Context = createContext<{
  config: MessageConfig | null;
  error: string;
  refresh: () => Promise<void>;
}>({ config: null, error: "", refresh: async () => {} });

export function QMessageProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<MessageConfig | null>(null);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const value = await api<MessageConfig>("/qmessage/config");
      if (request === revision.current) {
        setConfig(value);
        setError("");
      }
    } catch (cause) {
      if (request === revision.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить QMessage",
        );
    }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void refresh();
    });
    const updated = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === "qmessage:config-updated") updated();
    };
    window.addEventListener("focus", updated);
    window.addEventListener("qmessage:config-updated", updated);
    window.addEventListener("storage", storage);
    return () => {
      active = false;
      invalidate();
      window.removeEventListener("focus", updated);
      window.removeEventListener("qmessage:config-updated", updated);
      window.removeEventListener("storage", storage);
    };
  }, [refresh, invalidate]);
  return (
    <Context.Provider value={{ config, error, refresh }}>
      {children}
    </Context.Provider>
  );
}

export function useQMessage() {
  return useContext(Context);
}
