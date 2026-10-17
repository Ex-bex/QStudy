"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import IdentityShell from "./identity-shell";
import styles from "./identity.module.css";
import PasswordInput from "./password-input";
import { api, setToken } from "@/lib/api";
import { authReturnPath } from "@/lib/auth-return";

type RegistrationGroup = { id: number; name: string };

export default function AuthForm({ register = false }: { register?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [returnTo, setReturnTo] = useState("/dashboard");
  const [groups, setGroups] = useState<RegistrationGroup[]>([]);
  const [groupId, setGroupId] = useState("");
  const [groupsLoading, setGroupsLoading] = useState(register);
  const [groupsError, setGroupsError] = useState("");
  const [groupsRevision, setGroupsRevision] = useState(0);
  useEffect(() => {
    setReturnTo(
      authReturnPath(new URLSearchParams(window.location.search).get("next")),
    );
  }, []);
  useEffect(() => {
    if (!register) return;
    let active = true;
    void api<RegistrationGroup[]>("/auth/registration-groups")
      .then((value) => {
        if (!active) return;
        setGroups(value);
        setGroupsError("");
      })
      .catch((cause) => {
        if (active)
          setGroupsError(
            cause instanceof Error
              ? cause.message
              : "Не удалось загрузить группы",
          );
      })
      .finally(() => {
        if (active) setGroupsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [register, groupsRevision]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (register && (groupsLoading || groupsError)) {
      setError("Дождитесь загрузки групп или повторите попытку.");
      return;
    }
    if (register && groups.length > 0 && !groupId) {
      setError("Выберите вашу учебную группу.");
      return;
    }
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
          ? JSON.stringify({
              name,
              email,
              password,
              group_id: groupId ? Number(groupId) : null,
            })
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
  const destination = returnTo.startsWith("/qcontrol")
    ? "QControl"
    : returnTo.startsWith("/qcareer")
      ? "QCareer"
      : returnTo.startsWith("/qball")
        ? "QBall"
        : "QStudy";
  return (
    <IdentityShell mode={register ? "register" : "login"}>
      <p className={styles.context}>
        После {register ? "регистрации" : "входа"} откроется{" "}
        <span className={styles.appLabel}>{destination}</span>.
      </p>
      <form onSubmit={submit} className={styles.form} aria-busy={loading}>
        {error && (
          <div className={styles.alert} role="alert">
            {error}
          </div>
        )}
        {register && (
          <div className={styles.label}>
            <label htmlFor="qid-name">Ваше имя</label>
            <input
              id="qid-name"
              name="name"
              className={styles.field}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Как к вам обращаться"
              maxLength={100}
              required
              disabled={loading}
            />
          </div>
        )}
        <div className={styles.label}>
          <label htmlFor="qid-email">Электронная почта</label>
          <input
            id="qid-email"
            name="email"
            className={styles.field}
            type="email"
            autoComplete={register ? "email" : "username"}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            maxLength={254}
            disabled={loading}
          />
        </div>
        <div className={styles.label}>
          <div className={styles.labelRow}>
            <label htmlFor="qid-password">Пароль</label>
            {!register && (
              <Link className={styles.textLink} href="/forgot-password">
                Забыли пароль?
              </Link>
            )}
          </div>
          <PasswordInput
            id="qid-password"
            name="password"
            className={styles.field}
            autoComplete={register ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={
              register ? "Придумайте надёжный пароль" : "Введите пароль"
            }
            minLength={register ? 10 : 1}
            maxLength={128}
            required
            disabled={loading}
            aria-describedby={register ? "qid-password-help" : undefined}
          />
          {register && (
            <small className={styles.help} id="qid-password-help">
              От 10 символов, с буквами и цифрами.
            </small>
          )}
        </div>
        {register && (
          <>
            <div className={styles.label}>
              <label htmlFor="qid-password-confirm">Повторите пароль</label>
              <PasswordInput
                id="qid-password-confirm"
                name="confirm_password"
                className={styles.field}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                minLength={10}
                maxLength={128}
                placeholder="Введите пароль ещё раз"
                required
                disabled={loading}
              />
            </div>
            <div className={styles.label}>
              <label htmlFor="qid-group">Учебная группа</label>
              <select
                id="qid-group"
                name="group_id"
                className={styles.field}
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                required={groups.length > 0}
                disabled={loading || groupsLoading || Boolean(groupsError)}
                aria-describedby="registration-group-help"
              >
                <option value="">
                  {groupsLoading ? "Загружаем группы…" : "Выберите вашу группу"}
                </option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
              <small className={styles.help} id="registration-group-help">
                {groupsLoading
                  ? "Получаем список учебных групп."
                  : groupsError
                    ? "Пока список недоступен, регистрация приостановлена."
                    : groups.length
                      ? "Группа определяет расписание, силабусы, модули и учебные рекомендации. Позже её сможет изменить администратор."
                      : "Группы пока не созданы. Можно зарегистрироваться без группы — администратор назначит её позже."}
              </small>
              {groupsError && (
                <div className={styles.alert} role="alert">
                  <p>{groupsError}</p>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={groupsLoading}
                    onClick={() => {
                      setGroupsLoading(true);
                      setGroupsError("");
                      setGroupsRevision((value) => value + 1);
                    }}
                  >
                    Повторить загрузку
                  </button>
                </div>
              )}
            </div>
          </>
        )}
        <button
          type="submit"
          className={styles.submit}
          disabled={
            loading || (register && (groupsLoading || Boolean(groupsError)))
          }
        >
          {loading ? (
            <>
              <Loader2 className="animate-spin" size={18} aria-hidden="true" />
              {register ? "Создаём аккаунт…" : "Входим…"}
            </>
          ) : (
            <>
              {register ? "Создать Q-ID" : "Войти с Q-ID"}
              <ArrowRight size={18} aria-hidden="true" />
            </>
          )}
        </button>
      </form>
      <p className={styles.switchRow}>
        {register ? "Уже есть Q-ID?" : "Ещё нет аккаунта?"}{" "}
        <Link
          className={styles.textLink}
          href={`${register ? "/login" : "/register"}${returnTo === "/dashboard" ? "" : `?next=${encodeURIComponent(returnTo)}`}`}
        >
          {register ? "Войти" : "Создать Q-ID"}
        </Link>
      </p>
      <p className={styles.security}>
        {register
          ? "Один аккаунт для QStudy, QCareer и QBall."
          : "Уже пользуетесь QStudy? Введите привычные почту и пароль."}
      </p>
    </IdentityShell>
  );
}
