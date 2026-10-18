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
  FolderOpen,
  History,
  Layers3,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Trash2,
} from "lucide-react";
import { api, formatBytes } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  qtestsDate,
  qtestsError,
  type QTestsImport,
  type QTestsAttempt,
  type QTestsLesson,
  type QTestsOverview,
} from "@/lib/qtests";
import {
  QTESTS_TITLE_LIMIT,
  qtestsDocumentError,
  qtestsDocumentTitle,
} from "@/lib/qtests-upload";
import styles from "./qtests.module.css";

export default function QTestsLibrary() {
  const { user } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<QTestsOverview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [creatingManual, setCreatingManual] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [createdBankId, setCreatedBankId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [answerMode, setAnswerMode] = useState<"first" | "marked">("first");
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState(false);
  const [lessonFilter, setLessonFilter] = useState("all");
  const [uploadLesson, setUploadLesson] = useState("");
  const [lessonEdit, setLessonEdit] = useState<number | "new" | null>(null);
  const [lessonTitle, setLessonTitle] = useState("");
  const [lessonDescription, setLessonDescription] = useState("");
  const [savingLesson, setSavingLesson] = useState(false);
  const [confirmLesson, setConfirmLesson] = useState<number | null>(null);
  const [deletingLesson, setDeletingLesson] = useState(false);
  const [practiceBank, setPracticeBank] = useState("");
  const [practiceCount, setPracticeCount] = useState(40);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmAttempt, setConfirmAttempt] = useState<number | null>(null);
  const [deletingAttempt, setDeletingAttempt] = useState(false);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const uploadBusy = uploading || creatingManual;

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
    data?.banks.some(
      (bank) =>
        bank.status === "importing" || bank.replacement_status === "importing",
    ) ?? false;
  useEffect(() => {
    if (!importing) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh(true);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [importing, refresh]);

  function chooseFile(next: File | null) {
    if (!next) return;
    if (uploadBusy) return;
    setCreatedBankId(null);
    const message = qtestsDocumentError(next);
    setUploadError(message);
    if (message) {
      setFile(null);
      if (input.current) input.current.value = "";
      return;
    }
    setFile(next);
    if (!title.trim()) setTitle(qtestsDocumentTitle(next.name));
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (uploadBusy) return;
    const message = qtestsDocumentError(file);
    if (message || !file) {
      setUploadError(message);
      input.current?.focus();
      return;
    }
    setUploading(true);
    setUploadError("");
    setCreatedBankId(null);
    const body = new FormData();
    body.set("file", file);
    body.set("title", title.trim() || qtestsDocumentTitle(file.name));
    body.set("answer_mode", answerMode);
    if (uploadLesson) body.set("lesson_id", uploadLesson);
    try {
      const result = await api<QTestsImport>("/qtests/banks", {
        method: "POST",
        body,
      });
      setCreatedBankId(result.bank.id);
      router.push(`/qtests/banks/${result.bank.id}`);
    } catch (cause) {
      setUploadError(qtestsError(cause));
    } finally {
      setUploading(false);
    }
  }
  async function createManual() {
    if (uploadBusy) return;
    setCreatingManual(true);
    setUploadError("");
    setCreatedBankId(null);
    try {
      const bank = await api<{ id: number }>("/qtests/banks/manual", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim() || "Мой банк вопросов",
          lesson_id: uploadLesson ? Number(uploadLesson) : null,
        }),
      });
      setCreatedBankId(bank.id);
      router.push(`/qtests/banks/${bank.id}`);
    } catch (cause) {
      setUploadError(qtestsError(cause));
      setCreatingManual(false);
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

  function editLesson(lesson?: QTestsLesson) {
    setLessonEdit(lesson?.id ?? "new");
    setLessonTitle(lesson?.title ?? "");
    setLessonDescription(lesson?.description ?? "");
    setConfirmLesson(null);
  }
  async function saveLesson(event: FormEvent) {
    event.preventDefault();
    if (!lessonTitle.trim() || savingLesson || lessonEdit === null) return;
    setSavingLesson(true);
    setError("");
    try {
      const next = await api<QTestsLesson>(
        `/qtests/lessons${lessonEdit === "new" ? "" : `/${lessonEdit}`}`,
        {
          method: lessonEdit === "new" ? "POST" : "PATCH",
          body: JSON.stringify({
            title: lessonTitle.trim(),
            description: lessonDescription.trim(),
          }),
        },
      );
      if (lessonEdit === "new") setUploadLesson(String(next.id));
      setLessonEdit(null);
      setNotice(
        "Урок сохранён. Документы можно хранить в нём и использовать повторно.",
      );
      await refresh(true);
    } catch (cause) {
      setError(qtestsError(cause));
    } finally {
      setSavingLesson(false);
    }
  }
  async function removeLesson(id: number) {
    if (deletingLesson) return;
    setDeletingLesson(true);
    setError("");
    try {
      await api(`/qtests/lessons/${id}`, { method: "DELETE" });
      if (lessonFilter === String(id)) setLessonFilter("all");
      if (uploadLesson === String(id)) setUploadLesson("");
      if (lessonEdit === id) setLessonEdit(null);
      setConfirmLesson(null);
      setNotice(
        "Урок удалён. Его документы сохранены без урока, а результаты — в истории тренировок.",
      );
      await refresh(true);
    } catch (cause) {
      setError(qtestsError(cause));
    } finally {
      setDeletingLesson(false);
    }
  }
  async function startPractice(event: FormEvent) {
    event.preventDefault();
    if (!selectedPracticeBank || starting) return;
    setStarting(true);
    setError("");
    try {
      const attempt = await api<QTestsAttempt>(
        `/qtests/banks/${selectedPracticeBank.id}/attempts`,
        { method: "POST", body: JSON.stringify({ count: practiceCount }) },
      );
      router.push(`/qtests/attempts/${attempt.id}`);
    } catch (cause) {
      setError(qtestsError(cause));
      setStarting(false);
    }
  }

  const lessons = data?.lessons ?? [];
  const lessonBanks =
    data?.banks.filter((bank) =>
      lessonFilter === "all"
        ? true
        : lessonFilter === "unassigned"
          ? bank.lesson_id == null
          : bank.lesson_id === Number(lessonFilter),
    ) ?? [];
  const readyBanks = lessonBanks.filter(
    (bank) => bank.status === "ready" && bank.question_count > 0,
  );
  const selectedPracticeBank =
    readyBanks.find((bank) => String(bank.id) === practiceBank) ??
    readyBanks[0];
  const banks =
    lessonBanks.filter((bank) =>
      `${bank.title} ${bank.filename} ${bank.lesson_title ?? ""}`
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
      {notice && (
        <p className={styles.success} role="status">
          {notice}
        </p>
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
      <section className={styles.lessonPanel} aria-labelledby="lessons-title">
        <div className={styles.sectionTop}>
          <div>
            <p className={styles.eyebrow}>СОХРАНЁННЫЕ УЧЕБНЫЕ МАТЕРИАЛЫ</p>
            <h2 id="lessons-title">
              Мои уроки <span>{lessons.length}</span>
            </h2>
            <p className={styles.muted}>
              Загрузите Word один раз: документ и все вопросы останутся в уроке.
              Возвращайтесь к ним для новых тренировок или заменяйте документ.
            </p>
          </div>
          <button
            className={styles.secondary}
            onClick={() => editLesson()}
            disabled={savingLesson}
          >
            <Plus size={17} /> Создать урок
          </button>
        </div>
        <div className={styles.lessonList}>
          {lessons.map((lesson) => (
            <article key={lesson.id} className={styles.lessonCard}>
              <button
                className={styles.lessonChoose}
                aria-pressed={lessonFilter === String(lesson.id)}
                onClick={() => {
                  setLessonFilter(String(lesson.id));
                  setUploadLesson(String(lesson.id));
                  setPracticeBank("");
                }}
              >
                <FolderOpen size={21} />
                <span>
                  <strong>{lesson.title}</strong>
                  {lesson.description && <small>{lesson.description}</small>}
                  <small>
                    {lesson.bank_count} банков · {lesson.question_count}{" "}
                    вопросов
                  </small>
                </span>
              </button>
              <div className={styles.actions}>
                <button
                  className={styles.iconButton}
                  onClick={() => editLesson(lesson)}
                  aria-label={`Изменить урок «${lesson.title}»`}
                  disabled={savingLesson}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className={styles.iconButton}
                  onClick={() =>
                    setConfirmLesson(
                      confirmLesson === lesson.id ? null : lesson.id,
                    )
                  }
                  aria-label={`Удалить урок «${lesson.title}»`}
                  disabled={deletingLesson}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {confirmLesson === lesson.id && (
                <div className={styles.lessonConfirm} role="alert">
                  <p>
                    Удалить урок? Документы, вопросы и история сохранятся без
                    привязки к уроку.
                  </p>
                  <div className={styles.actions}>
                    <button
                      className={styles.dangerLink}
                      disabled={deletingLesson}
                      onClick={() => void removeLesson(lesson.id)}
                    >
                      {deletingLesson ? "Удаляем…" : "Удалить урок"}
                    </button>
                    <button
                      className={styles.textLink}
                      disabled={deletingLesson}
                      onClick={() => setConfirmLesson(null)}
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
          {data && lessons.length === 0 && (
            <p className={styles.muted}>
              Создайте первый урок, например «История» или «Математика». Уже
              загруженные банки доступны ниже и могут быть добавлены в урок.
            </p>
          )}
        </div>
        {lessonEdit !== null && (
          <form className={styles.lessonEditor} onSubmit={saveLesson}>
            <h3>{lessonEdit === "new" ? "Новый урок" : "Изменение урока"}</h3>
            <label className={styles.field}>
              Название урока
              <input
                autoFocus
                required
                maxLength={180}
                value={lessonTitle}
                onChange={(event) => setLessonTitle(event.target.value)}
                disabled={savingLesson}
                placeholder="Например, история Казахстана"
              />
            </label>
            <label className={styles.field}>
              Описание · необязательно
              <textarea
                maxLength={2000}
                value={lessonDescription}
                onChange={(event) => setLessonDescription(event.target.value)}
                disabled={savingLesson}
                placeholder="Что изучаем в этом уроке"
              />
            </label>
            <div className={styles.actions}>
              <button
                className={styles.primary}
                disabled={savingLesson || !lessonTitle.trim()}
              >
                {savingLesson ? "Сохраняем…" : "Сохранить урок"}
              </button>
              <button
                className={styles.secondary}
                type="button"
                disabled={savingLesson}
                onClick={() => setLessonEdit(null)}
              >
                Отмена
              </button>
            </div>
          </form>
        )}
      </section>
      <section
        className={styles.quickPractice}
        aria-labelledby="quick-practice-title"
      >
        <div>
          <p className={styles.eyebrow}>БЕЗ ПОВТОРНОЙ ЗАГРУЗКИ</p>
          <h2 id="quick-practice-title">Выберите урок и начните тест.</h2>
          <p className={styles.muted}>
            Новая случайная подборка из сохранённого банка. Правильные ответы
            учитываются после перемешивания вариантов.
          </p>
        </div>
        <form className={styles.practiceForm} onSubmit={startPractice}>
          <label className={styles.field}>
            Урок
            <select
              value={lessonFilter}
              onChange={(event) => {
                setLessonFilter(event.target.value);
                setPracticeBank("");
              }}
              disabled={starting}
            >
              <option value="all">Все уроки и банки</option>
              <option value="unassigned">Без урока</option>
              {lessons.map((lesson) => (
                <option key={lesson.id} value={lesson.id}>
                  {lesson.title}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Банк вопросов
            <select
              value={
                selectedPracticeBank ? String(selectedPracticeBank.id) : ""
              }
              onChange={(event) => setPracticeBank(event.target.value)}
              disabled={starting || !readyBanks.length}
              required
            >
              {readyBanks.length === 0 && (
                <option value="">Нет готовых банков</option>
              )}
              {readyBanks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.title} · {bank.question_count} вопросов
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Вопросов
            <input
              type="number"
              min={1}
              max={200}
              required
              value={practiceCount}
              onChange={(event) => setPracticeCount(Number(event.target.value))}
              disabled={starting}
            />
          </label>
          <button
            className={styles.primary}
            disabled={
              starting ||
              !selectedPracticeBank ||
              practiceCount < 1 ||
              practiceCount > 200
            }
          >
            {starting ? (
              <Loader2 size={17} className={styles.spinning} />
            ) : (
              <Shuffle size={17} />
            )}{" "}
            Начать тест
          </button>
        </form>
        {selectedPracticeBank &&
          practiceCount > selectedPracticeBank.question_count && (
            <p className={styles.fieldHint}>
              В банке {selectedPracticeBank.question_count} вопросов — в тест
              войдут все, без повторов.
            </p>
          )}
      </section>
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
          <form
            onSubmit={upload}
            className={styles.form}
            aria-label="Загрузка банка вопросов из Word"
            aria-busy={uploadBusy}
            onInvalid={(event) => {
              const field = event.target;
              setUploadError(
                field instanceof HTMLInputElement
                  ? field.validationMessage
                  : "Проверьте поля перед загрузкой Word.",
              );
            }}
          >
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
              <strong aria-live="polite">
                {file ? file.name : "Выберите или перетащите Word"}
              </strong>
              <span>
                {file
                  ? `${formatBytes(file.size)} · Можно выбрать другой файл`
                  : "DOCX · до 10 МБ"}
              </span>
              <span className={styles.fileLabel}>Документ Word</span>
              <input
                ref={input}
                id="qtests-file"
                name="file"
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                disabled={uploadBusy}
                aria-describedby="qtests-upload-feedback"
                aria-invalid={!!uploadError}
              />
            </label>
            <label className={styles.field}>
              Название банка
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={QTESTS_TITLE_LIMIT}
                placeholder="Например, история · итоговый экзамен"
                disabled={uploadBusy}
              />
            </label>
            <label className={styles.field}>
              Сохранить в урок
              <select
                value={uploadLesson}
                onChange={(event) => setUploadLesson(event.target.value)}
                disabled={uploadBusy}
              >
                <option value="">Пока без урока</option>
                {lessons.map((lesson) => (
                  <option key={lesson.id} value={lesson.id}>
                    {lesson.title}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Как указаны правильные ответы?
              <select
                value={answerMode}
                onChange={(e) =>
                  setAnswerMode(e.target.value as "first" | "marked")
                }
                disabled={uploadBusy}
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
            <div id="qtests-upload-feedback" className={styles.uploadFeedback}>
              {uploadError ? (
                <p className={styles.error} role="alert">
                  {uploadError}
                </p>
              ) : createdBankId !== null ? (
                <p className={styles.success} role="status">
                  Банк создан на сервере.{" "}
                  <Link href={`/qtests/banks/${createdBankId}`}>
                    Открыть банк и проверить вопросы
                  </Link>
                  .
                </p>
              ) : (
                <p className={styles.fieldHint} role="status">
                  {uploading
                    ? "Передаём Word на сервер. После загрузки откроется банк со статусом чтения документа."
                    : file
                      ? `Файл «${file.name}» выбран. Нажмите «Загрузить Word», чтобы сохранить его и извлечь вопросы.`
                      : "Сначала выберите файл, затем нажмите кнопку загрузки ниже. Поддерживается Word .docx."}
                </p>
              )}
            </div>
            <button
              type="submit"
              className={styles.primary}
              disabled={uploadBusy}
            >
              {uploading ? (
                <>
                  <Loader2 size={18} className={styles.spinning} /> Загружаем
                  документ…
                </>
              ) : (
                <>
                  Загрузить Word и создать банк <ArrowUpRight size={18} />
                </>
              )}
            </button>
            <button
              type="button"
              className={styles.textLink}
              onClick={() => void createManual()}
              disabled={uploadBusy}
            >
              {creatingManual
                ? "Создаём пустой банк…"
                : "Или создать пустой банк вручную"}{" "}
              <ArrowRight size={15} />
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
              <p className={styles.muted}>
                {lessonFilter === "all"
                  ? "Все сохранённые документы"
                  : lessonFilter === "unassigned"
                    ? "Банки без урока"
                    : lessons.find(
                        (lesson) => String(lesson.id) === lessonFilter,
                      )?.title}
              </p>
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
                    {bank.lesson_title || "Без урока"}
                    {bank.has_document && " · Word сохранён"}
                  </p>
                  <p>
                    {bank.question_count} вопросов <span>·</span>{" "}
                    {qtestsDate(bank.updated_at || bank.created_at)}
                  </p>
                  {bank.warnings?.length > 0 && (
                    <small>
                      {bank.warnings.length} предупреждений — проверьте банк
                    </small>
                  )}
                  {bank.replacement_status === "importing" && (
                    <small>Читаем новый Word · прежний банк доступен</small>
                  )}
                  {bank.replacement_status === "error" && (
                    <small>
                      Новый Word не импортирован · прежний банк сохранён
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
