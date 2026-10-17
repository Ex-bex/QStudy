"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  const router = useRouter();
  const refreshUser = useCallback(async () => {
    setError("");
    try {
      setUser(await api<User>("/auth/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace(loginPath);
      else
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить профиль",
        );
    }
  }, [router, loginPath]);
  useEffect(() => {
    setToken("cookie");
    refreshUser();
    const expired = () => {
      setUser(null);
      router.replace(loginPath);
    };
    window.addEventListener("qstudy:unauthorized", expired);
    return () => window.removeEventListener("qstudy:unauthorized", expired);
  }, [refreshUser, router, loginPath]);
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
