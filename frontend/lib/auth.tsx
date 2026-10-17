"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, setToken } from "./api";
import { BrandMark } from "@/components/brand";

export interface User {
  id: number;
  email: string;
  name: string;
  role: "admin" | "student";
  is_active: boolean;
  group_id: number | null;
  created_at: string;
}
const AuthContext = createContext<{
  user: User;
  refreshUser: () => Promise<void>;
} | null>(null);

export function AuthProvider({
  children,
  loginPath = "/login",
}: {
  children: React.ReactNode;
  loginPath?: string;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  const router = useRouter();
  const refreshUser = useCallback(async () => {
    const request = ++revision.current;
    setError("");
    try {
      const current = await api<User>("/auth/me");
      if (request === revision.current) setUser(current);
    } catch (e) {
      if (request !== revision.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setUser(null);
        router.replace(loginPath);
      } else
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить профиль",
        );
    }
  }, [router, loginPath]);
  useEffect(() => {
    setToken("cookie");
    void refreshUser();
    let timer: number | undefined;
    const updated = () => {
      if (document.visibilityState === "hidden") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refreshUser(), 120);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === "qstudy:account-updated") updated();
    };
    const expired = () => {
      invalidate();
      setUser(null);
      router.replace(loginPath);
    };
    window.addEventListener("qstudy:unauthorized", expired);
    window.addEventListener("qstudy:account-updated", updated);
    window.addEventListener("focus", updated);
    window.addEventListener("storage", storage);
    document.addEventListener("visibilitychange", updated);
    const polling = window.setInterval(updated, 60000);
    return () => {
      invalidate();
      window.clearTimeout(timer);
      window.clearInterval(polling);
      window.removeEventListener("qstudy:unauthorized", expired);
      window.removeEventListener("qstudy:account-updated", updated);
      window.removeEventListener("focus", updated);
      window.removeEventListener("storage", storage);
      document.removeEventListener("visibilitychange", updated);
    };
  }, [refreshUser, router, loginPath, invalidate]);
  if (!user)
    return (
      <div className="app-loading">
        <BrandMark />
        <p>{error || "Открываем ваше пространство…"}</p>
        {error && (
          <button className="btn btn-primary" onClick={refreshUser}>
            Попробовать снова
          </button>
        )}
      </div>
    );
  return (
    <AuthContext.Provider value={{ user, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth requires AuthProvider");
  return value;
}
