"use client";

import { useId, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import styles from "./password-input.module.css";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export default function PasswordInput({
  id,
  className = "field",
  disabled,
  ...props
}: PasswordInputProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const [visible, setVisible] = useState(false);
  const toggleLabel = visible ? "Скрыть пароль" : "Показать пароль";

  return (
    <span className={styles.wrapper}>
      <input
        {...props}
        id={inputId}
        className={`${className} ${styles.input}`}
        disabled={disabled}
        type={visible ? "text" : "password"}
      />
      <button
        className={styles.toggle}
        type="button"
        aria-label={toggleLabel}
        aria-controls={inputId}
        aria-pressed={visible}
        title={toggleLabel}
        disabled={disabled}
        onClick={() => setVisible((previous) => !previous)}
      >
        {visible ? (
          <EyeOff size={18} aria-hidden="true" />
        ) : (
          <Eye size={18} aria-hidden="true" />
        )}
      </button>
    </span>
  );
}
