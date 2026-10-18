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
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Download,
  FileText,
  FileUp,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shuffle,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  optionLetter,
  qtestsDate,
  qtestsError,
  type QTestsAttempt,
  type QTestsBank,
  type QTestsBankQuestion,
  type QTestsConfig,
  type QTestsImport,
  type QTestsLesson,
  type QTestsQuestionInput,
} from "@/lib/qtests";
import { qtestsDocumentError } from "@/lib/qtests-upload";
import QuestionEditor from "./question-editor";
import styles from "./qtests.module.css";

export default function QTestsBankView({ bankId }: { bankId: number }) {
  const router = useRouter();
  const [bank, setBank] = useState<QTestsBank | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [count, setCount] = useState(40);
  const [starting, setStarting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteQuestion, setDeleteQuestion] = useState<number | null>(null);
  const [busyQuestion, setBusyQuestion] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [rename, setRename] = useState(false);
  const [title, setTitle] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [lessons, setLessons] = useState<QTestsLesson[]>([]);
  const [savingLesson, setSavingLesson] = useState(false);
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [replacementMode, setReplacementMode] = useState<"first" | "marked">(
    "first",
  );
  const [replacing, setReplacing] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [replacementError, setReplacementError] = useState("");
  const replacementInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await api<QTestsBank>(`/qtests/banks/${bankId}`);
      if (request !== generation.current) return;
      setBank(next);
      setError("");
    } catch (cause) {
      if (request === generation.current) setError(qtestsError(cause));
    }
  }, [bankId]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void refresh();
    });
    void api<QTestsConfig>("/qtests/config")
      .then((config) => {
        if (active && typeof config.default_question_count === "number")
          setCount(config.default_question_count);
      })
      .catch(() => {});
    void api<QTestsLesson[]>(`/qtests/lessons?bank_id=${bankId}`)
      .then((next) => {
        if (active) setLessons(next);
      })
      .catch((cause) => {
        if (active) setError(qtestsError(cause));
      });
    const updated = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("qstudy:job", updated);
    window.addEventListener("focus", updated);
    return () => {
      active = false;
      invalidate();
      window.removeEventListener("qstudy:job", updated);
      window.removeEventListener("focus", updated);
    };
  }, [bankId, refresh, invalidate]);
  useEffect(() => {
    if (
      bank?.status !== "importing" &&
      bank?.replacement_status !== "importing"
    )
      return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 4000);
    return () => window.clearInterval(interval);
  }, [bank?.status, bank?.replacement_status, refresh]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (starting) return;
    setStarting(true);
    setError("");
    try {
      const attempt = await api<QTestsAttempt>(
        `/qtests/banks/${bankId}/attempts`,
        { method: "POST", body: JSON.stringify({ count }) },
      );
      router.push(`/qtests/attempts/${attempt.id}`);
    } catch (cause) {
      setError(qtestsError(cause));
      setStarting(false);
    }
  }
  async function retry() {
    setRetrying(true);
    setError("");
    try {
      const result = await api<QTestsImport>(`/qtests/banks/${bankId}/retry`, {
        method: "POST",
      });
      setBank((current) =>
        current
          ? { ...current, ...result.bank, questions: current.questions }
          : result.bank,
      );
      await refresh();
    } catch (cause) {
      setError(qtestsError(cause));
    } finally {
      setRetrying(false);
    }
  }
  async function saveTitle(event: FormEvent) {
    event.preventDefault();
    setSavingTitle(true);
    setError("");
    try {
      const next = await api<QTestsBank>(`/qtests/banks/${bankId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: title.trim() }),
      });
      setBank(next);
      setRename(false);
      setNotice("Название банка сохранено.");
    } catch (cause) {
      setError(qtestsError(cause));
    } finally {
      setSavingTitle(false);
    }
  }
  async function assignLesson(value: string) {
    if (savingLesson) return;
    setSavingLesson(true);
    setError("");
    try {
      await api<QTestsBank>(`/qtests/banks/${bankId}`, {
        method: "PATCH",
        body: JSON.stringify({ lesson_id: value ? Number(value) : null }),
      });
      await refresh();
      setNotice(
        value
          ? "Банк сохранён в выбранном уроке."
          : "Банк сохранён без привязки к уроку.",
      );
    } catch (cause) {
      setError(qtestsError(cause));
    } finally {
      setSavingLesson(false);
    }
  }
  function chooseReplacement(file: File | null) {
    setConfirmReplace(false);
    if (!file) {
      setReplacementFile(null);
      return;
    }
    const message = qtestsDocumentError(file);
    setReplacementError(message);
    if (message) {
      setReplacementFile(null);
      if (replacementInput.current) replacementInput.current.value = "";
      return;
    }
    setReplacementFile(file);
  }
  async function replaceDocument() {
    if (replacing) return;
    const message = qtestsDocumentError(replacementFile);
    if (message || !replacementFile) {
      setReplacementError(message);
      replacementInput.current?.focus();
      return;
    }
    setReplacing(true);
    setReplacementError("");
    try {
      const body = new FormData();
      body.set("file", replacementFile);
      body.set("answer_mode", replacementMode);
      const result = await api<QTestsImport>(
        `/qtests/banks/${bankId}/document`,
        {
          method: "POST",
          body,
        },
      );
      setBank((current) =>
        current
          ? { ...current, ...result.bank, questions: current.questions }
          : result.bank,
      );
      setConfirmReplace(false);
      setReplacementFile(null);
      if (replacementInput.current) replacementInput.current.value = "";
      setNotice(
        "Новый Word принят. Прежние вопросы останутся доступны, пока новый документ не будет успешно прочитан. История тренировок сохранится.",
      );
      await refresh();
    } catch (cause) {
      setReplacementError(qtestsError(cause));
    } finally {
      setReplacing(false);
    }
  }
  async function saveQuestion(value: QTestsQuestionInput) {
    const isNew = editing === "new";
    const next = await api<QTestsBankQuestion>(
      `/qtests/banks/${bankId}/questions${isNew ? "" : `/${editing}`}`,
      { method: isNew ? "POST" : "PATCH", body: JSON.stringify(value) },
    );
    setEditing(null);
    setNotice(
      isNew
        ? "Вопрос добавлен в банк."
        : "Изменения вопроса сохранены. Уже начатые тренировки сохранят свою версию.",
    );
    setBank((current) =>
      current
        ? {
            ...current,
            status: "ready",
            question_count: current.question_count + (isNew ? 1 : 0),
            questions: isNew
              ? [...(current.questions ?? []), next]
              : current.questions?.map((entry) =>
                  entry.id === next.id ? next : entry,
                ),
          }
        : current,
    );
  }
  async function removeQuestion(id: number) {
    setBusyQuestion(id);
    setError("");
    try {
      await api(`/qtests/banks/${bankId}/questions/${id}`, {
        method: "DELETE",
      });
      setBank((current) =>
        current
          ? {
              ...current,
              question_count: current.question_count - 1,
              questions: current.questions?.filter((entry) => entry.id !== id),
            }
          : current,
      );
      setDeleteQuestion(null);
      setNotice("Вопрос удалён. Ответы в прежних тренировках сохранены.");
    } catch (cause) {
      setError(qtestsError(cause));
    } finally {
      setBusyQuestion(null);
    }
  }
  async function removeBank() {
    setDeleting(true);
    setError("");
    try {
      await api(`/qtests/banks/${bankId}`, { method: "DELETE" });
      router.replace("/qtests/library");
    } catch (cause) {
      setError(qtestsError(cause));
      setDeleting(false);
    }
  }
  const questions = bank?.questions ?? [];
  const filtered = questions.filter((question) =>
    `${question.question} ${question.options.join(" ")}`
      .toLocaleLowerCase("ru")
      .includes(search.toLocaleLowerCase("ru")),
  );
  const pages = Math.ceil(filtered.length / 20);
  const activePage = Math.min(page, Math.max(0, pages - 1));
  const visible = filtered.slice(activePage * 20, activePage * 20 + 20);
  const editable =
    bank?.status !== "importing" && bank?.replacement_status !== "importing";
  return (
    <main id="qtests-main" className={styles.workspace}>
      <Link href="/qtests/library" className={styles.backLink}>
        <ArrowLeft size={16} /> К моим банкам
      </Link>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className={styles.success} role="status">
          <Check size={16} />
          {notice}
        </p>
      )}
      {!bank ? (
        <div className={styles.empty} role="status">
          <Loader2 size={27} className={styles.spinning} />
          <h2>{error ? "Банк недоступен" : "Открываем вопросы…"}</h2>
          {error && (
            <button onClick={() => void refresh()} className={styles.secondary}>
              Повторить
            </button>
          )}
        </div>
      ) : (
        <>
          <div className={styles.bankHeading}>
            <div>
              <p className={styles.eyebrow}>
                БАНК ВОПРОСОВ / {bank.question_count} ВОПРОСОВ
              </p>
              {rename ? (
                <form className={styles.renameForm} onSubmit={saveTitle}>
                  <label className={styles.field}>
                    <span className={styles.srOnly}>Название банка</span>
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      required
                      maxLength={200}
                      disabled={savingTitle}
                      autoFocus
                    />
                  </label>
                  <button
                    className={styles.iconButton}
                    disabled={savingTitle || !title.trim()}
                    aria-label="Сохранить название"
                  >
                    <Check size={19} />
                  </button>
                  <button
                    type="button"
                    className={styles.textLink}
                    onClick={() => setRename(false)}
                  >
                    Отмена
                  </button>
                </form>
              ) : (
                <div className={styles.titleLine}>
                  <h1>{bank.title}</h1>
                  <button
                    className={styles.iconButton}
                    onClick={() => {
                      setTitle(bank.title);
                      setRename(true);
                    }}
                    aria-label="Изменить название банка"
                  >
                    <Pencil size={17} />
                  </button>
                </div>
              )}
              <p className={styles.muted}>
                {bank.filename ? (
                  <>
                    <FileText size={14} /> {bank.filename} <span>·</span>{" "}
                  </>
                ) : (
                  "Создан вручную · "
                )}
                {qtestsDate(bank.created_at)}
              </p>
            </div>
            <button
              className={styles.dangerLink}
              onClick={() => setConfirmDelete((value) => !value)}
            >
              <Trash2 size={16} /> Удалить банк
            </button>
          </div>
          {confirmDelete && (
            <div className={styles.confirm} role="alert">
              <div>
                <strong>Удалить банк «{bank.title}»?</strong>
                <p>
                  Исходный документ и вопросы будут удалены. Результаты уже
                  начатых тренировок останутся в истории.
                </p>
              </div>
              <div className={styles.actions}>
                <button
                  className={styles.dangerButton}
                  disabled={deleting}
                  onClick={() => void removeBank()}
                >
                  {deleting ? "Удаляем…" : "Да, удалить"}
                </button>
                <button
                  className={styles.secondary}
                  disabled={deleting}
                  onClick={() => setConfirmDelete(false)}
                >
                  Отмена
                </button>
              </div>
            </div>
          )}
          <section
            className={styles.documentPanel}
            aria-labelledby="document-title"
          >
            <div className={styles.documentSummary}>
              <div>
                <p className={styles.eyebrow}>СОХРАНЁННЫЙ ИСТОЧНИК</p>
                <h2 id="document-title">Документ и урок</h2>
                <p className={styles.muted}>
                  {bank.has_document
                    ? "Word хранится на сервере вместе с банком. Для каждой новой тренировки загружать его заново не нужно."
                    : "Банк вопросов сохраняется на сервере. Здесь можно добавить исходный Word."}
                </p>
              </div>
              {bank.has_document && (
                <a
                  className={styles.secondary}
                  href={`/api/qtests/banks/${bankId}/document`}
                  download
                >
                  <Download size={16} /> Скачать Word
                </a>
              )}
            </div>
            <label className={styles.field}>
              Урок для этого банка
              <select
                value={bank.lesson_id == null ? "" : String(bank.lesson_id)}
                onChange={(event) => void assignLesson(event.target.value)}
                disabled={savingLesson || replacing}
              >
                <option value="">Без урока</option>
                {lessons.map((lesson) => (
                  <option key={lesson.id} value={lesson.id}>
                    {lesson.title}
                  </option>
                ))}
              </select>
            </label>
            <p className={styles.fieldHint}>
              Создавать и изменять уроки можно в{" "}
              <Link href="/qtests/library">библиотеке QTests</Link>. Один урок
              может содержать несколько банков.
            </p>
            <details className={styles.replaceDocument}>
              <summary>
                <FileUp size={17} />{" "}
                {bank.has_document
                  ? "Заменить Word в этом банке"
                  : "Добавить Word в этот банк"}
                <ChevronDown size={16} />
              </summary>
              <p className={styles.muted}>
                Новый документ заменит вопросы после успешного импорта. При
                ошибке прежний банк останется. Уже начатые тренировки и
                результаты сохранят свою версию вопросов.
              </p>
              <form
                className={styles.form}
                aria-label="Замена документа Word"
                aria-busy={replacing}
                onSubmit={(event) => {
                  event.preventDefault();
                  const message = qtestsDocumentError(replacementFile);
                  setReplacementError(message);
                  if (!message) setConfirmReplace(true);
                  else replacementInput.current?.focus();
                }}
              >
                <label className={styles.field}>
                  Новый документ .docx · до 10 МБ
                  <input
                    ref={replacementInput}
                    type="file"
                    accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    onChange={(event) =>
                      chooseReplacement(event.target.files?.[0] ?? null)
                    }
                    disabled={!editable || replacing}
                    aria-describedby="qtests-replacement-feedback"
                    aria-invalid={!!replacementError}
                  />
                </label>
                <label className={styles.field}>
                  Правильные ответы в новом документе
                  <select
                    value={replacementMode}
                    onChange={(event) => {
                      setReplacementMode(
                        event.target.value as "first" | "marked",
                      );
                      setConfirmReplace(false);
                    }}
                    disabled={!editable || replacing}
                  >
                    <option value="first">
                      Везде правильный первый вариант (A)
                    </option>
                    <option value="marked">
                      Правильные ответы отмечены в документе
                    </option>
                  </select>
                </label>
                <div
                  id="qtests-replacement-feedback"
                  className={styles.uploadFeedback}
                >
                  {replacementError ? (
                    <p className={styles.error} role="alert">
                      {replacementError}
                    </p>
                  ) : (
                    <p className={styles.fieldHint} role="status">
                      {replacing
                        ? "Передаём новый Word на сервер. Прежний документ и вопросы сохраняются до успешного чтения."
                        : replacementFile
                          ? `Выбран файл «${replacementFile.name}». Нажмите «Прочитать новый Word» и подтвердите замену.`
                          : "Выберите Word .docx. Прежний документ сохранится, если новый не удастся прочитать."}
                    </p>
                  )}
                </div>
                <button
                  className={styles.secondary}
                  disabled={!editable || replacing}
                >
                  <FileUp size={16} /> Прочитать новый Word
                </button>
              </form>
              {confirmReplace && replacementFile && (
                <div className={styles.confirm} role="alert">
                  <div>
                    <strong>
                      Обновить вопросы из «{replacementFile.name}»?
                    </strong>
                    <p>
                      После успешного чтения вопросы нового Word заменят текущий
                      банк целиком. Изменения, внесённые в вопросы вручную, не
                      переносятся. История тренировок останется.
                    </p>
                  </div>
                  <div className={styles.actions}>
                    <button
                      className={styles.primary}
                      onClick={() => void replaceDocument()}
                      disabled={replacing}
                    >
                      {replacing ? "Загружаем…" : "Да, обновить банк"}
                    </button>
                    <button
                      className={styles.secondary}
                      onClick={() => setConfirmReplace(false)}
                      disabled={replacing}
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              )}
            </details>
          </section>
          {bank.replacement_status === "importing" && (
            <section className={styles.importStatus} role="status">
              <Loader2 size={26} className={styles.spinning} />
              <div>
                <h2>Читаем новый Word</h2>
                <p>
                  {bank.replacement_filename || "Документ"}. Пока идёт импорт,
                  можно тренироваться по прежним вопросам. Редактирование
                  откроется после завершения; страницу можно закрыть.
                </p>
              </div>
            </section>
          )}
          {bank.replacement_status === "error" && (
            <section className={styles.importError} role="alert">
              <AlertTriangle size={25} />
              <div>
                <h2>Новый Word не удалось прочитать</h2>
                <p>
                  {bank.replacement_error ||
                    "Проверьте вопросы и варианты ответов в новом документе."}
                </p>
                <p>
                  Прежний документ, вопросы и результаты сохранены. Можно
                  продолжить практику, повторить импорт или выбрать исправленный
                  Word.
                </p>
                <button
                  className={styles.secondary}
                  onClick={() => void retry()}
                  disabled={retrying}
                >
                  {retrying ? (
                    <Loader2 size={16} className={styles.spinning} />
                  ) : (
                    <RefreshCw size={16} />
                  )}{" "}
                  Повторить импорт нового Word
                </button>
              </div>
            </section>
          )}
          {bank.status === "importing" && (
            <section className={styles.importStatus} role="status">
              <div className={styles.importOrb}>
                <Loader2 size={32} className={styles.spinning} />
              </div>
              <div>
                <p className={styles.eyebrow}>ДОКУМЕНТ ПРИНЯТ</p>
                <h2>Разбираем все ваши вопросы.</h2>
                <p>
                  QTests сохраняет банк целиком, а не только первые 40 вопросов.
                  Можно закрыть страницу: импорт продолжится на сервере и
                  восстановится после перезапуска.
                </p>
                <small>
                  Статус обновляется автоматически. Редактирование откроется
                  после завершения.
                </small>
              </div>
            </section>
          )}
          {bank.status === "error" && (
            <section className={styles.importError}>
              <AlertTriangle size={25} />
              <div>
                <h2>Не удалось завершить импорт</h2>
                <p>
                  {bank.error ||
                    "Проверьте формат вопросов в документе и повторите попытку."}
                </p>
                <p>
                  Нужны текст вопроса, не менее двух вариантов и однозначный
                  правильный ответ. Сканированные картинки сначала нужно
                  распознать.
                </p>
                {bank.filename && (
                  <button
                    className={styles.secondary}
                    onClick={() => void retry()}
                    disabled={retrying}
                  >
                    {retrying ? (
                      <Loader2 size={16} className={styles.spinning} />
                    ) : (
                      <RefreshCw size={16} />
                    )}{" "}
                    Повторить импорт
                  </button>
                )}
              </div>
            </section>
          )}
          {bank.warnings?.length > 0 && (
            <details className={styles.warnings}>
              <summary>
                <AlertTriangle size={17} /> Предупреждения при импорте (
                {bank.warnings.length})<ChevronDown size={17} />
              </summary>
              <p>
                Перед практикой проверьте эти места в документе. Пропущенные
                вопросы можно добавить вручную.
              </p>
              <ul>
                {bank.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          {bank.status === "ready" && (
            <section className={styles.startPanel}>
              <div>
                <p className={styles.eyebrow}>СВЕЖАЯ ПОДБОРКА, КАЖДЫЙ РАЗ</p>
                <h2>Проверим, что запомнилось?</h2>
                <p>
                  Вопросы без повторов. Варианты перемешаются отдельно в каждом
                  вопросе.
                </p>
              </div>
              <form onSubmit={start}>
                <label className={styles.field}>
                  Вопросов в тренировке
                  <input
                    type="number"
                    min={1}
                    max={200}
                    required
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                    disabled={starting}
                  />
                </label>
                <button
                  className={styles.primary}
                  disabled={
                    starting ||
                    bank.question_count === 0 ||
                    count < 1 ||
                    count > 200
                  }
                >
                  {starting ? (
                    <Loader2 size={17} className={styles.spinning} />
                  ) : (
                    <Shuffle size={17} />
                  )}{" "}
                  Начать {Math.min(count || 0, bank.question_count)} вопросов{" "}
                  <ArrowRight size={17} />
                </button>
              </form>
              {count > bank.question_count && bank.question_count > 0 && (
                <p className={styles.selectionHint}>
                  В банке {bank.question_count} вопросов — в эту тренировку
                  войдут все.
                </p>
              )}
            </section>
          )}
          <section
            className={styles.questionsSection}
            aria-labelledby="questions-title"
          >
            <div className={styles.sectionTop}>
              <div>
                <p className={styles.eyebrow}>СНАЧАЛА ПРОВЕРЬТЕ ИСТОЧНИК</p>
                <h2 id="questions-title">
                  Все вопросы <span>{bank.question_count}</span>
                </h2>
                <p className={styles.muted}>
                  Правильные ответы здесь видны для проверки банка. Во время
                  тренировки они скрыты до вашего ответа.
                </p>
              </div>
              <button
                className={styles.secondary}
                onClick={() => setEditing("new")}
                disabled={!editable || editing !== null}
              >
                <Plus size={17} /> Добавить вопрос
              </button>
            </div>
            {editing === "new" && (
              <div className={styles.newQuestion}>
                <h3>Новый вопрос</h3>
                <QuestionEditor
                  key="new"
                  onSave={saveQuestion}
                  onCancel={() => setEditing(null)}
                />
              </div>
            )}
            <label className={styles.search}>
              <Search size={17} />
              <span className={styles.srOnly}>Найти вопрос</span>
              <input
                placeholder="Поиск по вопросам и вариантам…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            {visible.length === 0 && editable && (
              <div className={styles.empty}>
                <FileText size={30} />
                <h3>{search ? "Ничего не найдено" : "Вопросов пока нет"}</h3>
                <p>
                  {search
                    ? "Измените поисковый запрос."
                    : "Добавьте первый вопрос вручную или загрузите другой документ в библиотеке."}
                </p>
              </div>
            )}
            <div className={styles.questionList}>
              {visible.map((question) => (
                <article key={question.id} className={styles.reviewQuestion}>
                  {editing === question.id ? (
                    <>
                      <h3>Редактирование вопроса {question.order + 1}</h3>
                      <QuestionEditor
                        key={question.id}
                        initial={question}
                        onSave={saveQuestion}
                        onCancel={() => setEditing(null)}
                      />
                    </>
                  ) : (
                    <>
                      <div className={styles.reviewHeading}>
                        <span className={styles.questionNumber}>
                          {String(question.order + 1).padStart(2, "0")}
                        </span>
                        <p>{question.question}</p>
                        <div>
                          <button
                            className={styles.iconButton}
                            disabled={!editable || editing !== null}
                            onClick={() => setEditing(question.id)}
                            aria-label={`Изменить вопрос ${question.order + 1}`}
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            className={styles.iconButton}
                            disabled={!editable || busyQuestion !== null}
                            onClick={() =>
                              setDeleteQuestion(
                                deleteQuestion === question.id
                                  ? null
                                  : question.id,
                              )
                            }
                            aria-label={`Удалить вопрос ${question.order + 1}`}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                      <ol className={styles.reviewOptions}>
                        {question.options.map((option, index) => (
                          <li
                            key={index}
                            className={
                              index === question.correct_index
                                ? styles.correctOption
                                : undefined
                            }
                          >
                            <span>{optionLetter(index)}</span>
                            <p>{option}</p>
                            {index === question.correct_index && (
                              <Check size={16} aria-label="Правильный ответ" />
                            )}
                          </li>
                        ))}
                      </ol>
                      {question.explanation && (
                        <details className={styles.sourceExplanation}>
                          <summary>
                            Объяснение из банка <ChevronDown size={14} />
                          </summary>
                          <p>{question.explanation}</p>
                        </details>
                      )}
                      {deleteQuestion === question.id && (
                        <div className={styles.inlineConfirm}>
                          <span>Удалить этот вопрос из банка?</span>
                          <button
                            className={styles.dangerLink}
                            disabled={busyQuestion === question.id}
                            onClick={() => void removeQuestion(question.id)}
                          >
                            {busyQuestion === question.id
                              ? "Удаляем…"
                              : "Удалить"}
                          </button>
                          <button
                            className={styles.textLink}
                            disabled={busyQuestion === question.id}
                            onClick={() => setDeleteQuestion(null)}
                          >
                            Отмена
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </article>
              ))}
            </div>
            {pages > 1 && (
              <nav className={styles.pagination} aria-label="Страницы вопросов">
                <button
                  className={styles.secondary}
                  disabled={activePage === 0}
                  onClick={() => setPage(activePage - 1)}
                >
                  <ArrowLeft size={16} /> Назад
                </button>
                <span>
                  {activePage + 1} из {pages} · {filtered.length} вопросов
                </span>
                <button
                  className={styles.secondary}
                  disabled={activePage >= pages - 1}
                  onClick={() => setPage(activePage + 1)}
                >
                  Далее <ArrowRight size={16} />
                </button>
              </nav>
            )}
          </section>
        </>
      )}
    </main>
  );
}
