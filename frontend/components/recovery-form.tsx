"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import IdentityShell from "./identity-shell";
import styles from "./identity.module.css";
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
    <IdentityShell mode={reset ? "reset" : "forgot"}>
      {message ? (
        <div className={styles.form}>
          <p className={styles.success} role="status">
            <CheckCircle2 size={20} /> {message}
          </p>
          {!reset && delivery === "local" && (
            <p className={styles.help}>
              Включён локальный режим. Ссылка сохраняется в закрытой папке
              восстановления на компьютере сервера. Обратитесь к его владельцу.
            </p>
          )}
          <Link
            className={styles.submit}
            href={reset ? "/login" : "/forgot-password"}
            onClick={() => !reset && setMessage("")}
          >
            {reset ? "Войти с новым паролем" : "Запросить снова"}
            <ArrowRight size={18} />
          </Link>
        </div>
      ) : (
        <form className={styles.form} onSubmit={submit}>
          {error && (
            <div className={styles.alert} role="alert">
              {error}
            </div>
          )}
          {reset ? (
            <>
              <label className={styles.label}>
                Новый пароль
                <PasswordInput
                  className={styles.field}
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <small className={styles.help}>
                  10–128 символов, с буквами и цифрами.
                </small>
              </label>
              <label className={styles.label}>
                Повторите пароль
                <PasswordInput
                  className={styles.field}
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
            <label className={styles.label}>
              Электронная почта
              <input
                className={styles.field}
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
            <small className={styles.help}>
              Сейчас восстановление работает через владельца локального сервера.
              Для отправки писем администратор может подключить почту.
            </small>
          )}
          {!reset && delivery === "disabled" && (
            <div className={styles.alert} role="status">
              Восстановление пока не настроено. Обратитесь к администратору.
            </div>
          )}
          <button
            className={styles.submit}
            disabled={
              loading ||
              (reset ? !token : delivery === null || delivery === "disabled")
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
            <Link className={styles.textLink} href="/forgot-password">
              Запросить новую ссылку
            </Link>
          )}
        </form>
      )}
      <div className={styles.security}>
        <ShieldCheck size={15} />
        <span>Ссылка одноразовая. Материалы аккаунта сохраняются.</span>
      </div>
      <p className={styles.switchRow}>
        Вспомнили пароль? <Link href="/login">Войти в Q-ID</Link>
      </p>
    </IdentityShell>
  );
}
