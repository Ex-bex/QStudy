"use client";

import { useState, type FormEvent } from "react";
import { LockKeyhole, Save, UserRound } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import PasswordInput from "@/components/password-input";
import {
  PageTitle,
  ErrorNotice,
  Loading,
  errorMessage,
} from "@/components/academic";

export default function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  async function saveProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api("/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ name: form.get("name") }),
      });
      await refreshUser();
      setSuccess("Имя обновлено.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function savePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const element = e.currentTarget;
    const form = new FormData(element);
    setError("");
    setSuccess("");
    if (form.get("new_password") !== form.get("confirm_password")) {
      setError("Новые пароли не совпадают.");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/password", {
        method: "POST",
        body: JSON.stringify({
          current_password: form.get("current_password"),
          new_password: form.get("new_password"),
        }),
      });
      await refreshUser();
      element.reset();
      setSuccess("Пароль изменён. Остальные сессии завершены.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!user) return <Loading />;
  return (
    <div className="academic-profile">
      <PageTitle
        eyebrow="ЛИЧНОЕ ПРОСТРАНСТВО"
        title="Мой профиль"
        description="Ваши данные и безопасность аккаунта."
      />
      <ErrorNotice message={error} />
      {success && (
        <p className="academic-success" role="status">
          {success}
        </p>
      )}
      <section className="panel">
        <div className="academic-card-top">
          <h2>
            <UserRound
              size={18}
              style={{ display: "inline", marginRight: 10 }}
            />
            Личные данные
          </h2>
          <span className="badge">
            {user.role === "admin" ? "Администратор" : "Студент"}
          </span>
        </div>
        <form onSubmit={saveProfile}>
          <div className="academic-fields">
            <label className="academic-field">
              <span>Имя</span>
              <input
                className="field"
                name="name"
                defaultValue={user.name}
                maxLength={120}
                required
                autoComplete="name"
              />
            </label>
            <label className="academic-field">
              <span>Email</span>
              <input
                className="field"
                type="email"
                value={user.email}
                readOnly
              />
              <small className="muted">
                Email, роль и группу изменяет администратор.
              </small>
            </label>
          </div>
          <div className="academic-form-actions">
            <button className="btn btn-primary" disabled={busy}>
              <Save size={16} />
              {busy ? "Сохраняем…" : "Сохранить изменения"}
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>
          <LockKeyhole
            size={18}
            style={{ display: "inline", marginRight: 10 }}
          />
          Изменить пароль
        </h2>
        <form onSubmit={savePassword}>
          <div className="academic-fields">
            <label className="academic-field">
              <span>Текущий пароль</span>
              <PasswordInput
                className="field"
                name="current_password"
                required
                maxLength={128}
                autoComplete="current-password"
              />
            </label>
            <label className="academic-field">
              <span>Новый пароль</span>
              <PasswordInput
                className="field"
                name="new_password"
                required
                minLength={10}
                maxLength={128}
                autoComplete="new-password"
              />
              <small className="muted">
                От 10 символов, минимум одна буква и одна цифра.
              </small>
            </label>
            <label className="academic-field">
              <span>Повторите новый пароль</span>
              <PasswordInput
                className="field"
                name="confirm_password"
                required
                minLength={10}
                maxLength={128}
                autoComplete="new-password"
              />
            </label>
          </div>
          <div className="academic-form-actions">
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Сохраняем…" : "Обновить пароль"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
