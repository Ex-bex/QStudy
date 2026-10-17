"use client";

import Link from "next/link";
import {
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  CheckCheck,
  FileText,
  GraduationCap,
  LibraryBig,
  Users,
} from "lucide-react";
import {
  ErrorNotice,
  Loading,
  PageTitle,
  useResource,
} from "@/components/academic";
import type { Group, Syllabus, Work } from "@/types/academic";
import type { Subject } from "@/types";
import styles from "./study.module.css";

const sections = [
  {
    href: "/qcontrol/qstudy/groups",
    icon: CalendarDays,
    title: "Группы и расписание",
    description:
      "Создавайте группы и дисциплины, меняйте преподавателей, кабинеты и время занятий. Внутри дисциплины доступны недели и задания.",
    action: "Управлять учебным планом",
  },
  {
    href: "/qcontrol/qstudy/syllabi",
    icon: FileText,
    title: "Силабусы и импорт",
    description:
      "Загружайте документы, запускайте распознавание и ИИ, проверяйте черновики и публикуйте программу для студентов.",
    action: "Открыть документы",
  },
  {
    href: "/qcontrol/qstudy/modules",
    icon: CheckCheck,
    title: "Работы и оценки",
    description:
      "Просматривайте ответы студентов, выставляйте баллы и оставляйте обратную связь. Редактирование заданий доступно в каждой карточке.",
    action: "Проверить работы",
  },
  {
    href: "/qcontrol/qstudy/subjects",
    icon: LibraryBig,
    title: "Предметы и темы",
    description:
      "Поддерживайте общую базу знаний: добавляйте предметы и темы, уточняйте описания и удаляйте устаревшие разделы.",
    action: "Настроить базу знаний",
  },
];

export default function StudyControlPage() {
  const groups = useResource<Group[]>("/groups");
  const documents = useResource<Syllabus[]>("/syllabi");
  const works = useResource<Work[]>("/works");
  const subjects = useResource<Subject[]>("/subjects");
  const errors = [
    ...new Set(
      [groups.error, documents.error, works.error, subjects.error].filter(
        Boolean,
      ),
    ),
  ];
  const courseCount = groups.data?.reduce(
    (sum, group) => sum + group.course_count,
    0,
  );
  const needsReview = documents.data?.filter(
    (document) => document.status !== "published",
  ).length;
  const metrics = [
    { label: "Учебных групп", value: groups.data?.length, icon: Users },
    { label: "Дисциплин", value: courseCount, icon: GraduationCap },
    { label: "Силабусов", value: documents.data?.length, icon: FileText },
    { label: "Учебных работ", value: works.data?.length, icon: BookOpen },
  ];
  return (
    <div className={styles.page}>
      <PageTitle
        eyebrow="QCONTROL / QSTUDY"
        title="Учебное пространство"
        description="Вся учебная программа под вашим управлением: от группы и расписания до публикации силабуса и проверки работ."
      >
        <Link className="btn btn-primary" href="/qcontrol/qstudy/groups">
          Управлять группами <ArrowUpRight size={16} />
        </Link>
      </PageTitle>
      {errors.map((error) => (
        <ErrorNotice key={error} message={error} />
      ))}
      <div
        className={styles.metrics}
        aria-label="Состояние учебного пространства"
      >
        {metrics.map(({ label, value, icon: Icon }) => (
          <div className={styles.metric} key={label}>
            <Icon size={19} aria-hidden="true" />
            <strong>{value ?? "—"}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className={styles.sections}>
        {sections.map(({ href, icon: Icon, title, description, action }) => (
          <Link href={href} className={styles.section} key={href}>
            <span className={styles.sectionIcon}>
              <Icon size={23} />
            </span>
            <h2>{title}</h2>
            <p>{description}</p>
            <span className={styles.sectionAction}>
              {action} <ArrowUpRight size={17} />
            </span>
          </Link>
        ))}
      </div>
      <section className={styles.status}>
        <div>
          <span className="eyebrow">ПУБЛИКАЦИЯ ПРОГРАММЫ</span>
          <h2>Что видят студенты</h2>
          <p>
            Расписание и дисциплины доступны в QStudy. После публикации силабуса
            студенты получают учебный план и работы, а QCareer использует
            результаты обучения для подтверждения навыков.
          </p>
        </div>
        {documents.loading ? (
          <Loading />
        ) : (
          <Link href="/qcontrol/qstudy/syllabi" className={styles.review}>
            <strong>{needsReview ?? "—"}</strong>
            <span>документов вне публикации</span>
            <ArrowUpRight size={18} />
          </Link>
        )}
      </section>
    </div>
  );
}
