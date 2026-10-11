"use client";

import { useEffect, useState } from "react";
import {
  Archive,
  Download,
  History,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { api, formatBytes } from "@/lib/api";
import {
  ErrorNotice,
  Loading,
  Empty,
  useResource,
  errorMessage,
} from "@/components/academic";
import styles from "./operations.module.css";

type Backup = {
  name: string;
  created_at: string;
  reason: string;
  size_bytes: number;
  upload_count: number;
  warnings: string[];
};
type BackupState = {
  items: Backup[];
  status: {
    enabled: boolean;
    running: boolean;
    interval_hours: number;
    retention_count: number;
    last_success: Backup | null;
    next_due_at: string | null;
    last_error: string;
  };
};
type Audit = {
  id: number;
  created_at: string;
  actor_label: string;
  action: string;
  object_type: string;
  object_id: string | null;
  fields: string[];
  metadata: Record<string, string | number | boolean>;
};
type AuditPage = {
  items: Audit[];
  total: number;
  offset: number;
  limit: number;
};
const reasons: Record<string, string> = {
  manual: "По запросу",
  startup: "При запуске",
  scheduled: "По расписанию",
  upgrade: "Перед обновлением",
  "pre-restore": "Перед восстановлением",
};
const objects: Record<string, string> = {
  user: "Аккаунт",
  group: "Группа",
  course: "Дисциплина",
  schedule: "Занятие",
  week: "Учебная неделя",
  work: "Работа",
  syllabus: "Силабус",
  submission: "Ответ студента",
  backup: "Резервная копия",
  subject: "Предмет",
  topic: "Тема",
};
const verbs: Record<string, string> = {
  create: "Создание",
  update: "Изменение",
  delete: "Удаление",
  publish: "Публикация",
  grade: "Оценивание",
  password_reset: "Смена пароля",
  analyze: "Анализ",
  process: "Обработка",
  settings: "Настройки",
};
const fields: Record<string, string> = {
  name: "Имя",
  email: "Email",
  role: "Роль",
  is_active: "Доступ",
  group_id: "Группа",
  title: "Название",
  room: "Кабинет",
  teacher: "Преподаватель",
  start_time: "Время",
  start_times: "Время",
  end_time: "Окончание",
  day_of_week: "День",
  week_pattern: "Недели",
  description: "Описание",
  credits: "Кредиты",
  color: "Цвет",
  academic_year: "Учебный год",
  program: "Программа",
  study_year: "Курс",
  semester: "Семестр",
  curator: "Куратор",
  week_number: "Неделя",
  module: "Модуль",
  hours: "Часы",
  max_score: "Максимальный балл",
  due_date: "Срок",
  kind: "Тип",
  grade: "Оценка",
  status: "Статус",
};
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("ru-RU", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Almaty",
      })
    : "Ещё не создана";

