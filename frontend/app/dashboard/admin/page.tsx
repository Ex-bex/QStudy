"use client";

import { useState } from "react";
import Link from "next/link";
import {
  KeyRound,
  ShieldCheck,
  Users,
  BookOpen,
  GraduationCap,
  Gamepad2,
  ArrowUpRight,
  Compass,
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
import OperationsPanel from "./OperationsPanel";
import SystemPanel from "./SystemPanel";
import { DeveloperDirectoryAdmin } from "@/components/developer-directory";
import { BrandingAdmin } from "@/components/branding-admin";

type Stats = {
  users: number;
  students: number;
  admins: number;
  active_users: number;
  groups: number;
  courses: number;
  submissions: number;
};
export default function AdminPage() {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const [query, setQuery] = useState("");
  const {
    data: users,
    loading,
    error,
    reload,
  } = useResource<Account[]>(admin ? "/admin/users" : null);
  const { data: groups } = useResource<Group[]>(admin ? "/groups" : null);
  const { data: stats, reload: reloadStats } = useResource<Stats>(
    admin ? "/admin/stats" : null,
  );
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
    {
      name: "group_id",
      label: "Группа",
      type: "select",
      nullable: true,
      options: [
        { value: "", label: "Без группы" },
        ...(groups || []).map((group) => ({
          value: group.id,
          label: group.name,
        })),
      ],
    },
    { name: "is_active", label: "Аккаунт активен", type: "checkbox" },
  ];
  async function refresh() {
    await Promise.all([reload(), reloadStats()]);
  }
  if (!user) return <Loading />;
  if (!admin)
    return (
      <Empty title="Доступ только для администратора">
        Управление аккаунтами и глобальными настройками доступно администратору
        QStudy.
      </Empty>
    );
  return (
    <div>
      <PageTitle
        eyebrow="АДМИНИСТРИРОВАНИЕ"
        title="Центр управления"
        description="Аккаунты, перенос проекта, настройки сайта и история изменений."
      >
        <RecordEditor
          title="Создать аккаунт"
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
        />
      </PageTitle>
      <div className="academic-stats">
        {[
          { label: "Аккаунты", value: stats?.users, icon: Users },
          { label: "Студенты", value: stats?.students, icon: GraduationCap },
          { label: "Администраторы", value: stats?.admins, icon: ShieldCheck },
          { label: "Дисциплины", value: stats?.courses, icon: BookOpen },
        ].map((item) => (
          <div className="panel academic-stat" key={item.label}>
            <div className="academic-card-top">
              <p>{item.label}</p>
              <item.icon size={16} color="#85907f" />
            </div>
            <strong>{item.value ?? "—"}</strong>
          </div>
        ))}
      </div>
      <SystemPanel />
      <section
        className="panel"
        style={{
          padding: 24,
          marginBottom: 24,
          background: "#faf7ff",
          borderColor: "#e7dcf3",
        }}
      >
        <div className="academic-section-heading" style={{ marginBottom: 0 }}>
          <div>
            <h2 style={{ color: "#76529b" }}>
              <Gamepad2
                size={20}
                style={{
                  display: "inline",
                  marginRight: 8,
                  verticalAlign: "-3px",
                }}
              />
              QBall
            </h2>
            <p className="muted" style={{ marginTop: 7 }}>
              Игровая площадка, логотип, комнаты, участники и история матчей.
            </p>
          </div>
          <Link href="/dashboard/admin/qball" className="btn btn-secondary">
            Управлять QBall <ArrowUpRight size={16} />
          </Link>
        </div>
      </section>
      <OperationsPanel />
      <section
        className="panel"
        style={{
          padding: 24,
          marginBottom: 24,
          background: "#fff7ed",
          borderColor: "#fed7aa",
        }}
      >
        <div className="academic-section-heading" style={{ marginBottom: 0 }}>
          <div>
            <h2 style={{ color: "#a84d17" }}>
              <Compass
                size={20}
                style={{
                  display: "inline",
                  marginRight: 8,
                  verticalAlign: "-3px",
                }}
              />
              QCareer
            </h2>
            <p className="muted" style={{ marginTop: 7 }}>
              Навыки из обучения, карьерные направления, практика и дальнейшее
              образование.
            </p>
          </div>
          <Link href="/dashboard/admin/career" className="btn btn-secondary">
            Управлять QCareer <ArrowUpRight size={16} />
          </Link>
        </div>
      </section>
      <BrandingAdmin />
      <DeveloperDirectoryAdmin />
      <div className="academic-section-heading">
        <h2>Аккаунты</h2>
        <input
          className="field"
          style={{ maxWidth: 300 }}
          aria-label="Найти аккаунт"
          placeholder="Поиск по имени или email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <ErrorNotice message={error} />
      {loading ? (
        <Loading />
      ) : (
        <div className="panel table-wrap">
          <table className="academic-table">
            <thead>
              <tr>
                <th>Пользователь</th>
                <th>Роль / группа</th>
                <th>Статус</th>
                <th>Управление</th>
              </tr>
            </thead>
            <tbody>
              {users
                ?.filter((account) =>
                  `${account.name} ${account.email}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((account) => (
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
                      {account.role === "admin" ? "Администратор" : "Студент"}
                      <small>
                        {groups?.find((group) => group.id === account.group_id)
                          ?.name || "Без группы"}
                      </small>
                    </td>
                    <td>
                      <span
                        className={`academic-dot ${account.is_active ? "" : "academic-muted-dot"}`}
                      />
                      {account.is_active ? "Активен" : "Заблокирован"}
                    </td>
                    <td>
                      <div className="academic-actions">
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
                          onSaved={refresh}
                        />
                        <span title="Сбросить пароль">
                          <RecordEditor
                            title="Сменить пароль"
                            compact
                            fields={[
                              {
                                name: "password",
                                label: `Новый пароль для ${account.email}`,
                                type: "password",
                                required: true,
                                hint: "От 10 символов, минимум одна буква и одна цифра. Все текущие сессии аккаунта будут завершены.",
                              },
                            ]}
                            method="POST"
                            endpoint={`/admin/users/${account.id}/password`}
                            onSaved={refresh}
                          />
                        </span>
                        <DeleteButton
                          title={`Удалить аккаунт ${account.email}?`}
                          description="Аккаунт и его личные данные будут удалены. Это действие нельзя отменить."
                          endpoint={`/admin/users/${account.id}`}
                          onDeleted={refresh}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {!users?.filter((account) =>
            `${account.name} ${account.email}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          ).length && (
            <Empty title="Аккаунты не найдены">
              Измените поисковый запрос.
            </Empty>
          )}
        </div>
      )}
      <p
        className="muted"
        style={{
          fontSize: 12,
          marginTop: 20,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <KeyRound size={14} /> Изменение пароля завершает действующие сессии
        пользователя.
      </p>
    </div>
  );
}
