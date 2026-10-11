"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  BookOpen,
  Search,
  Users,
  GraduationCap,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { filterGroups } from "@/lib/group-directory";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Empty,
  Loading,
  RecordEditor,
  DeleteButton,
  groupFields,
} from "@/components/academic";
import type { Group } from "@/types/academic";

export default function GroupsPage() {
  const { user } = useAuth();
  const {
    data: groups,
    loading,
    error,
    reload,
  } = useResource<Group[]>("/groups");
  const [query, setQuery] = useState("");
  const [studyYear, setStudyYear] = useState("all");
  const [limit, setLimit] = useState(12);
  const admin = user?.role === "admin";
  const filtered = filterGroups(groups || [], query, studyYear, user?.group_id);
  const years = [
    ...new Set(
      (groups || []).flatMap((group) =>
        group.study_year == null ? [] : [group.study_year],
      ),
    ),
  ].sort((a, b) => a - b);
  const hasFilter = Boolean(query.trim()) || studyYear !== "all";
  return (
    <div>
      <PageTitle
        eyebrow="УЧЕБНОЕ ПРОСТРАНСТВО"
        title="Группы"
        description="Расписание, дисциплины и учебная программа — всё начинается с группы."
      >
        {admin && (
          <RecordEditor
            title="Создать группу"
            fields={groupFields}
            endpoint="/groups"
            onSaved={reload}
          />
        )}
      </PageTitle>
      <ErrorNotice message={error} />
      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="academic-filter">
            <label
              className="academic-field"
              style={{ width: "min(100%, 380px)" }}
            >
              <span className="sr-only">Поиск группы</span>
              <div style={{ position: "relative" }}>
                <Search
                  size={16}
                  style={{
                    position: "absolute",
                    left: 14,
                    top: 15,
                    color: "#8c9689",
                  }}
                />
                <input
                  className="field"
                  style={{ width: "100%", paddingLeft: 39 }}
                  placeholder="Группа, программа или куратор"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setLimit(12);
                  }}
                />
              </div>
            </label>
            <label className="academic-field">
              <span className="sr-only">Курс обучения</span>
              <select
                className="field"
                value={studyYear}
                onChange={(e) => {
                  setStudyYear(e.target.value);
                  setLimit(12);
                }}
              >
                <option value="all">Все курсы обучения</option>
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year} курс
                  </option>
                ))}
                <option value="unknown">Курс не подтверждён</option>
              </select>
            </label>
            {hasFilter && (
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setQuery("");
                  setStudyYear("all");
                  setLimit(12);
                }}
              >
                Сбросить
              </button>
            )}
            <span className="muted" style={{ fontSize: 12 }} role="status">
              Показано {Math.min(limit, filtered.length)} из {filtered.length} ·
              Всего {groups?.length || 0}
            </span>
          </div>
          {filtered.length ? (
            <div className="academic-grid">
              {filtered.slice(0, limit).map((group) => (
                <article className="panel academic-card" key={group.id}>
                  <div className="academic-card-top">
                    <div className="academic-card-icon">
                      <Users size={22} />
                    </div>
                    <div className="academic-actions">
                      {group.id === user?.group_id && (
                        <span className="badge">Моя группа</span>
                      )}
                      {admin && (
                        <>
                          <RecordEditor
                            compact
                            title="Редактировать группу"
                            fields={groupFields}
                            initial={{ ...group }}
                            method="PUT"
                            endpoint={`/groups/${group.id}`}
                            onSaved={reload}
                          />
                          <DeleteButton
                            title={`Удалить ${group.name}?`}
                            description="Будут удалены группа, расписание, дисциплины и их учебные материалы. Студенты сохранят аккаунты."
                            endpoint={`/groups/${group.id}`}
                            onDeleted={reload}
                          />
                        </>
                      )}
                    </div>
                  </div>
                  <div>
                    <h2>
                      <Link href={`/dashboard/groups/${group.id}`}>
                        {group.name}
                      </Link>
                    </h2>
                    <p
                      className="muted academic-clamp-three"
                      style={{ fontSize: 13, marginTop: 7 }}
                    >
                      {group.program ||
                        group.description ||
                        "Общее пространство для учебы"}
                    </p>
                  </div>
                  <div className="academic-meta">
                    <span>
                      <Users size={14} />
                      {group.student_count} студентов
                    </span>
                    <span>
                      <BookOpen size={14} />
                      {group.course_count} дисциплин
                    </span>
                    {group.academic_year && (
                      <span>
                        <GraduationCap size={14} />
                        {group.academic_year}
                      </span>
                    )}
                    <span>
                      {group.study_year == null
                        ? "Курс не подтверждён"
                        : `${group.study_year} курс`}
                    </span>
                    {group.semester != null && (
                      <span>Семестр: {group.semester}</span>
                    )}
                  </div>
                  {!!group.warnings?.length && (
                    <details className="academic-source-details">
                      <summary>Уточнения источника</summary>
                      <ul>
                        {group.warnings.map((warning, i) => (
                          <li key={i}>{warning}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <Link
                    className="academic-card-link"
                    href={`/dashboard/groups/${group.id}`}
                  >
                    Открыть группу <ArrowUpRight size={18} />
                  </Link>
                </article>
              ))}
            </div>
          ) : (
            <Empty
              title={
                hasFilter ? "Группа не найдена" : "Группы ещё не добавлены"
              }
            >
              {hasFilter
                ? "Попробуйте другое название, программу или курс обучения."
                : "Администратор сможет создать группу и добавить учебную программу."}
            </Empty>
          )}
          {filtered.length > limit && (
            <div className="academic-load-more">
              <button
                className="btn btn-secondary"
                onClick={() => setLimit((value) => value + 12)}
              >
                Показать ещё {Math.min(12, filtered.length - limit)}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
