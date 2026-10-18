"use client";

import { useState, type FormEvent } from "react";
import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import {
  optionLetter,
  qtestsError,
  type QTestsQuestionInput,
} from "@/lib/qtests";
import styles from "./qtests.module.css";

export default function QuestionEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: QTestsQuestionInput;
  onSave: (value: QTestsQuestionInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [options, setOptions] = useState(initial?.options ?? ["", "", "", ""]);
  const [correct, setCorrect] = useState(initial?.correct_index ?? 0);
  const [explanation, setExplanation] = useState(initial?.explanation ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  function removeOption(index: number) {
    setOptions((current) => current.filter((_, i) => i !== index));
    setCorrect((current) =>
      current === index ? 0 : current > index ? current - 1 : current,
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const trimmed = options.map((value) => value.trim());
    if (!question.trim() || trimmed.some((value) => !value)) {
      setError("Заполните вопрос и каждый вариант ответа.");
      return;
    }
    if (
      new Set(trimmed.map((value) => value.toLocaleLowerCase("ru"))).size !==
      trimmed.length
    ) {
      setError("Варианты ответа должны отличаться друг от друга.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave({
        question: question.trim(),
        options: trimmed,
        correct_index: correct,
        explanation: explanation.trim(),
      });
    } catch (cause) {
      setError(qtestsError(cause));
      setSaving(false);
    }
  }
  return (
    <form className={styles.editor} onSubmit={submit}>
      <label className={styles.field}>
        Вопрос
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          required
          maxLength={6000}
          rows={3}
          disabled={saving}
          autoFocus
        />
      </label>
      <fieldset className={styles.optionEditor}>
        <legend>
          Варианты ответа <span>Отметьте один правильный</span>
        </legend>
        {options.map((value, index) => (
          <div key={index}>
            <label
              className={`${styles.correctRadio} ${correct === index ? styles.radioSelected : ""}`}
            >
              <input
                type="radio"
                name="qtests-correct"
                value={index}
                checked={correct === index}
                onChange={() => setCorrect(index)}
                disabled={saving}
                aria-label={`${optionLetter(index)} — правильный ответ`}
              />
              <span>
                {correct === index ? <Check size={16} /> : optionLetter(index)}
              </span>
            </label>
            <label className={styles.optionText}>
              <span className={styles.srOnly}>
                Вариант {optionLetter(index)}
              </span>
              <textarea
                value={value}
                onChange={(e) =>
                  setOptions((current) =>
                    current.map((entry, i) =>
                      i === index ? e.target.value : entry,
                    ),
                  )
                }
                maxLength={2000}
                rows={2}
                required
                disabled={saving}
              />
            </label>
            <button
              type="button"
              className={styles.iconButton}
              disabled={saving || options.length <= 2}
              onClick={() => removeOption(index)}
              aria-label={`Удалить вариант ${optionLetter(index)}`}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </fieldset>
      {options.length < 10 && (
        <button
          type="button"
          className={styles.textLink}
          disabled={saving}
          onClick={() => setOptions((current) => [...current, ""])}
        >
          <Plus size={16} /> Добавить вариант
        </button>
      )}
      <label className={styles.field}>
        Объяснение <span className={styles.optional}>необязательно</span>
        <textarea
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
          maxLength={10000}
          rows={3}
          placeholder="Почему этот ответ правильный? Это объяснение увидите после ответа в тренировке."
          disabled={saving}
        />
      </label>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button className={styles.primary} disabled={saving} type="submit">
          {saving ? (
            <Loader2 size={16} className={styles.spinning} />
          ) : (
            <Check size={17} />
          )}{" "}
          Сохранить вопрос
        </button>
        <button
          className={styles.secondary}
          disabled={saving}
          type="button"
          onClick={onCancel}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}
