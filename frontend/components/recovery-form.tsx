"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import Brand from "./brand";
import LearningScene from "./learning-scene";
import PasswordInput from "./password-input";
import { api, setToken } from "@/lib/api";

type Delivery = "local" | "smtp" | "disabled";

export default function RecoveryForm({ reset = false }: { reset?: boolean }) {
  const [email, setEmail] = useState("");
  const [token, setResetToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const capturedToken = useRef(false);

  useEffect(() => {
    if (reset) {
      if (capturedToken.current) return;
      capturedToken.current = true;
      const value =
        new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
      setResetToken(value);
      window.history.replaceState(null, "", window.location.pathname);
      if (!value)
        setError("Откройте ссылку восстановления целиком или запросите новую.");
    } else {
      api<{ delivery: Delivery }>("/auth/recovery-options")
        .then((result) => setDelivery(result.delivery))
        .catch(() =>
          setError("Не удалось проверить восстановление. Повторите позже."),
        );
    }
  }, [reset]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (reset && password !== confirmation) {
      setError("Пароли не совпадают");
      return;
    }
    if (reset && (!/[\p{L}]/u.test(password) || !/\d/.test(password))) {
      setError("В пароле должны быть буквы и цифры");
      return;
    }
    setLoading(true);
    try {
      const result = await api<{ message: string; delivery?: Delivery }>(
        reset ? "/auth/reset-password" : "/auth/forgot-password",
        {
          method: "POST",
          body: JSON.stringify(
            reset ? { token, new_password: password } : { email },
          ),
        },
      );
      setMessage(result.message);
      if (result.delivery) setDelivery(result.delivery);
      if (reset) {
        setToken(null);
        setPassword("");
        setConfirmation("");
        setResetToken("");
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось восстановить пароль",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <section className="auth-visual">
        <Brand />
        <div className="auth-quote">
          <span className="eyebrow">ПРОДОЛЖАЙТЕ СВОЙ ПУТЬ</span>
          <h2>
            Ваши идеи.
            <br />
            Ваши планы.
            <br />
            <em>Всё сохранено.</em>
          </h2>
          <p>Верните доступ к своему учебному пространству.</p>
        </div>
        <LearningScene compact />
        <span className="auth-footnote">
          QSTUDY · УЧИТЬСЯ. ПОНИМАТЬ. РАСТИ.
        </span>
      </section>
      <main className="auth-main">
        <Link href="/login" className="back-link">
          <ArrowLeft size={16} /> К входу
        </Link>
        <div className="auth-form-wrap">
          <span className="eyebrow">ДОСТУП К АККАУНТУ</span>
          <h1>
            {reset ? "Новый пароль" : "Восстановление"}
            <span className="brand-dot">.</span>
          </h1>
          <p className="muted">
            {reset
              ? "Придумайте новый пароль для вашего аккаунта."
              : "Укажите почту, с которой вы зарегистрировались."}
          </p>
          {message ? (
            <div className="auth-form">
              <p role="status">
                <CheckCircle2 size={20} /> {message}
              </p>
              {!reset && delivery === "local" && (
                <p className="muted">
                  Включён локальный режим. Ссылка сохраняется в закрытой папке
                  восстановления на компьютере сервера. Обратитесь к его
                  владельцу.
                </p>
              )}
              <Link
                className="btn btn-primary"
                href={reset ? "/login" : "/forgot-password"}
                onClick={() => !reset && setMessage("")}
              >
                {reset ? "Войти с новым паролем" : "Запросить снова"}
                <ArrowRight size={18} />
              </Link>
            </div>
          ) : (
            <form className="auth-form" onSubmit={submit}>
              {error && (
                <div className="alert" role="alert">
                  {error}
                </div>
              )}
              {reset ? (
                <>
                  <label>
                    Новый пароль
                    <PasswordInput
                      className="field"
                      autoComplete="new-password"
                      minLength={10}
                      maxLength={128}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                    <small className="muted">
                      10–128 символов, с буквами и цифрами.
                    </small>
                  </label>
                  <label>
                    Повторите пароль
                    <PasswordInput
                      className="field"
                      autoComplete="new-password"
                      minLength={10}
                      maxLength={128}
                      value={confirmation}
                      onChange={(e) => setConfirmation(e.target.value)}
                      required
                    />
                  </label>
                </>
              ) : (
                <label>
                  Электронная почта
                  <input
                    className="field"
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                  />
                </label>
              )}
              {!reset && delivery === "local" && (
                <small className="muted">
                  Сейчас восстановление работает через владельца локального
                  сервера. Для отправки писем администратор может подключить
                  почту.
                </small>
              )}
              {!reset && delivery === "disabled" && (
                <div className="alert">
                  Восстановление пока не настроено. Обратитесь к администратору.
                </div>
              )}
              <button
                className="btn btn-primary"
                disabled={
                  loading ||
                  (reset
                    ? !token
                    : delivery === null || delivery === "disabled")
                }
                type="submit"
              >
                {loading ? (
                  <Loader2 className="animate-spin" size={18} />
                ) : (
                  <>
                    {reset ? "Сохранить пароль" : "Получить ссылку"}
                    <ArrowRight size={18} />
                  </>
                )}
              </button>
              {reset && !token && (
                <Link href="/forgot-password">Запросить новую ссылку</Link>
              )}
            </form>
          )}
          <div className="auth-security">
            <ShieldCheck size={15} />
            <span>Ссылка одноразовая. Материалы аккаунта сохраняются.</span>
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
