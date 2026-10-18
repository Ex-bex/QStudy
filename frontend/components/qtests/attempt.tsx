"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Check,
  CheckCircle2,
  ChevronRight,
  Flag,
  Lightbulb,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import { optionLetter, qtestsError, type QTestsAttempt } from "@/lib/qtests";
import styles from "./qtests.module.css";

type ExplanationResponse = {
  job_id: string | null;
  ai_available: boolean;
  attempt: QTestsAttempt;
};

export default function QTestsAttemptView({
  attemptId,
}: {
  attemptId: number;
}) {
  const [attempt, setAttempt] = useState<QTestsAttempt | null>(null);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [answering, setAnswering] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const initialized = useRef(false);
  const mutating = useRef(false);
  const questionHeading = useRef<HTMLHeadingElement>(null);
  const refresh = useCallback(async () => {
    if (mutating.current) return;
    const request = ++generation.current;
    try {
      const next = await api<QTestsAttempt>(`/qtests/attempts/${attemptId}`);
      if (request !== generation.current) return;
      setAttempt(next);
      setError("");
      if (!initialized.current) {
        const first =
          next.questions?.findIndex(
            (question) => question.user_index === null,
          ) ?? 0;
        setIndex(next.status === "active" && first >= 0 ? first : 0);
        initialized.current = true;
      }
    } catch (cause) {
      if (request === generation.current) setError(qtestsError(cause));
    }
  }, [attemptId]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void refresh();
    });
    const changed = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("qstudy:job", changed);
    window.addEventListener("focus", changed);
    return () => {
      active = false;
      invalidate();
      window.removeEventListener("qstudy:job", changed);
      window.removeEventListener("focus", changed);
    };
  }, [refresh, invalidate]);
  const pendingExplanations =
    attempt?.questions?.some(
      (question) => question.explanation_status === "pending",
    ) ?? false;
  useEffect(() => {
    if (!pendingExplanations) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 4000);
    return () => window.clearInterval(interval);
  }, [pendingExplanations, refresh]);
  const questions = attempt?.questions ?? [];
  const current = questions[index];
  const revealed = current?.correct_index !== undefined;
  const answered = current?.user_index !== null;
  const canAnswer =
    attempt?.status === "active" && current && !answered && !revealed;
  useEffect(() => {
    if (!canAnswer || answering || finishing) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      )
        return;
      const option = Number(event.key) - 1;
      if (/^[1-9]$/.test(event.key) && option < current.options.length) {
        event.preventDefault();
        setSelected(option);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [canAnswer, answering, finishing, current]);
  function goTo(next: number) {
    setIndex(next);
    setSelected(null);
    setNotice("");
    window.setTimeout(
      () => questionHeading.current?.focus({ preventScroll: true }),
      0,
    );
  }
  function nextQuestion() {
    const next = questions.findIndex(
      (question, i) => i > index && question.user_index === null,
    );
    if (next >= 0) goTo(next);
    else {
      const first = questions.findIndex(
        (question) => question.user_index === null,
      );
      if (first >= 0) goTo(first);
      else if (index < questions.length - 1) goTo(index + 1);
    }
  }
  async function answer() {
    if (!canAnswer || selected === null || mutating.current) return;
    mutating.current = true;
    generation.current++;
    setAnswering(true);
    setError("");
    try {
      const next = await api<QTestsAttempt>(
        `/qtests/attempts/${attemptId}/answer`,
        {
          method: "POST",
          body: JSON.stringify({
            question_id: current.id,
            answer_index: selected,
          }),
        },
      );
      generation.current++;
      setAttempt(next);
      setSelected(null);
      setNotice("Ответ сохранён.");
    } catch (cause) {
      setError(qtestsError(cause));
    } finally {
      mutating.current = false;
      setAnswering(false);
    }
  }
  async function finish() {
    if (mutating.current) return;
    mutating.current = true;
    generation.current++;
    setFinishing(true);
    setError("");
    try {
      const next = await api<QTestsAttempt>(
        `/qtests/attempts/${attemptId}/finish`,
        { method: "POST" },
      );
      generation.current++;
      setAttempt(next);
      setSelected(null);
      setConfirmFinish(false);
      setNotice("Тренировка завершена. Все ответы доступны для разбора.");
    } catch (cause) {
      setError(qtestsError(cause));
    } finally {
      mutating.current = false;
      setFinishing(false);
    }
  }
  async function explain() {
    if (explaining) return;
    setExplaining(true);
    setError("");
    try {
      const result = await api<ExplanationResponse>(
        `/qtests/attempts/${attemptId}/explanations`,
        { method: "POST" },
      );
      generation.current++;
      setAttempt(result.attempt);
      setNotice(
        result.job_id
          ? "ИИ готовит объяснения ошибок. Можно продолжать тренировку."
          : result.ai_available
            ? "Подробные объяснения уже готовы или задача временно недоступна. Попробуйте позже."
            : "ИИ пока не подключён. Сейчас доступен правильный ответ по ключу исходного банка.",
      );
    } catch (cause) {
      setError(qtestsError(cause));
    } finally {
      setExplaining(false);
    }
  }
  const remaining = Math.max(
    0,
    (attempt?.question_count ?? 0) - (attempt?.answered_count ?? 0),
  );
  const wrong = questions.filter(
    (question) =>
      question.user_index !== null &&
      question.correct_index !== undefined &&
      question.user_index !== question.correct_index,
  );
  const progress =
    attempt && attempt.question_count
      ? Math.round((attempt.answered_count * 100) / attempt.question_count)
      : 0;
  return (
    <main id="qtests-main" className={styles.workspace}>
      <Link href="/qtests/library" className={styles.backLink}>
        <ArrowLeft size={16} /> К моим тренировкам
      </Link>
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
      {!attempt ? (
        <div className={styles.empty} role="status">
          <Loader2 size={27} className={styles.spinning} />
          <h2>
            {error ? "Тренировка недоступна" : "Продолжаем с того же места…"}
          </h2>
          {error && (
            <button className={styles.secondary} onClick={() => void refresh()}>
              Повторить
            </button>
          )}
        </div>
      ) : (
        <>
          <div className={styles.attemptHeading}>
            <div>
              <p className={styles.eyebrow}>
                {attempt.status === "finished"
                  ? "РЕЗУЛЬТАТ / СОХРАНЁН"
                  : "ПРАКТИКА / ОТВЕТЫ СОХРАНЯЮТСЯ"}
              </p>
              <h1>{attempt.bank_title}</h1>
              <p className={styles.muted}>
                {attempt.status === "finished"
                  ? "Вернитесь к любому вопросу и разберите ответы."
                  : "Не спешите. Вы можете закрыть страницу и продолжить позже."}
              </p>
            </div>
            {attempt.status === "active" && (
              <button
                className={styles.secondary}
                onClick={() =>
                  remaining > 0 ? setConfirmFinish(true) : void finish()
                }
                disabled={answering || finishing}
              >
                <Flag size={16} />
                {finishing ? "Завершаем…" : "Завершить"}
              </button>
            )}
          </div>
          {confirmFinish && (
            <div className={styles.confirm} role="alert">
              <div>
                <strong>Завершить сейчас?</strong>
                <p>
                  Осталось {remaining} вопросов без ответа. После завершения
                  ответы изменить нельзя; пропущенные вопросы войдут в общий
                  результат.
                </p>
              </div>
              <div className={styles.actions}>
                <button
                  className={styles.primary}
                  onClick={() => void finish()}
                  disabled={finishing}
                >
                  {finishing ? "Сохраняем…" : "Завершить тренировку"}
                </button>
                <button
                  className={styles.secondary}
                  onClick={() => setConfirmFinish(false)}
                  disabled={finishing}
                >
                  Продолжить
                </button>
              </div>
            </div>
          )}
          {attempt.status === "finished" && (
            <section className={styles.resultPanel}>
              <div className={styles.resultScore}>
                <strong>
                  {attempt.score ?? 0}
                  <span>%</span>
                </strong>
                <span>правильных ответов</span>
              </div>
              <div>
                <p className={styles.eyebrow}>ВЫ ЗАКОНЧИЛИ ЭТУ ТРЕНИРОВКУ</p>
                <h2>
                  {attempt.correct_count === attempt.question_count
                    ? "Отлично. Вы разобрались!"
                    : "Ошибки — точки роста."}
                </h2>
                <p>
                  {attempt.correct_count} правильных · {wrong.length} ошибок
                  {remaining > 0 ? ` · ${remaining} без ответа` : ""} · всего{" "}
                  {attempt.question_count} вопросов
                </p>
                <div className={styles.actions}>
                  {attempt.bank_id && (
                    <Link
                      href={`/qtests/banks/${attempt.bank_id}`}
                      className={styles.primary}
                    >
                      <RotateCcw size={16} /> Новая случайная подборка
                    </Link>
                  )}
                  {wrong.length > 0 && (
                    <button
                      className={styles.secondary}
                      onClick={() =>
                        goTo(
                          questions.findIndex(
                            (question) => question.id === wrong[0].id,
                          ),
                        )
                      }
                    >
                      <BookOpenCheck size={17} /> К первой ошибке
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}
          <div className={styles.attemptLayout}>
            <section
              className={styles.questionPanel}
              aria-labelledby="attempt-question"
            >
              {current ? (
                <>
                  <div className={styles.questionPanelTop}>
                    <span>
                      ВОПРОС {index + 1} <b>/ {attempt.question_count}</b>
                    </span>
                    {current.user_index !== null ? (
                      <span
                        className={
                          current.user_index === current.correct_index
                            ? styles.correctText
                            : styles.wrongText
                        }
                      >
                        {current.user_index === current.correct_index ? (
                          <CheckCircle2 size={16} />
                        ) : (
                          <XCircle size={16} />
                        )}
                        {current.user_index === current.correct_index
                          ? "Верно"
                          : "Есть ошибка"}
                      </span>
                    ) : attempt.status === "finished" ? (
                      <span className={styles.muted}>Без ответа</span>
                    ) : (
                      <span className={styles.savedIndicator}>
                        <span /> Ответ ещё не выбран
                      </span>
                    )}
                  </div>
                  <h2
                    id="attempt-question"
                    ref={questionHeading}
                    tabIndex={-1}
                    className={styles.attemptQuestion}
                  >
                    {current.question}
                  </h2>
                  <div
                    className={styles.answerOptions}
                    role="group"
                    aria-label="Варианты ответа"
                  >
                    {current.options.map((option, optionIndex) => {
                      const correct =
                        revealed && optionIndex === current.correct_index;
                      const incorrect =
                        revealed &&
                        current.user_index === optionIndex &&
                        !correct;
                      return (
                        <button
                          key={`${current.id}-${optionIndex}`}
                          className={`${styles.answerOption} ${selected === optionIndex ? styles.selectedOption : ""} ${correct ? styles.rightAnswer : ""} ${incorrect ? styles.wrongAnswer : ""}`}
                          disabled={!canAnswer || answering || finishing}
                          aria-pressed={
                            !revealed ? selected === optionIndex : undefined
                          }
                          onClick={() => setSelected(optionIndex)}
                        >
                          <span>{optionLetter(optionIndex)}</span>
                          <p>{option}</p>
                          {correct ? (
                            <Check size={19} aria-label="Правильный ответ" />
                          ) : incorrect ? (
                            <X size={19} aria-label="Ваш неверный ответ" />
                          ) : (
                            <small>
                              {optionIndex < 9 ? optionIndex + 1 : ""}
                            </small>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {revealed && (
                    <aside className={styles.explanation}>
                      <div>
                        <Lightbulb size={19} />
                        <strong>
                          {current.user_index === current.correct_index
                            ? "Почему так"
                            : "Разберём ответ"}
                        </strong>
                        {current.explanation_status === "ai" && (
                          <span className={styles.badge}>
                            <Sparkles size={12} /> Объяснение ИИ
                          </span>
                        )}
                        {current.explanation_status === "source" && (
                          <span className={styles.badge}>Исходный банк</span>
                        )}
                      </div>
                      <p>
                        {current.explanation ||
                          "Правильный вариант указан по ключу исходного банка."}
                      </p>
                      {current.explanation_status === "pending" && (
                        <p className={styles.explanationPending} role="status">
                          <Loader2 size={14} className={styles.spinning} /> ИИ
                          готовит подробное объяснение. Оно появится здесь
                          автоматически.
                        </p>
                      )}
                      {current.explanation_status === "error" && (
                        <p className={styles.fieldHint}>
                          ИИ не смог завершить объяснение. Ваш ответ и ключ
                          сохранены.
                        </p>
                      )}
                      {current.user_index !== null &&
                        current.user_index !== current.correct_index &&
                        current.explanation_status !== "ai" &&
                        current.explanation_status !== "pending" && (
                          <button
                            className={styles.textLink}
                            onClick={() => void explain()}
                            disabled={explaining}
                          >
                            {explaining ? (
                              <Loader2 size={14} className={styles.spinning} />
                            ) : (
                              <Sparkles size={14} />
                            )}{" "}
                            Запросить подробный разбор ИИ
                          </button>
                        )}
                    </aside>
                  )}
                  <div className={styles.questionActions}>
                    {canAnswer ? (
                      <>
                        <span className={styles.fieldHint}>
                          Выберите вариант. Клавиши 1–9 тоже работают.
                        </span>
                        <button
                          className={styles.primary}
                          onClick={() => void answer()}
                          disabled={selected === null || answering || finishing}
                        >
                          {answering ? (
                            <Loader2 size={17} className={styles.spinning} />
                          ) : (
                            <Check size={17} />
                          )}{" "}
                          Проверить ответ
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className={styles.textLink}
                          onClick={() => goTo(index - 1)}
                          disabled={index === 0 || answering}
                        >
                          <ArrowLeft size={16} /> Предыдущий
                        </button>
                        {attempt.status === "active" && remaining === 0 ? (
                          <button
                            className={styles.primary}
                            onClick={() => void finish()}
                            disabled={finishing}
                          >
                            {finishing ? (
                              <Loader2 size={17} className={styles.spinning} />
                            ) : (
                              <Flag size={17} />
                            )}{" "}
                            Посмотреть результат
                          </button>
                        ) : (
                          <button
                            className={styles.primary}
                            onClick={() =>
                              attempt.status === "active"
                                ? nextQuestion()
                                : goTo(index + 1)
                            }
                            disabled={
                              attempt.status === "finished" &&
                              index >= questions.length - 1
                            }
                          >
                            {attempt.status === "active"
                              ? "Следующий вопрос"
                              : "Далее"}
                            <ArrowRight size={17} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </>
              ) : (
                <p className={styles.muted}>В этой тренировке нет вопросов.</p>
              )}
            </section>
            <aside className={styles.attemptSidebar}>
              <div className={styles.progressHeader}>
                <span>Ваш прогресс</span>
                <strong>
                  {attempt.answered_count} / {attempt.question_count}
                </strong>
              </div>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label="Отвеченные вопросы"
                aria-valuenow={attempt.answered_count}
                aria-valuemin={0}
                aria-valuemax={attempt.question_count}
              >
                <span style={{ width: `${progress}%` }} />
              </div>
              <div
                className={styles.questionMap}
                aria-label="Перейти к вопросу"
              >
                {questions.map((question, i) => (
                  <button
                    key={question.id}
                    className={`${i === index ? styles.currentMap : ""} ${question.user_index !== null ? (question.user_index === question.correct_index ? styles.correctMap : styles.wrongMap) : ""}`}
                    onClick={() => goTo(i)}
                    disabled={answering || finishing}
                    aria-current={i === index ? "step" : undefined}
                    aria-label={`Вопрос ${i + 1}${question.user_index === null ? ", без ответа" : question.user_index === question.correct_index ? ", верно" : ", ошибка"}`}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
              <div className={styles.mapLegend}>
                <span>
                  <i /> Без ответа
                </span>
                <span>
                  <i className={styles.correctLegend} /> Верно
                </span>
                <span>
                  <i className={styles.wrongLegend} /> Ошибка
                </span>
              </div>
              <p className={styles.sidebarNote}>
                Каждый ответ сохраняется на сервере. Вопросы и варианты в этой
                попытке останутся на своих местах после перезапуска.
              </p>
              {attempt.bank_id && (
                <Link
                  href={`/qtests/banks/${attempt.bank_id}`}
                  className={styles.textLink}
                >
                  Открыть исходный банк <ChevronRight size={15} />
                </Link>
              )}
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
