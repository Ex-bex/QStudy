"use client";

import { useState, type FormEvent } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { api } from "@/lib/api";
import { ErrorNotice, errorMessage } from "@/components/academic";
import PasswordInput from "@/components/password-input";
import styles from "./system.module.css";

export type ServerSettings = {
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_USERNAME: string;
  SMTP_FROM: string;
  SMTP_SECURITY: string;
  RECOVERY_DELIVERY: string;
  GEMINI_MODEL: string;
  GEMINI_WEB_MODEL: string;
  WEB_RESEARCH_ENABLED: boolean;
  REGISTRATION_ENABLED: boolean;
  BACKUPS_ENABLED: boolean;
  BACKUP_INTERVAL_HOURS: number;
  BACKUP_RETENTION_COUNT: number;
  has_smtp_password: boolean;
  has_gemini_api_key: boolean;
  restart_required: boolean;
};
export default function ServerSettingsForm({
  initial,
  disabled,
  onSaved,
}: {
  initial: ServerSettings;
  disabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [smtpPassword, setSmtpPassword] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const change = <K extends keyof ServerSettings>(
    key: K,
    value: ServerSettings[K],
  ) => {
    setSaved(false);
    setForm((current) => ({ ...current, [key]: value }));
  };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const {
        has_smtp_password: _smtp,
        has_gemini_api_key: _gemini,
        restart_required: _restart,
        ...values
      } = form;
      await api("/admin/system/settings", {
        method: "PATCH",
        body: JSON.stringify({
          ...values,
          ...(smtpPassword ? { SMTP_PASSWORD: smtpPassword } : {}),
          ...(geminiKey ? { GEMINI_API_KEY: geminiKey } : {}),
        }),
      });
      setSmtpPassword("");
      setGeminiKey("");
      await onSaved();
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} className={styles.settingsForm}>
      <fieldset disabled={disabled || busy}>
        <legend>Почта и восстановление пароля</legend>
        <div className="form-grid">
          <label>
            SMTP-сервер
            <input
              className="field"
              value={form.SMTP_HOST}
              onChange={(e) => change("SMTP_HOST", e.target.value)}
              placeholder="smtp.gmail.com"
              autoComplete="off"
            />
          </label>
          <label>
            Порт
            <input
              className="field"
              type="number"
              required
              min={1}
              max={65535}
              value={form.SMTP_PORT}
              onChange={(e) => change("SMTP_PORT", Number(e.target.value))}
            />
          </label>
          <label>
            Аккаунт отправителя
            <input
              className="field"
              value={form.SMTP_USERNAME}
              onChange={(e) => change("SMTP_USERNAME", e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Адрес отправителя
            <input
              className="field"
              type="email"
              value={form.SMTP_FROM}
              onChange={(e) => change("SMTP_FROM", e.target.value)}
              placeholder="QStudy использует этот адрес для писем"
            />
          </label>
          <label>
            Защита соединения
            <select
              className="field"
              value={form.SMTP_SECURITY}
              onChange={(e) => change("SMTP_SECURITY", e.target.value)}
            >
              <option value="starttls">STARTTLS</option>
              <option value="ssl">SSL / TLS</option>
            </select>
          </label>
          <label>
            Восстановление пароля
            <select
              className="field"
              value={form.RECOVERY_DELIVERY}
              onChange={(e) => change("RECOVERY_DELIVERY", e.target.value)}
            >
              <option value="auto">Автоматически</option>
              <option value="smtp">Отправлять по почте</option>
              <option value="local">Локальное восстановление</option>
              <option value="disabled">Отключено</option>
            </select>
          </label>
          <label className={styles.fullField}>
            Пароль приложения почты
            <PasswordInput
              value={smtpPassword}
              onChange={(e) => setSmtpPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={
                initial.has_smtp_password
                  ? "Пароль сохранён; пустое поле оставит его прежним"
                  : "Введите пароль приложения почты"
              }
            />
            <small>
              Для Gmail используйте пароль приложения. Сохранённый пароль не
              передаётся в браузер.
            </small>
          </label>
        </div>
      </fieldset>
      <fieldset disabled={disabled || busy}>
        <legend>Искусственный интеллект</legend>
        <div className="form-grid">
          <label className={styles.fullField}>
            API-ключ Gemini
            <PasswordInput
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              autoComplete="new-password"
              placeholder={
                initial.has_gemini_api_key
                  ? "Ключ сохранён; пустое поле оставит его прежним"
                  : "Введите API-ключ Gemini"
              }
            />
          </label>
          <label>
            Модель ИИ
            <input
              className="field"
              required
              value={form.GEMINI_MODEL}
              onChange={(e) => change("GEMINI_MODEL", e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Модель поиска в интернете
            <input
              className="field"
              value={form.GEMINI_WEB_MODEL}
              onChange={(e) => change("GEMINI_WEB_MODEL", e.target.value)}
              placeholder="Как основная модель"
              autoComplete="off"
            />
          </label>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={form.WEB_RESEARCH_ENABLED}
              onChange={(e) => change("WEB_RESEARCH_ENABLED", e.target.checked)}
            />
            Разрешить поиск актуальных источников
          </label>
        </div>
      </fieldset>
      <fieldset disabled={disabled || busy}>
        <legend>Доступ и резервные копии</legend>
        <div className="form-grid">
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={form.REGISTRATION_ENABLED}
              onChange={(e) => change("REGISTRATION_ENABLED", e.target.checked)}
            />
            Открыть регистрацию студентов
          </label>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={form.BACKUPS_ENABLED}
              onChange={(e) => change("BACKUPS_ENABLED", e.target.checked)}
            />
            Создавать резервные копии автоматически
          </label>
          <label>
            Интервал копирования, часов
            <input
              className="field"
              type="number"
              required
              min={1}
              max={168}
              value={form.BACKUP_INTERVAL_HOURS}
              onChange={(e) =>
                change("BACKUP_INTERVAL_HOURS", Number(e.target.value))
              }
            />
          </label>
          <label>
            Количество сохраняемых копий
            <input
              className="field"
              type="number"
              required
              min={2}
              max={90}
              value={form.BACKUP_RETENTION_COUNT}
              onChange={(e) =>
                change("BACKUP_RETENTION_COUNT", Number(e.target.value))
              }
            />
          </label>
        </div>
      </fieldset>
      <ErrorNotice message={error} />
      {saved && (
        <p className="alert alert-success" role="status">
          Настройки сохранены. Перезапустите сайт кнопкой выше, чтобы применить
          их.
        </p>
      )}
      <div className={styles.actions}>
        <button
          className="btn btn-primary"
          disabled={disabled || busy}
          type="submit"
        >
          {busy ? (
            <LoaderCircle size={16} className={styles.spin} />
          ) : (
            <Check size={16} />
          )}
          Сохранить настройки
        </button>
        <span className={styles.caption}>
          Пустые поля пароля и API-ключа сохраняют прежние значения.
        </span>
      </div>
    </form>
  );
}