export default function OperationsPanel() {
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const {
    data: backups,
    error: backupError,
    loading: backupsLoading,
    reload: reloadBackups,
  } = useResource<BackupState>("/admin/backups");
  const {
    data: journal,
    error: auditError,
    loading: journalLoading,
    reload: reloadJournal,
  } = useResource<AuditPage>(`/admin/audit?limit=12&offset=${page * 12}`);
  useEffect(() => {
    const timer = setInterval(
      () => {
        void reloadBackups();
      },
      backups?.status.running ? 2000 : 60000,
    );
    return () => clearInterval(timer);
  }, [backups?.status.running, reloadBackups]);
  useEffect(() => {
    void reloadJournal();
  }, [backups?.status.last_success?.name, reloadJournal]);
  async function createBackup() {
    setBusy(true);
    setMessage("");
    try {
      await api("/admin/backups", { method: "POST" });
      await reloadBackups();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.operations}>
      <section aria-labelledby="backup-heading">
        <div className="academic-section-heading">
          <h2 id="backup-heading">
            <Archive size={18} /> Резервные копии
          </h2>
          <button
            className="btn btn-primary"
            disabled={busy || backups?.status.running}
            onClick={createBackup}
          >
            {busy || backups?.status.running ? (
              <LoaderCircle size={16} className={styles.spin} />
            ) : (
              <Archive size={16} />
            )}
            {backups?.status.running ? "Создаётся копия…" : "Создать копию"}
          </button>
        </div>
        <ErrorNotice
          message={message || backupError || backups?.status.last_error || ""}
        />
        <div className={`panel ${styles.backups}`}>
          <div className={styles.summary}>
            <div>
              <small>Последняя копия</small>
              <strong>
                {date(backups?.status.last_success?.created_at || null)}
              </strong>
            </div>
            <div>
              <small>Автоматически</small>
              <strong>
                {backups
                  ? backups.status.enabled
                    ? `Каждые ${backups.status.interval_hours} ч`
                    : "Отключено"
                  : "—"}
              </strong>
            </div>
            <div>
              <small>Храним</small>
              <strong>
                {backups
                  ? `${backups.status.retention_count} последних копий`
                  : "—"}
              </strong>
            </div>
          </div>
          <p className={styles.caption}>
            В архив входят база и загруженные файлы. Настройки и секретные ключи
            из backend/.env хранятся отдельно.
          </p>
          {backupsLoading && !backups ? (
            <Loading />
          ) : !backups?.items.length ? (
            <Empty title="Копий пока нет">
              Первая автоматическая копия появится после запуска сервера.
            </Empty>
          ) : (
            <div className={styles.archiveList}>
              {backups.items.map((archive) => (
                <div className={styles.archive} key={archive.name}>
                  <Archive size={18} />
                  <div>
                    <strong>{date(archive.created_at)}</strong>
                    <small>
                      {reasons[archive.reason] || "Резервная копия"} ·{" "}
                      {formatBytes(archive.size_bytes)} · файлов:{" "}
                      {archive.upload_count}
                    </small>
                  </div>
                  <a
                    className="btn btn-secondary"
                    href={`/api/admin/backups/${encodeURIComponent(archive.name)}/download`}
                    download
                    aria-label={`Скачать копию от ${date(archive.created_at)}`}
                  >
                    <Download size={15} />
                    <span>Скачать</span>
                  </a>
                </div>
              ))}
            </div>
          )}
          {backups?.status.next_due_at && (
            <p className={styles.caption}>
              Следующая копия: {date(backups.status.next_due_at)} по времени
              университета.
            </p>
          )}
        </div>
      </section>
      <section aria-labelledby="audit-heading">
        <div className="academic-section-heading">
          <h2 id="audit-heading">
            <History size={18} /> Журнал управления
          </h2>
          <button
            className="btn btn-secondary"
            onClick={() => {
              void reloadJournal();
            }}
            aria-label="Обновить журнал"
          >
            <RefreshCw size={15} /> Обновить
          </button>
        </div>
        <p className={styles.caption}>
          История изменений аккаунтов и учебного пространства. Записи
          сохраняются вместе с изменением и защищены от редактирования.
        </p>
        <ErrorNotice message={auditError} />
        {journalLoading ? (
          <Loading />
        ) : !journal?.items.length ? (
          <div className="panel">
            <Empty title="Изменений пока нет">
              Действия администратора появятся здесь после сохранения.
            </Empty>
          </div>
        ) : (
          <div className={`panel ${styles.journal}`}>
            {journal.items.map((row) => (
              <div key={row.id} className={styles.event}>
                <div className={styles.eventTime}>
                  {date(row.created_at)}
                  <small>{row.actor_label}</small>
                </div>
                <div>
                  <strong>
                    {verbs[row.action.split(".").at(-1) || ""] || "Изменение"} ·{" "}
                    {objects[row.object_type] || "Учебное пространство"}
                  </strong>
                  <small>
                    {row.object_id && row.object_type !== "backup"
                      ? `#${row.object_id}`
                      : ""}
                    {row.fields.length
                      ? ` · ${row.fields.map((field) => fields[field] || "Поле записи").join(", ")}`
                      : ""}
                    {typeof row.metadata.weeks_created === "number"
                      ? ` · недель: ${row.metadata.weeks_created}`
                      : ""}
                    {typeof row.metadata.works_created === "number"
                      ? ` · работ: ${row.metadata.works_created}`
                      : ""}
                  </small>
                </div>
              </div>
            ))}
            <div className={styles.pagination}>
              <span>
                {page * 12 + 1}–{Math.min((page + 1) * 12, journal.total)} из{" "}
                {journal.total}
              </span>
              <button
                className="btn btn-secondary"
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                Назад
              </button>
              <button
                className="btn btn-secondary"
                disabled={(page + 1) * 12 >= journal.total}
                onClick={() => setPage((value) => value + 1)}
              >
                Далее
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
