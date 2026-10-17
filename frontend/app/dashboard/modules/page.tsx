"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useAuth, type User } from "@/lib/auth";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Empty,
  Loading,
} from "@/components/academic";
import WorkCard from "@/components/work-card";
import type { Group, GroupDetail, Work } from "@/types/academic";

export default function ModulesPage() {
  const { user } = useAuth();
  return (
    <ModulesContent
      key={`${user.id}:${user.role}:${user.group_id ?? "unassigned"}`}
      user={user}
    />
  );
}

function ModulesContent({ user }: { user: User }) {
  const admin = user.role === "admin";
  const [groupId, setGroupId] = useState("");
  const [courseId, setCourseId] = useState("");
  const [kind, setKind] = useState("all");
  const { data: groups } = useResource<Group[]>(admin ? "/groups" : null);
  const {
    data: ownGroup,
    loading: groupLoading,
    error: groupError,
  } = useResource<GroupDetail>(
    !admin && user.group_id ? `/groups/${user.group_id}` : null,
  );
  useEffect(() => {
    const selected = new URLSearchParams(window.location.search).get("course");
    if (selected && /^[1-9]\d*$/.test(selected)) setCourseId(selected);
  }, []);
  const selectedCourse =
    courseId &&
    (admin ||
      ownGroup?.courses.some((course) => String(course.id) === courseId))
      ? courseId
      : "";
  const selectedGroup = admin ? groupId : String(user.group_id ?? "");
  const query = new URLSearchParams();
  if (selectedGroup) query.set("group_id", selectedGroup);
  if (selectedCourse) query.set("course_id", selectedCourse);
  const canLoad = admin || Boolean(user.group_id && ownGroup);
  const {
    data: works,
    loading,
    error,
    reload,
  } = useResource<Work[]>(canLoad ? `/works?${query.toString()}` : null);
  const filtered =
    works?.filter((work) => kind === "all" || work.kind === kind) || [];
  return (
    <div>
      <PageTitle
        eyebrow="ПРАКТИКА И РЕЗУЛЬТАТЫ"
        title="Модульные работы"
        description="Условия заданий, сроки сдачи и обратная связь преподавателя в одном месте."
      >
        <Link
          className="btn btn-secondary"
          href={
            !admin && user.group_id
              ? `/dashboard/groups/${user.group_id}`
              : "/dashboard/groups"
          }
        >
          К дисциплинам <ArrowUpRight size={16} />
        </Link>
      </PageTitle>
      {!admin && !user.group_id ? (
        <Empty title="Учебная группа пока не назначена">
          Попросите администратора назначить вашу группу в настройках аккаунта.
          После назначения здесь появятся её модули, задания и ваши результаты.
        </Empty>
      ) : (
        <>
          <div className="academic-filter">
            {admin ? (
              <label className="academic-field">
                <span className="sr-only">Фильтр по группе</span>
                <select
                  className="field"
                  value={groupId}
                  onChange={(e) => {
                    setGroupId(e.target.value);
                    setCourseId("");
                  }}
                >
                  <option value="">Все доступные группы</option>
                  {groups?.map((group) => (
                    <option value={group.id} key={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : ownGroup ? (
              <>
                <Link
                  className="badge"
                  href={`/dashboard/groups/${ownGroup.id}`}
                >
                  Моя группа · {ownGroup.name}
                </Link>
                <label className="academic-field">
                  <span className="sr-only">Фильтр по дисциплине</span>
                  <select
                    className="field"
                    value={selectedCourse}
                    onChange={(e) => setCourseId(e.target.value)}
                  >
                    <option value="">Все дисциплины моей группы</option>
                    {ownGroup.courses.map((course) => (
                      <option value={course.id} key={course.id}>
                        {course.title}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            {admin && selectedCourse && (
              <button
                className="btn btn-secondary"
                onClick={() => setCourseId("")}
              >
                Показать все дисциплины
              </button>
            )}
          </div>
          <div className="academic-tabs">
            {[
              { id: "all", label: "Все работы" },
              { id: "module", label: "Модули" },
              { id: "assignment", label: "Задания" },
              { id: "practice", label: "Практика" },
              { id: "exam", label: "Экзамены" },
            ].map((tab) => (
              <button
                key={tab.id}
                className={kind === tab.id ? "active" : ""}
                onClick={() => setKind(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <ErrorNotice message={error} />
          <ErrorNotice message={groupError} />
          {loading || groupLoading ? (
            <Loading />
          ) : filtered.length ? (
            filtered.map((work) => (
              <WorkCard key={work.id} work={work} onChanged={reload} />
            ))
          ) : (
            <Empty title="В этом разделе пока нет работ">
              {admin
                ? "Создать задания можно на странице дисциплины."
                : "Работы вашей группы появятся после публикации учебной программы. Сдать работу, сохранить черновик и увидеть оценку можно в её карточке."}
            </Empty>
          )}
        </>
      )}
    </div>
  );
}
