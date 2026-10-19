"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Archive,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Compass,
  Gamepad2,
  GraduationCap,
  Layers3,
  ListChecks,
  MessagesSquare,
  RefreshCw,
  Server,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useResource } from "@/components/academic";
import { useAuth } from "@/lib/auth";
import styles from "@/components/control/control.module.css";

type Stats = {
  users: number;
  students: number;
  admins: number;
  active_users: number;
  groups: number;
  courses: number;
  submissions: number;
};
type CareerStats = {
  active_skills: number;
  active_directions: number;
  active_links: number;
  active_opportunities: number;
};
type BallStats = {
  rooms_active: number;
  players_online: number;
  matches_total: number;
};
type HostStatus = {
  managed: boolean;
  control_ready: boolean;
  status: string;
  mode: string;
  ports: { frontend: number; backend: number };
  checked_utc: string | null;
};
type BackupState = {
  items: { created_at: string }[];
  status: {
    enabled: boolean;
    running: boolean;
    interval_hours: number;
    last_success: { created_at: string } | null;
    next_due_at: string | null;
    last_error: string;
  };
};

const value = (number: number | undefined, loading = false) =>
  loading
    ? "…"
    : typeof number === "number"
      ? number.toLocaleString("ru-RU")
      : "—";
const date = (input: string | null | undefined) =>
  input
    ? new Date(input).toLocaleString("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "Ещё не создана";

function ProjectCard({
  name,
  subtitle,
  description,
  icon: Icon,
  color,
  href,
  publicHref,
  metrics,
  error,
}: {
  name: string;
  subtitle: string;
  description: string;
  icon: LucideIcon;
  color: string;
  href: string;
  publicHref: string;
  metrics: { label: string; value: string }[];
  error?: string;
}) {
  return (
    <article className={styles.projectCard}>
      <div className={styles.projectBody}>
        <div className={styles.projectHeader}>
          <span className={`${styles.projectIcon} ${color}`}>
            <Icon size={22} />
          </span>
          <div>
            <h3>{name}</h3>
            <small>{subtitle}</small>
          </div>
        </div>
        <p className={styles.projectDescription}>{description}</p>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : (
          <div className={styles.projectMetrics}>
            {metrics.map((metric) => (
              <div key={metric.label}>
                <strong>{metric.value}</strong>
                <span>{metric.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={styles.projectFooter}>
        <Link href={href}>
          Управлять проектом <ArrowRight size={13} />
        </Link>
        <Link href={publicHref}>
          Открыть <ArrowUpRight size={13} />
        </Link>
      </div>
    </article>
  );
}

export default function ControlOverview() {
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const stats = useResource<Stats>("/admin/stats");
  const career = useResource<CareerStats>("/admin/career/overview");
  const ball = useResource<BallStats>("/admin/lumaball/stats");
  const tests = useResource<{
    stats: { banks: number; questions: number; attempts: number };
  }>("/admin/qtests/overview");
  const message = useResource<{
    stats: { users: number; messages: number; open_reports: number };
  }>("/admin/qmessage/overview");
  const host = useResource<HostStatus>("/admin/system/status");
  const backups = useResource<BackupState>("/admin/backups");
  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        stats.reload(),
        career.reload(),
        ball.reload(),
        tests.reload(),
        message.reload(),
        host.reload(),
        backups.reload(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }
  const firstName = user.name.trim().split(/\s+/)[0] || "администратор";
  const running = host.data?.status === "running";
  const hostLabels: Record<string, string> = {
    running: "Работает",
    starting: "Запускается",
    stopped: "Остановлен",
    failed: "Ошибка запуска",
    unavailable: "Отдельный процесс",
  };
  const modes: Record<string, string> = {
    local: "Локальный",
    lan: "Локальная сеть",
    internet: "Интернет",
  };
  return (
    <div>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>ОБЗОР ЭКОСИСТЕМЫ</p>
          <h1>Всё под контролем.</h1>
          <p>
            {firstName}, здесь собраны ваши проекты, аккаунты и состояние общего
            сервера.
          </p>
        </div>
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label="Обновить статистику"
        >
          <RefreshCw size={14} />
          {refreshing ? "Обновляем…" : "Обновить"}
        </button>
      </div>
      <section className={styles.hero} aria-labelledby="control-hero-title">
        <div className={styles.heroText}>
          <span className={styles.heroKicker}>
            <ShieldCheck size={13} /> QCONTROL / ЕДИНОЕ УПРАВЛЕНИЕ
          </span>
          <h2 id="control-hero-title">Разные проекты. Один центр решений.</h2>
          <p>
            Обучение, развитие и игра связаны общими аккаунтами Q-ID. Управляйте
            содержимым и доступом из одного пространства.
          </p>
        </div>
        <Link href="/qcontrol/accounts" className={styles.heroLink}>
          Управление доступом <ArrowUpRight size={16} />
        </Link>
      </section>
      {stats.error && (
        <p role="alert" className={styles.error}>
          Не удалось загрузить общую статистику: {stats.error}
        </p>
      )}
      <section className={styles.stats} aria-label="Основные показатели">
        {[
          {
            label: "Аккаунты Q-ID",
            count: stats.data?.users,
            loading: stats.loading,
            icon: Users,
            note: "Общий доступ к проектам",
          },
          {
            label: "Учебные группы",
            count: stats.data?.groups,
            loading: stats.loading,
            icon: GraduationCap,
            note: "Программы и расписание",
          },
          {
            label: "Навыки QCareer",
            count: career.data?.active_skills,
            loading: career.loading,
            icon: Compass,
            note: "Активные в каталоге",
          },
          {
            label: "Игроки онлайн",
            count: ball.data?.players_online,
            loading: ball.loading,
            icon: Gamepad2,
            note: "На площадке QBall сейчас",
          },
        ].map((item) => (
          <article key={item.label} className={styles.stat}>
            <div className={styles.statTop}>
              <span>{item.label}</span>
              <item.icon size={17} />
            </div>
            <strong>{value(item.count, item.loading)}</strong>
            <small>{item.note}</small>
          </article>
        ))}
      </section>
      <div className={styles.sectionHeading}>
        <h2>Ваши проекты</h2>
        <span>Содержимое, настройки и участники</span>
      </div>
      <section className={styles.projects} aria-label="Управление проектами">
        <ProjectCard
          name="QMessage"
          subtitle="ОБЩЕНИЕ"
          description="Личные сообщения между участниками Q-ID, стикеры, доступ и рассмотрение жалоб."
          icon={MessagesSquare}
          color={styles.idIcon}
          href="/qcontrol/qmessage"
          publicHref="/qmessage"
          error={message.error}
          metrics={[
            {
              label: "Участников",
              value: value(message.data?.stats.users, message.loading),
            },
            {
              label: "Сообщений",
              value: value(message.data?.stats.messages, message.loading),
            },
            {
              label: "Открытых жалоб",
              value: value(message.data?.stats.open_reports, message.loading),
            },
          ]}
        />
        <ProjectCard
          name="QTests"
          subtitle="ВОПРОСЫ ИЗ WORD"
          description="Импорт банков вопросов, случайные тесты, разбор ошибок и история попыток."
          icon={ListChecks}
          color={styles.testsIcon}
          href="/qcontrol/qtests"
          publicHref="/qtests"
          error={tests.error}
          metrics={[
            {
              label: "Банков",
              value: value(tests.data?.stats.banks, tests.loading),
            },
            {
              label: "Вопросов",
              value: value(tests.data?.stats.questions, tests.loading),
            },
            {
              label: "Попыток",
              value: value(tests.data?.stats.attempts, tests.loading),
            },
          ]}
        />
        <ProjectCard
          name="QStudy"
          subtitle="ОБУЧЕНИЕ"
          description="Группы, расписание, дисциплины, силабусы, модули и проверка работ."
          icon={BookOpen}
          color={styles.studyIcon}
          href="/qcontrol/qstudy"
          publicHref="/dashboard"
          error={stats.error}
          metrics={[
            {
              label: "Дисциплин",
              value: value(stats.data?.courses, stats.loading),
            },
            {
              label: "Учебных групп",
              value: value(stats.data?.groups, stats.loading),
            },
            {
              label: "Ответов на работы",
              value: value(stats.data?.submissions, stats.loading),
            },
          ]}
        />
        <ProjectCard
          name="QCareer"
          subtitle="РАЗВИТИЕ И КАРЬЕРА"
          description="Подтверждённые обучением навыки, направления, учебные связи и возможности."
          icon={Compass}
          color={styles.careerIcon}
          href="/qcontrol/qcareer"
          publicHref="/qcareer"
          error={career.error}
          metrics={[
            {
              label: "Направлений",
              value: value(career.data?.active_directions, career.loading),
            },
            {
              label: "Учебных связей",
              value: value(career.data?.active_links, career.loading),
            },
            {
              label: "Возможностей",
              value: value(career.data?.active_opportunities, career.loading),
            },
          ]}
        />
        <ProjectCard
          name="QBall"
          subtitle="ИГРОВАЯ ПЛОЩАДКА"
          description="Комнаты, карты и матчи. Настройки игры, участники и история результатов."
          icon={Gamepad2}
          color={styles.ballIcon}
          href="/qcontrol/qball"
          publicHref="/qball"
          error={ball.error}
          metrics={[
            {
              label: "Активных комнат",
              value: value(ball.data?.rooms_active, ball.loading),
            },
            {
              label: "Игроков онлайн",
              value: value(ball.data?.players_online, ball.loading),
            },
            {
              label: "Матчей всего",
              value: value(ball.data?.matches_total, ball.loading),
            },
          ]}
        />
        <ProjectCard
          name="Q-ID"
          subtitle="ЕДИНЫЙ ВХОД"
          description="Аккаунты экосистемы, роли, учебные группы, пароли и управление доступом."
          icon={ShieldCheck}
          color={styles.idIcon}
          href="/qcontrol/accounts"
          publicHref="/login"
          error={stats.error}
          metrics={[
            {
              label: "Студентов",
              value: value(stats.data?.students, stats.loading),
            },
            {
              label: "Администраторов",
              value: value(stats.data?.admins, stats.loading),
            },
            {
              label: "Активных аккаунтов",
              value: value(stats.data?.active_users, stats.loading),
            },
          ]}
        />
      </section>
      <div className={styles.bottomGrid}>
        <section
          className={styles.infoPanel}
          aria-labelledby="control-server-title"
        >
          <div className={styles.panelTitle}>
            <Server size={17} />
            <h2 id="control-server-title">Общий сервер</h2>
          </div>
          {host.error ? (
            <p className={styles.error} role="alert">
              {host.error}
            </p>
          ) : (
            <>
              <div className={styles.detailRow}>
                <span>Состояние</span>
                <strong
                  className={`${styles.status} ${running ? "" : styles.statusMuted}`}
                >
                  {host.loading
                    ? "Проверяем…"
                    : hostLabels[host.data?.status || ""] || "Нет данных"}
                </strong>
              </div>
              <div className={styles.detailRow}>
                <span>Режим подключения</span>
                <strong>
                  {host.data?.mode
                    ? modes[host.data.mode] || host.data.mode
                    : "—"}
                </strong>
              </div>
              <div className={styles.detailRow}>
                <span>Порт сайта</span>
                <strong>{host.data?.ports?.frontend || "—"}</strong>
              </div>
              <div className={styles.detailRow}>
                <span>Управление запуском</span>
                <strong>
                  {host.data
                    ? host.data.control_ready
                      ? "Доступно из QControl"
                      : "Через стартер хоста"
                    : "—"}
                </strong>
              </div>
            </>
          )}
          <Link href="/qcontrol/system" className={styles.panelLink}>
            Параметры и управление сервером <ArrowRight size={13} />
          </Link>
        </section>
        <section
          className={styles.infoPanel}
          aria-labelledby="control-backups-title"
        >
          <div className={styles.panelTitle}>
            <Archive size={17} />
            <h2 id="control-backups-title">Сохранность данных</h2>
          </div>
          {backups.error ? (
            <p className={styles.error} role="alert">
              {backups.error}
            </p>
          ) : (
            <>
              <div className={styles.detailRow}>
                <span>Автоматические копии</span>
                <strong>
                  {backups.loading
                    ? "Проверяем…"
                    : backups.data?.status.enabled
                      ? `Каждые ${backups.data.status.interval_hours} ч`
                      : "Отключены"}
                </strong>
              </div>
              <div className={styles.detailRow}>
                <span>Архивов доступно</span>
                <strong>
                  {value(backups.data?.items.length, backups.loading)}
                </strong>
              </div>
              <div className={styles.detailRow}>
                <span>Последняя успешная копия</span>
                <strong>
                  {backups.loading
                    ? "…"
                    : date(backups.data?.status.last_success?.created_at)}
                </strong>
              </div>
              <div className={styles.detailRow}>
                <span>Сейчас</span>
                <strong>
                  {backups.loading
                    ? "…"
                    : backups.data?.status.running
                      ? "Создаётся копия"
                      : "Ожидание"}
                </strong>
              </div>
              {backups.data?.status.last_error && (
                <p className={styles.error} role="alert">
                  {backups.data.status.last_error}
                </p>
              )}
            </>
          )}
          <Link href="/qcontrol/operations" className={styles.panelLink}>
            Резервные копии и журнал <ArrowRight size={13} />
          </Link>
        </section>
      </div>
      <p className={styles.smallNote}>
        <Layers3
          size={11}
          style={{ display: "inline", verticalAlign: "-2px", marginRight: 5 }}
        />
        Показатели получены из общей базы и текущего состояния сервисов. Кнопка
        «Обновить» запрашивает их заново.
      </p>
    </div>
  );
}
