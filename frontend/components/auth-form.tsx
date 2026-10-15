"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import Brand from "./brand";
import LearningScene from "./learning-scene";
import PasswordInput from "./password-input";
import { api, setToken } from "@/lib/api";
import { authReturnPath } from "@/lib/auth-return";

export default function AuthForm({ register = false }: { register?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [returnTo, setReturnTo] = useState("/dashboard");
  useEffect(() => {
    setReturnTo(
      authReturnPath(new URLSearchParams(window.location.search).get("next")),
    );
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (register && password !== confirmPassword) {
      setError("Пароли не совпадают");
      return;
    }
    if (register && (!/[\p{L}]/u.test(password) || !/\d/.test(password))) {
      setError("Добавьте в пароль буквы и цифры");
      return;
    }
    setLoading(true);
    try {
      await api(register ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: register
          ? JSON.stringify({ name, email, password })
          : new URLSearchParams({ username: email, password }),
      });
      setToken("cookie");
      router.replace(returnTo);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось войти");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="auth-page">
      <section className="auth-visual">
        <Brand />
        <div className="auth-quote">
          <span className="eyebrow">ВАШЕ ПРОСТРАНСТВО ДЛЯ РОСТА</span>
          <h2>
            Любопытство.
            <br />
            Ваше главное
            <br />
            <em>преимущество.</em>
          </h2>
          <p>
            Учитесь в своём ритме.
            <br />
            Всё остальное мы поможем организовать.
          </p>
        </div>
        <LearningScene compact />
        <span className="auth-footnote">СОЗДАНО ДЛЯ ТЕХ, КТО ИДЁТ ВПЕРЁД</span>
      </section>
      <main className="auth-main">
        <Link href="/" className="back-link">
          <ArrowLeft size={16} /> На главную
        </Link>
        <div className="auth-form-wrap">
          <span className="eyebrow">НАЧИНАЕТСЯ С ВАС</span>
          <h1>
            {register ? "Давайте знакомиться" : "С возвращением"}
            <span className="brand-dot">.</span>
          </h1>
          <p className="muted">
            {register
              ? "Создайте аккаунт и соберите учёбу в одном месте."
              : "Ваши планы, идеи и новые открытия уже здесь."}
          </p>
          <form onSubmit={submit} className="auth-form">
            {error && (
              <div className="alert" role="alert">
                {error}
              </div>
            )}
            {register && (
              <label>
                Как вас зовут
                <input
                  className="field"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ваше имя"
                  maxLength={100}
                  required
                />
              </label>
            )}
            <label>
              Электронная почта
              <input
                className="field"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                maxLength={254}
              />
            </label>
            <label>
              Пароль
              <PasswordInput
                className="field"
                autoComplete={register ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  register ? "Придумайте надёжный пароль" : "Введите пароль"
                }
                minLength={register ? 10 : 1}
                maxLength={128}
                required
              />
              {register && (
                <small className="muted">
                  От 10 символов, с буквами и цифрами.
                </small>
              )}
            </label>
            {register && (
              <label>
                Повторите пароль
                <PasswordInput
                  className="field"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </label>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="animate-spin" size={18} />
              ) : (
                <>
                  {register ? "Создать аккаунт" : "Войти в пространство"}
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
          {!register && (
            <p className="auth-switch">
              <Link href="/forgot-password">Забыли пароль?</Link>
            </p>
          )}
          <p className="auth-switch">
            {register ? "Уже с нами?" : "Пока нет аккаунта?"}{" "}
            <Link
              href={`${register ? "/login" : "/register"}${returnTo === "/dashboard" ? "" : `?next=${encodeURIComponent(returnTo)}`}`}
            >
              {register ? "Войти" : "Зарегистрироваться"}
            </Link>
          </p>
          <div className="auth-security">
            <ShieldCheck size={15} />
            <span>Личные материалы доступны только вам</span>
          </div>
        </div>
        <p className="auth-bottom">
          <span>QStudy · Учиться. Понимать. Расти.</span>
          <Link href="/developers">Связь с разработчиками</Link>
        </p>
      </main>
    </div>
  );
}
