"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Empty,
  Loading,
} from "@/components/academic";
import WorkCard from "@/components/work-card";
import type { Group, Work } from "@/types/academic";

export default function ModulesPage() {
  const [groupId, setGroupId] = useState("");
  const [kind, setKind] = useState("all");
  const { data: groups } = useResource<Group[]>("/groups");
  const {
    data: works,
    loading,
    error,
    reload,
  } = useResource<Work[]>(`/works${groupId ? `?group_id=${groupId}` : ""}`);
  const filtered =
    works?.filter((work) => kind === "all" || work.kind === kind) || [];
  return (
    <div>
      <PageTitle
        eyebrow="ПРАКТИКА И РЕЗУЛЬТАТЫ"
        title="Модульные работы"
        description="Условия заданий, сроки сдачи и обратная связь преподавателя в одном месте."
      >
        <Link className="btn btn-secondary" href="/dashboard/groups">
          К дисциплинам <ArrowUpRight size={16} />
        </Link>
      </PageTitle>
      <div className="academic-filter">
        <label className="academic-field">
          <span className="sr-only">Фильтр по группе</span>
          <select
            className="field"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
          >
            <option value="">Все доступные группы</option>
            {groups?.map((group) => (
              <option value={group.id} key={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
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
      {loading ? (
        <Loading />
      ) : filtered.length ? (
        filtered.map((work) => (
          <WorkCard key={work.id} work={work} onChanged={reload} />
        ))
      ) : (
        <Empty title="В этом разделе пока нет работ">
          Работы появятся после публикации учебной программы. Создать задания
          можно на странице дисциплины.
        </Empty>
      )}
    </div>
  );
}
