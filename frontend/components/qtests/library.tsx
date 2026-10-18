"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  FileText,
  FileUp,
  History,
  Layers3,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { api, formatBytes } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  qtestsDate,
  qtestsError,
  type QTestsImport,
  type QTestsOverview,
} from "@/lib/qtests";
import styles from "./qtests.module.css";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export default function QTestsLibrary() {
  const { user } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<QTestsOverview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [answerMode, setAnswerMode] = useState<"first" | "marked">("first");
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState(false);
  const [confirmAttempt, setConfirmAttempt] = useState<number | null>(null);
  const [deletingAttempt, setDeletingAttempt] = useState(false);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const input = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (silent = false) => {
    const request = ++generation.current;
    if (!silent) setBusy(true);
    try {
      const next = await api<QTestsOverview>("/qtests/overview");
      if (request !== generation.current) return;
      setData(next);
      setError("");
    } catch (cause) {
      if (request === generation.current) setError(qtestsError(cause));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void refresh();
    });
    const changed = () => {
      if (document.visibilityState !== "hidden") void refresh(true);
    };
    window.addEventListener("focus", changed);
    window.addEventListener("qstudy:job", changed);
    return () => {
      active = false;
      invalidate();
      window.removeEventListener("focus", changed);
      window.removeEventListener("qstudy:job", changed);
    };
  }, [refresh, invalidate]);
  const importing =
    data?.banks.some((bank) => bank.status === "importing") ?? false;
  useEffect(() => {
    if (!importing) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh(true);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [importing, refresh]);

  function chooseFile(next: File | null) {
    if (!next) return;
    if (!/\.docx$/i.test(next.name)) {
      setError(
        "Выберите документ .docx. Старый .doc сначала сохраните в Word как .docx.",
      );
      return;
    }
    if (next.size > MAX_FILE_BYTES) {
      setError("Документ слишком большой. Максимальный размер — 10 МБ.");
      return;
    }
    if (!next.size) {
      setError("Файл пуст. Выберите документ с вопросами.");
      return;
    }
    setFile(next);
    setError("");
    if (!title.trim()) setTitle(next.name.replace(/\.docx$/i, ""));
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || uploading) return;
    setUploading(true);
    setError("");
    const body = new FormData();
    body.set("file", file);
    body.set("title", title.trim() || file.name.replace(/\.docx$/i, ""));
    body.set("answer_mode", answerMode);
    try {
      const result = await api<QTestsImport>("/qtests/banks", {
        method: "POST",
        body,
      });
      router.push(`/qtests/banks/${result.bank.id}`);
    } catch (cause) {
      setError(qtestsError(cause));
    } finally {
      setUploading(false);
    }
  }
  async function createManual() {
    if (uploading) return;
    setUploading(true);
    setError("");
    try {
      const bank = await api<{ id: number }>("/qtests/banks/manual", {
        method: "POST",
        body: JSON.stringify({ title: title.trim() || "Мой банк вопросов" }),
      });
      router.push(`/qtests/banks/${bank.id}`);
    } catch (cause) {
      setError(qtestsError(cause));
      setUploading(false);
    }
  }
  async function deleteAttempt(id: number) {
    if (deletingAttempt) return;
    setDeletingAttempt(true);
    setError("");
    try {
      await api(`/qtests/attempts/${id}`, { method: "DELETE" });
      setConfirmAttempt(null);
      await refresh(true);
    } catch (cause) {
      setError(qtestsError(cause));
    } finally {
      setDeletingAttempt(false);
    }
  }

  const banks =
    data?.banks.filter((bank) =>
      `${bank.title} ${bank.filename}`
        .toLocaleLowerCase("ru")
        .includes(search.toLocaleLowerCase("ru")),
    ) ?? [];
  const attempts = data?.attempts ?? [];
  return (
    <main id="qtests-main" className={styles.workspace}>
      <div className={styles.workspaceHeading}>
        <div>
          <p className={styles.eyebrow}>ЛИЧНАЯ ПРАКТИКА / QTESTS</p>
          <h1>
            Привет, {user.name.split(" ")[0] || "студент"}.<br />
            <em>Что повторим сегодня?</em>
          </h1>
          <p>
            Соберите вопросы в одном месте. Знания останутся с вами, порядок —
            каждый раз новый.
          </p>
        </div>
        <button
          className={styles.iconButton}
          onClick={() => void refresh()}
          disabled={busy}
          aria-label="Обновить банки и результаты"
        >
          <RefreshCw size={19} className={busy ? styles.spinning : undefined} />
        </button>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={styles.statGrid} aria-label="Ваша статистика">
        <article>
          <Layers3 size={20} />
          <strong>{data?.stats.banks ?? "—"}</strong>
          <span>Банков вопросов</span>
        </article>
        <article>
          <FileText size={20} />
          <strong>{data?.stats.questions ?? "—"}</strong>
          <span>Вопросов для практики</span>
        </article>
        <article>
          <Check size={21} />
          <strong>{data?.stats.finished ?? "—"}</strong>
          <span>Завершённых тренировок</span>
        </article>
      </div>
      <div className={styles.libraryColumns}>
        <section className={styles.uploadPanel} aria-labelledby="upload-title">
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.eyebrow}>01 / ПОПОЛНИТЬ БАНК</p>
              <h2 id="upload-title">
                Ваш Word —<br />
                ваша тренировка.
              </h2>
            </div>
            <FileUp size={27} />
          </div>
          <form onSubmit={upload} className={styles.form}>
            <label
              htmlFor="qtests-file"
              className={`${styles.dropzone} ${dragging ? styles.dragging : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                chooseFile(e.dataTransfer.files[0] ?? null);
              }}
            >
              <FileUp size={29} />
              <strong>
                {file ? file.name : "Выберите или перетащите Word"}
              </strong>
              <span>
                {file
                  ? `${formatBytes(file.size)} · Нажмите, чтобы заменить`
                  : "DOCX · до 10 МБ"}
              </span>
              <input
                ref={input}
                id="qtests-file"
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                disabled={uploading}
              />
            </label>
            <label className={styles.field}>
              Название банка
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={180}
                placeholder="Например, история · итоговый экзамен"
                disabled={uploading}
              />
            </label>
            <label className={styles.field}>
              Как указаны правильные ответы?
              <select
                value={answerMode}
                onChange={(e) =>
                  setAnswerMode(e.target.value as "first" | "marked")
                }
                disabled={uploading}
              >
                <option value="first">
                  Везде правильный первый вариант (A)
                </option>
                <option value="marked">
                  Правильные ответы отмечены в документе
                </option>
              </select>
            </label>
            <p className={styles.fieldHint}>
              {answerMode === "first"
                ? "Первый вариант каждого исходного вопроса будет ключом. Затем варианты перемешаются, и правильный ответ уже может оказаться под любой буквой."
                : "У каждого вопроса нужен явный ключ: например, «Ответ: B» или «Правильный ответ: 2». Вопросы без однозначного ключа попадут в предупреждения."}
            </p>
            <button
              type="submit"
              className={styles.primary}
              disabled={!file || uploading}
            >
              {uploading ? (
                <>
                  <Loader2 size={18} className={styles.spinning} /> Загружаем
                  документ…
                </>
              ) : (
                <>
                  Создать банк вопросов <ArrowUpRight size={18} />
                </>
              )}
            </button>
            <button
              type="button"
              className={styles.textLink}
              onClick={() => void createManual()}
              disabled={uploading}
            >
              Или создать пустой банк вручную <ArrowRight size={15} />
            </button>
          </form>
          <p className={styles.privacy}>
            <ShieldCheck size={16} /> Документ доступен вам и администраторам.
            Перед практикой проверьте распознанные вопросы.
          </p>
          {data && (
            <p className={styles.aiNote}>
              <Sparkles size={16} />
              {data.ai_available
                ? "Для сложного формата и разбора ошибок текст документа и выбранных вопросов может обрабатываться подключённым Google Gemini. Готовый банк сохраняется на сервере."
                : "Стандартный формат читается без ИИ. Для сложных документов и дополнительных объяснений администратор может подключить ИИ."}
            </p>
          )}
        </section>
        <section className={styles.bankSection} aria-labelledby="banks-title">
          <div className={styles.sectionTop}>
            <div>
              <p className={styles.eyebrow}>02 / ВЫБРАТЬ ТЕМУ</p>
              <h2 id="banks-title">
                Мои банки вопросов <span>{data?.banks.length ?? 0}</span>
              </h2>
            </div>
          </div>
          <label className={styles.search}>
            <Search size={17} />
            <span className={styles.srOnly}>Найти банк вопросов</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Найти по названию…"
            />
          </label>
          {!data && (
            <div className={styles.empty} role="status">
              <Loader2 size={24} className={styles.spinning} />
              <h3>
                {error
                  ? "Не удалось открыть библиотеку"
                  : "Открываем вашу библиотеку…"}
              </h3>
              {error && (
                <button
                  onClick={() => void refresh()}
                  className={styles.secondary}
                >
                  Повторить
                </button>
              )}
            </div>
          )}
          {data && banks.length === 0 && (
            <div className={styles.empty}>
              <Layers3 size={34} />
              <h3>
                {search
                  ? "Такого банка пока нет"
                  : "Здесь начнётся ваша практика"}
              </h3>
              <p>
                {search
                  ? "Попробуйте другое название."
                  : "Загрузите документ с вопросами слева. Все извлечённые вопросы сохранятся в вашем личном банке."}
              </p>
              {!search && (
                <button
                  className={styles.secondary}
                  onClick={() => input.current?.click()}
                >
                  Выбрать Word
                </button>
              )}
            </div>
          )}
          <div className={styles.bankList}>
            {banks.map((bank) => (
              <Link
                className={styles.bankCard}
                href={`/qtests/banks/${bank.id}`}
                key={bank.id}
              >
                <div className={styles.bankIcon}>
                  <FileText size={23} />
                </div>
                <div className={styles.bankCopy}>
                  <div>
                    <span
                      className={`${styles.badge} ${bank.status === "error" ? styles.badgeError : bank.status === "importing" ? styles.badgePending : ""}`}
                    >
                      {bank.status === "ready"
                        ? "Готов к практике"
                        : bank.status === "error"
                          ? "Нужна проверка"
                          : "Читаем документ"}
                    </span>
                  </div>
                  <h3>{bank.title}</h3>
                  <p>
                    {bank.question_count} вопросов <span>·</span>{" "}
                    {qtestsDate(bank.updated_at || bank.created_at)}
                  </p>
                  {bank.warnings?.length > 0 && (
                    <small>
                      {bank.warnings.length} предупреждений — проверьте банк
                    </small>
                  )}
                </div>
                {bank.status === "importing" ? (
                  <Loader2 size={20} className={styles.spinning} />
                ) : (
                  <ArrowUpRight size={21} />
                )}
              </Link>
            ))}
          </div>
        </section>
      </div>
      <section className={styles.history} aria-labelledby="history-title">
        <div className={styles.sectionTop}>
          <div>
            <p className={styles.eyebrow}>03 / ПРОДОЛЖИТЬ СВОЙ ПУТЬ</p>
            <h2 id="history-title">История тренировок</h2>
          </div>
          <History size={24} />
        </div>
        {attempts.length === 0 ? (
          <p className={styles.muted}>
            Здесь появятся результаты и незаконченные тренировки. Ответы
            сохраняются после каждого выбора.
          </p>
        ) : (
          <div className={styles.attemptList}>
            {attempts.map((attempt) => (
              <div key={attempt.id} className={styles.attemptRow}>
                <Link href={`/qtests/attempts/${attempt.id}`}>
                  <div>
                    <strong>{attempt.bank_title}</strong>
                    <span>
                      {qtestsDate(attempt.created_at)} ·{" "}
                      {attempt.answered_count} из {attempt.question_count}{" "}
                      ответов
                    </span>
                  </div>
                  <b>
                    {attempt.status === "finished"
                      ? `${attempt.correct_count} / ${attempt.question_count}`
                      : "Продолжить"}
                  </b>
                  <ArrowRight size={18} />
                </Link>
                <button
                  className={styles.iconButton}
                  onClick={() =>
                    setConfirmAttempt(
                      confirmAttempt === attempt.id ? null : attempt.id,
                    )
                  }
                  disabled={deletingAttempt}
                  aria-label={`Удалить тренировку «${attempt.bank_title}»`}
                >
                  <Trash2 size={15} />
                </button>
                {confirmAttempt === attempt.id && (
                  <div className={styles.historyConfirm} role="alert">
                    <p>
                      Удалить эту тренировку и её ответы? Банк вопросов
                      останется.
                    </p>
                    <button
                      className={styles.dangerLink}
                      onClick={() => void deleteAttempt(attempt.id)}
                      disabled={deletingAttempt}
                    >
                      {deletingAttempt ? "Удаляем…" : "Да, удалить"}
                    </button>
                    <button
                      className={styles.textLink}
                      onClick={() => setConfirmAttempt(null)}
                      disabled={deletingAttempt}
                    >
                      Отмена
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      <aside className={styles.sourceNote}>
        QTests тренирует вопросы из ваших документов. Учебные тесты по силабусам
        и модулям остаются в{" "}
        <Link href="/dashboard/tests">
          QStudy <ArrowUpRight size={13} />
        </Link>
        .
      </aside>
    </main>
  );
}
