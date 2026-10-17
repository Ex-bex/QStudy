"use client";

import { useState } from "react";
import {
  GraduationCap,
  KeyRound,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Empty,
  Loading,
  RecordEditor,
  DeleteButton,
  type FieldDefinition,
} from "@/components/academic";
import type { Account, Group } from "@/types/academic";
import styles from "./control.module.css";

type Stats = {
  users: number;
  students: number;
  admins: number;
  active_users: number;
};

export default function ControlAccounts() {
  const { user, refreshUser } = useAuth();
  const admin = user.role === "admin";
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const {
    data: users,
    loading,
    error,
    reload,
  } = useResource<Account[]>(admin ? "/admin/users" : null);
  const {
    data: groups,
    loading: groupsLoading,
    error: groupsError,
    reload: reloadGroups,
  } = useResource<Group[]>(admin ? "/groups" : null);
  const { data: stats, reload: reloadStats } = useResource<Stats>(
    admin ? "/admin/stats" : null,
  );
  const groupField: FieldDefinition = {
    name: "group_id",
    label: "Учебная группа",
    type: "select",
    nullable: true,
    options: [
      { value: "", label: "Без группы" },
      ...(groups || []).map((group) => ({
        value: group.id,
        label: group.name,
      })),
    ],
    hint: "Группа определяет расписание, силабусы, модули и рекомендации QCareer. Выбор «Без группы» снимает назначение учебной группы.",
  };
  const fields: FieldDefinition[] = [
    { name: "name", label: "Имя", required: true },
    { name: "email", label: "Email", type: "email", required: true },
    {
      name: "role",
      label: "Роль",
      type: "select",
      options: [
        { value: "student", label: "Студент" },
        { value: "admin", label: "Администратор" },
      ],
    },
    groupField,
    { name: "is_active", label: "Аккаунт активен", type: "checkbox" },
  ];
  async function refresh() {
    await Promise.all([reload(), reloadStats()]);
    window.dispatchEvent(new Event("qstudy:account-updated"));
    try {
      localStorage.setItem("qstudy:account-updated", String(Date.now()));
    } catch {}
  }
  async function refreshAccount(account: Account) {
    await refresh();
    if (account.id === user.id) await refreshUser();
  }
  function groupName(account: Account) {
    if (account.group_id === null) return "Без группы";
    return (
      groups?.find((group) => group.id === account.group_id)?.name ||
      (groupsLoading ? "Загружаем группу…" : `Группа №${account.group_id}`)
    );
  }
  const filtered = users?.filter((account) =>
    `${account.name} ${account.email} ${groupName(account)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  if (!admin)
    return (
      <Empty title="Управление доступно администратору">
        Аккаунты Q-ID объединяют все проекты экосистемы.
      </Empty>
    );
  return (
    <div>
      <PageTitle
        eyebrow="Q-ID / ОБЩИЕ АККАУНТЫ"
        title="Люди и доступ"
        description="Один аккаунт для обучения, карьеры и игры. Управляйте ролями, учебными группами и доступом к экосистеме."
      >
        <RecordEditor
          title="Создать аккаунт Q-ID"
          fields={[
            ...fields,
            {
              name: "password",
              label: "Пароль",
              type: "password",
              required: true,
              hint: "От 10 символов, минимум одна буква и одна цифра.",
            },
          ]}
          initial={{ role: "student", is_active: true }}
          endpoint="/admin/users"
          onSaved={refresh}
          disabled={groupsLoading || Boolean(groupsError)}
        />
      </PageTitle>
      <div className={styles.stats}>
        {[
          {
            label: "Всего аккаунтов",
            value: stats?.users,
            icon: Users,
            note: "Общая база Q-ID",
          },
          {
            label: "Студенты",
            value: stats?.students,
            icon: GraduationCap,
            note: "Обучение и личные данные",
          },
          {
            label: "Администраторы",
            value: stats?.admins,
            icon: ShieldCheck,
            note: "Полный доступ к QControl",
          },
          {
            label: "Активные аккаунты",
            value: stats?.active_users,
            icon: KeyRound,
            note: "Доступ к входу разрешён",
          },
        ].map((item) => (
          <div className={styles.stat} key={item.label}>
            <div className={styles.statTop}>
              <span>{item.label}</span>
              <item.icon size={17} />
            </div>
            <strong>{item.value?.toLocaleString("ru-RU") ?? "—"}</strong>
            <small>{item.note}</small>
          </div>
        ))}
      </div>
      {notice && (
        <p role="status" className={styles.accountNotice}>
          {notice}
        </p>
      )}
      <ErrorNotice message={error} />
      {groupsError && (
        <div className={styles.accountNotice}>
          <ErrorNotice
            message={`Не удалось загрузить группы: ${groupsError}`}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void reloadGroups()}
          >
            Повторить загрузку групп
          </button>
        </div>
      )}
      <div className={styles.accountHeading}>
        <h2>Все аккаунты</h2>
        <label className={styles.accountSearch}>
          <Search size={15} />
          <input
            className="field"
            aria-label="Найти аккаунт по имени, email или группе"
            placeholder="Имя, email или группа"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <p className="muted" style={{ marginBottom: 15, fontSize: 11 }}>
        Назначьте учебную группу, чтобы студенту были доступны её расписание,
        силабусы, модули и рекомендации.
      </p>
      {loading ? (
        <Loading />
      ) : (
        <div className={`panel table-wrap ${styles.table}`}>
          <table className="academic-table">
            <thead>
              <tr>
                <th>Пользователь Q-ID</th>
                <th>Роль и учебная группа</th>
                <th>Доступ</th>
                <th>Управление аккаунтом</th>
              </tr>
            </thead>
            <tbody>
              {filtered?.map((account) => (
                <tr key={account.id}>
                  <td>
                    <strong>{account.name || "Без имени"}</strong>
                    {account.id === user.id && (
                      <span className="badge" style={{ marginLeft: 7 }}>
                        Вы
                      </span>
                    )}
                    <small>{account.email}</small>
                  </td>
                  <td>
                    <span
                      className={`${styles.roleBadge} ${account.role === "student" ? styles.studentRole : ""}`}
                    >
                      {account.role === "admin" ? (
                        <ShieldCheck size={12} />
                      ) : (
                        <GraduationCap size={12} />
                      )}
                      {account.role === "admin" ? "Администратор" : "Студент"}
                    </span>
                    <small>{groupName(account)}</small>
                  </td>
                  <td>
                    <span
                      className={`${styles.accountStatus} ${account.is_active ? "" : styles.blocked}`}
                    >
                      {account.is_active ? "Активен" : "Заблокирован"}
                    </span>
                  </td>
                  <td>
                    <div className="academic-actions">
                      <RecordEditor
                        title={`Учебная группа: ${account.name || account.email}`}
                        label="Изменить группу"
                        fields={[groupField]}
                        initial={{ group_id: account.group_id ?? "" }}
                        method="PATCH"
                        endpoint={`/admin/users/${account.id}`}
                        disabled={groupsLoading || Boolean(groupsError)}
                        onSaved={async () => {
                          await refreshAccount(account);
                          setNotice(
                            `Учебная группа аккаунта ${account.email} обновлена. Учебные разделы используют новое назначение.`,
                          );
                        }}
                      />
                      <RecordEditor
                        compact
                        title={`Редактировать ${account.name || account.email}`}
                        fields={fields}
                        initial={{
                          ...account,
                          group_id: account.group_id ?? "",
                        }}
                        method="PATCH"
                        endpoint={`/admin/users/${account.id}`}
                        disabled={groupsLoading || Boolean(groupsError)}
                        onSaved={() => refreshAccount(account)}
                      />
                      <RecordEditor
                        title={`Сменить пароль: ${account.email}`}
                        compact
                        fields={[
                          {
                            name: "password",
                            label: "Новый пароль Q-ID",
                            type: "password",
                            required: true,
                            hint: "От 10 символов, минимум одна буква и одна цифра. Текущие сеансы аккаунта будут завершены во всех проектах.",
                          },
                        ]}
                        method="POST"
                        endpoint={`/admin/users/${account.id}/password`}
                        onSaved={refresh}
                      />
                      <DeleteButton
                        title={`Удалить аккаунт ${account.email}?`}
                        description="Аккаунт Q-ID и его личные данные будут удалены из общей экосистемы. Это действие нельзя отменить."
                        endpoint={`/admin/users/${account.id}`}
                        onDeleted={refresh}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered?.length && !error && (
            <Empty title="Аккаунты не найдены">
              Измените поисковый запрос или создайте новый аккаунт.
            </Empty>
          )}
          <div className={styles.countLabel}>
            Показано {filtered?.length || 0} из {users?.length || 0} аккаунтов
          </div>
        </div>
      )}
      <p className={styles.passwordNote}>
        <KeyRound size={13} /> Изменение пароля завершает действующие сеансы
        пользователя во всех проектах экосистемы.
      </p>
    </div>
  );
}
