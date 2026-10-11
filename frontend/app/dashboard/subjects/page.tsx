"use client";
import { useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Subject, Topic } from "@/types";
import {
  PageTitle,
  ErrorNotice,
  Loading,
  Empty,
  RecordEditor,
  DeleteButton,
  useResource,
  type FieldDefinition,
} from "@/components/academic";

const subjectFields: FieldDefinition[] = [
  { name: "name", label: "Название", required: true },
  { name: "description", label: "Описание", type: "textarea" },
  { name: "color", label: "Цвет в формате #246b50", required: true },
];
const topicFields: FieldDefinition[] = [
  { name: "title", label: "Название", required: true },
  { name: "description", label: "Описание", type: "textarea" },
];
export default function SubjectsPage() {
  const { user } = useAuth();
  const admin = user.role === "admin";
  const {
    data: subjects,
    loading,
    error,
    reload,
  } = useResource<Subject[]>("/subjects");
  const [openId, setOpenId] = useState<number | null>(null);
  const [topics, setTopics] = useState<Record<number, Topic[]>>({});
  const [actionError, setActionError] = useState("");
  const [loadingTopics, setLoadingTopics] = useState(false);
  async function loadTopics(id: number) {
    try {
      const rows = await api<Topic[]>(`/subjects/${id}/topics`);
      setTopics((prev) => ({ ...prev, [id]: rows }));
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "Не удалось открыть темы",
      );
    }
  }
  async function openSubject(id: number) {
    setOpenId(openId === id ? null : id);
    setLoadingTopics(true);
    await loadTopics(id);
    setLoadingTopics(false);
  }
  return (
    <div>
      <PageTitle
        eyebrow="БАЗА ЗНАНИЙ"
        title="Предметы"
        description="Общие предметы и темы. Личные конспекты, файлы и подготовка остаются в вашем пространстве."
      >
        {admin && (
          <RecordEditor
            title="Новый предмет"
            label="Добавить предмет"
            endpoint="/subjects"
            initial={{ color: "#246b50" }}
            fields={subjectFields}
            onSaved={reload}
          />
        )}
      </PageTitle>
      <ErrorNotice message={error || actionError} />
      {loading ? (
        <Loading />
      ) : !subjects?.length ? (
        <Empty title="Пока нет предметов">
          {admin
            ? "Создайте предмет и добавьте темы для работы с материалами и ИИ."
            : "Администратор добавит здесь предметы и темы. Учебный план группы доступен в разделе «Группы»."}
        </Empty>
      ) : (
        <div className="space-y-4">
          {subjects.map((s) => (
            <section className="panel" key={s.id} style={{ padding: 0 }}>
              <div
                style={{
                  display: "flex",
                  gap: 15,
                  alignItems: "center",
                  padding: 22,
                }}
              >
                <button
                  onClick={() => openSubject(s.id)}
                  style={{
                    display: "flex",
                    flex: 1,
                    minWidth: 0,
                    textAlign: "left",
                    alignItems: "center",
                    gap: 14,
                  }}
                  aria-expanded={openId === s.id}
                >
                  <span
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 10,
                      background: s.color + "18",
                      color: s.color,
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                    }}
                  >
                    <BookOpen size={19} />
                  </span>
                  <div>
                    <h2 style={{ fontSize: 17, fontWeight: 550 }}>{s.name}</h2>
                    {s.description && (
                      <p
                        className="muted"
                        style={{ fontSize: 12, marginTop: 5 }}
                      >
                        {s.description}
                      </p>
                    )}
                  </div>
                  {openId === s.id ? (
                    <ChevronDown size={16} style={{ marginLeft: "auto" }} />
                  ) : (
                    <ChevronRight size={16} style={{ marginLeft: "auto" }} />
                  )}
                </button>
                {admin && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <RecordEditor
                      compact
                      title={`Изменить ${s.name}`}
                      endpoint={`/subjects/${s.id}`}
                      method="PATCH"
                      initial={{
                        name: s.name,
                        description: s.description,
                        color: s.color,
                      }}
                      fields={subjectFields}
                      onSaved={reload}
                    />
                    <DeleteButton
                      endpoint={`/subjects/${s.id}`}
                      title={`Удалить ${s.name}`}
                      description="Темы и созданные лекции будут удалены. Личные заметки и файлы сохранятся без привязки к предмету."
                      onDeleted={reload}
                    />
                  </div>
                )}
              </div>
              {openId === s.id && (
                <div
                  style={{ borderTop: "1px solid var(--line)", padding: 22 }}
                >
                  <div className="section-head">
                    <h2>Темы предмета</h2>
                    {admin && (
                      <RecordEditor
                        title="Новая тема"
                        label="Добавить тему"
                        endpoint={`/subjects/${s.id}/topics`}
                        fields={topicFields}
                        onSaved={() => loadTopics(s.id)}
                      />
                    )}
                  </div>
                  {loadingTopics ? (
                    <Loading />
                  ) : (
                    (topics[s.id] || []).map((t) => (
                      <div
                        key={t.id}
                        style={{
                          display: "flex",
                          gap: 12,
                          alignItems: "center",
                          padding: "13px 0",
                          borderBottom: "1px solid var(--line)",
                        }}
                      >
                        <Link
                          style={{ flex: 1, minWidth: 0 }}
                          href={`/dashboard/lectures/${s.id}/${t.id}`}
                        >
                          <strong style={{ fontSize: 13, fontWeight: 550 }}>
                            {t.title}
                          </strong>
                          {t.description && (
                            <p
                              className="muted"
                              style={{ fontSize: 11, marginTop: 4 }}
                            >
                              {t.description}
                            </p>
                          )}
                        </Link>
                        <Link
                          aria-label={`Открыть лекцию ${t.title}`}
                          href={`/dashboard/lectures/${s.id}/${t.id}`}
                        >
                          <ArrowUpRight size={16} />
                        </Link>
                        {admin && (
                          <>
                            <RecordEditor
                              compact
                              title={`Изменить ${t.title}`}
                              endpoint={`/subjects/${s.id}/topics/${t.id}`}
                              method="PATCH"
                              initial={{
                                title: t.title,
                                description: t.description,
                              }}
                              fields={topicFields}
                              onSaved={() => loadTopics(s.id)}
                            />
                            <DeleteButton
                              endpoint={`/subjects/${s.id}/topics/${t.id}`}
                              title={`Удалить ${t.title}`}
                              onDeleted={() => loadTopics(s.id)}
                            />
                          </>
                        )}
                      </div>
                    ))
                  )}
                  {!loadingTopics && topics[s.id]?.length === 0 && (
                    <p
                      className="muted"
                      style={{ fontSize: 12, padding: "15px 0" }}
                    >
                      Тем пока нет.
                    </p>
                  )}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
