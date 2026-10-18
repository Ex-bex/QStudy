"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect } from "react";
import {
  ArrowUpRight,
  ExternalLink,
  Mail,
  MessageCircle,
  RefreshCw,
  UsersRound,
} from "lucide-react";
import {
  DeleteButton,
  Empty,
  ErrorNotice,
  Loading,
  RecordEditor,
  useResource,
  type FieldDefinition,
} from "@/components/academic";
import { useAuth } from "@/lib/auth";
import { departmentLogoUrl, safeDirectorPhotoUrl } from "@/lib/branding";
import DirectorPhotoUpload from "@/components/director-photo-upload";
import {
  useBranding,
  notifyBrandingChanged,
} from "@/components/branding-provider";
import { LogoUpload } from "@/components/logo-upload";
import type {
  DeveloperDepartment,
  DeveloperDirectory,
} from "@/types/developers";

function websiteLink(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function DepartmentContacts({
  department,
}: {
  department: DeveloperDepartment;
}) {
  const email =
    department.email &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(department.email)
      ? department.email
      : "";
  const telegram = /^https:\/\/t\.me\/[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(
    department.telegram,
  )
    ? department.telegram
    : "";
  const website = websiteLink(department.website);
  if (!email && !telegram && !website)
    return <p className="dev-contact-pending">Контакты скоро появятся</p>;
  return (
    <div className="dev-contacts">
      {email && (
        <a
          href={`mailto:${encodeURIComponent(email)}`}
          className="dev-contact-link"
        >
          <Mail size={17} aria-hidden="true" />
          <span>{email}</span>
          <ArrowUpRight size={15} aria-hidden="true" />
        </a>
      )}
      {telegram && (
        <a
          href={telegram}
          target="_blank"
          rel="noopener noreferrer"
          className="dev-contact-link"
        >
          <MessageCircle size={17} aria-hidden="true" />
          <span>Telegram · @{telegram.split("/").pop()}</span>
          <ArrowUpRight size={15} aria-hidden="true" />
        </a>
      )}
      {website && (
        <a
          href={website}
          target="_blank"
          rel="noopener noreferrer"
          className="dev-contact-link"
        >
          <ExternalLink size={17} aria-hidden="true" />
          <span>{new URL(website).hostname}</span>
          <ArrowUpRight size={15} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

export function PublicDeveloperDirectory() {
  const { branding } = useBranding();
  const { data, loading, error, reload } =
    useResource<DeveloperDirectory>("/developers");
  useEffect(() => {
    const refresh = () => {
      void reload();
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === "qstudy:branding-updated") refresh();
    };
    window.addEventListener("qstudy:branding-updated", refresh);
    window.addEventListener("storage", storageChanged);
    return () => {
      window.removeEventListener("qstudy:branding-updated", refresh);
      window.removeEventListener("storage", storageChanged);
    };
  }, [reload]);
  if (loading)
    return (
      <div className="dev-directory-state" role="status">
        Загружаем команду QForce…
      </div>
    );
  if (error)
    return (
      <div className="dev-directory-state" role="alert">
        <p>Не удалось загрузить информацию о команде.</p>
        <button type="button" className="btn btn-secondary" onClick={reload}>
          <RefreshCw size={16} /> Попробовать снова
        </button>
      </div>
    );
  if (!data?.departments.length)
    return (
      <div className="dev-directory-state">
        <UsersRound size={25} aria-hidden="true" />
        <p>Информация о подразделениях скоро появится.</p>
      </div>
    );
  return (
    <div className="dev-directory-grid">
      {data.departments
        .slice()
        .sort((a, b) => a.display_order - b.display_order || a.id - b.id)
        .map((department) => (
          <article className="dev-department" key={department.id}>
            <div className="dev-department-visual">
              <Image
                src={departmentLogoUrl(department, branding.project_logo_url)}
                alt=""
                fill
                unoptimized
                sizes="(max-width: 700px) 80vw, 340px"
                style={{ objectFit: "contain" }}
              />
            </div>
            <div className="dev-department-copy">
              <h3>{department.name}</h3>
              {(department.director || safeDirectorPhotoUrl(department)) && (
                <div className="dev-director">
                  {safeDirectorPhotoUrl(department) && (
                    <Image
                      src={safeDirectorPhotoUrl(department)!}
                      alt={department.director || "Фото руководителя"}
                      width={64}
                      height={72}
                      unoptimized
                      style={{
                        objectFit: "cover",
                        borderRadius: 14,
                        marginBottom: 8,
                      }}
                    />
                  )}
                  <span>Директор</span>
                  <strong>
                    {department.director || "Имя пока не указано"}
                  </strong>
                </div>
              )}
              {department.description && (
                <p className="dev-department-description">
                  {department.description}
                </p>
              )}
              <DepartmentContacts department={department} />
            </div>
          </article>
        ))}
    </div>
  );
}

const departmentFields: FieldDefinition[] = [
  {
    name: "name",
    label: "Название подразделения",
    required: true,
    hint: "До 120 символов. Отображается на публичной странице.",
  },
  {
    name: "director",
    label: "Директор",
    hint: "До 200 символов. Можно оставить пустым.",
  },
  {
    name: "description",
    label: "Описание",
    type: "textarea",
    hint: "До 4 000 символов. Расскажите, за что отвечает подразделение.",
  },
  {
    name: "email",
    label: "Публичный email",
    type: "email",
    placeholder: "team@example.com",
  },
  {
    name: "telegram",
    label: "Публичный Telegram",
    placeholder: "@username или https://t.me/username",
    hint: "Имя Telegram от 5 до 32 символов, начинается с буквы.",
  },
  {
    name: "website",
    label: "Сайт подразделения",
    placeholder: "https://example.com",
    hint: "Публичная ссылка HTTP или HTTPS.",
  },
  {
    name: "logo",
    label: "Стандартный логотип",
    type: "select",
    hint: "Используется, если собственный PNG не загружен или сброшен.",
    options: [
      { value: "main", label: "QForce" },
      { value: "coding", label: "Coding Department" },
      { value: "tech", label: "Technology Department" },
      { value: "press", label: "Presentation Department" },
      { value: "business", label: "Business Department" },
    ],
  },
  {
    name: "display_order",
    label: "Порядок отображения",
    type: "number",
    min: 0,
    max: 10000,
    required: true,
    hint: "Подразделения с меньшим числом показываются первыми.",
  },
];

export function DeveloperDirectoryAdmin() {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const { branding } = useBranding();
  const { data, loading, error, reload, setData } =
    useResource<DeveloperDirectory>(admin ? "/developers" : null);
  if (!admin) return null;
  const departments = data?.departments || [];
  return (
    <section className="academic-section">
      <div className="academic-section-heading">
        <div>
          <h2>Команда QForce</h2>
          <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>
            Названия, руководители и контакты видны всем посетителям сайта.
          </p>
        </div>
        <RecordEditor
          title="Добавить подразделение"
          fields={departmentFields}
          initial={{
            logo: "main",
            display_order: departments.length
              ? Math.min(
                  10000,
                  Math.max(
                    ...departments.map(
                      (department) => department.display_order,
                    ),
                  ) + 10,
                )
              : 0,
          }}
          endpoint="/developers/departments"
          onSaved={reload}
        />
      </div>
      <div className="academic-meta" style={{ marginBottom: 18 }}>
        <Link
          className="btn btn-secondary"
          href="/developers"
          target="_blank"
          rel="noopener noreferrer"
        >
          Открыть публичную страницу <ArrowUpRight size={15} />
        </Link>
        <span>
          Оставьте контакт пустым, чтобы убрать соответствующую ссылку.
        </span>
      </div>
      <ErrorNotice message={error} />
      {loading ? (
        <Loading />
      ) : departments.length ? (
        <div className="academic-grid two">
          {departments
            .slice()
            .sort((a, b) => a.display_order - b.display_order || a.id - b.id)
            .map((department) => (
              <article className="panel academic-card" key={department.id}>
                <div className="academic-card-top">
                  <div style={{ minWidth: 0 }}>
                    <h3>{department.name}</h3>
                    <p className="muted" style={{ marginTop: 7, fontSize: 12 }}>
                      {department.director || "Директор не указан"}
                    </p>
                  </div>
                  <div className="academic-actions">
                    <RecordEditor
                      compact
                      title={`Редактировать ${department.name}`}
                      fields={departmentFields}
                      initial={{
                        name: department.name,
                        director: department.director,
                        description: department.description,
                        email: department.email,
                        telegram: department.telegram,
                        website: department.website,
                        logo: department.logo,
                        display_order: department.display_order,
                      }}
                      endpoint={`/developers/departments/${department.id}`}
                      method="PATCH"
                      onSaved={reload}
                    />
                    <DeleteButton
                      title={`Удалить ${department.name}?`}
                      description="Подразделение и его контакты будут удалены с публичной страницы."
                      endpoint={`/developers/departments/${department.id}`}
                      onDeleted={reload}
                    />
                  </div>
                </div>
                <div className="academic-meta">
                  <span>Порядок: {department.display_order}</span>
                  <span>
                    {[
                      department.email,
                      department.telegram,
                      department.website,
                    ].filter(Boolean).length
                      ? "Контакты опубликованы"
                      : "Контакты не добавлены"}
                  </span>
                </div>
                <div className="branding-department-upload">
                  <LogoUpload<DeveloperDepartment>
                    title={`Логотип ${department.name}`}
                    currentUrl={departmentLogoUrl(
                      department,
                      branding.project_logo_url,
                    )}
                    custom={department.logo_custom}
                    endpoint={`/branding/departments/${department.id}/logo`}
                    onSaved={(updated) => {
                      setData((directory) =>
                        directory
                          ? {
                              departments: directory.departments.map((item) =>
                                item.id === updated.id ? updated : item,
                              ),
                            }
                          : directory,
                      );
                      notifyBrandingChanged();
                    }}
                  />
                  <DirectorPhotoUpload
                    department={department}
                    onSaved={(updated) => {
                      setData((directory) =>
                        directory
                          ? {
                              departments: directory.departments.map((item) =>
                                item.id === updated.id ? updated : item,
                              ),
                            }
                          : directory,
                      );
                      notifyBrandingChanged();
                    }}
                  />
                </div>
              </article>
            ))}
        </div>
      ) : (
        <Empty title="Подразделений пока нет">
          Добавьте подразделение, руководителя и официальные контакты команды.
        </Empty>
      )}
    </section>
  );
}
