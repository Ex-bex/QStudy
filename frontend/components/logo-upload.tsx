"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { RotateCcw, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { ErrorNotice, errorMessage } from "@/components/academic";
import "./branding.css";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function LogoUpload<T>({
  title,
  currentUrl,
  custom,
  endpoint,
  onSaved,
}: {
  title: string;
  currentUrl: string;
  custom: boolean;
  endpoint: string;
  onSaved: (value: T) => void | Promise<void>;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const previewRef = useRef("");
  const choice = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(
    () => () => {
      choice.current += 1;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  function clearSelection() {
    choice.current += 1;
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = "";
    setPreview("");
    setFile(null);
    if (input.current) input.current.value = "";
  }
  async function selectFile(selected: File | undefined) {
    clearSelection();
    const selectedChoice = choice.current;
    setError("");
    setNotice("");
    if (!selected) return;
    if (selected.size > MAX_LOGO_BYTES || !selected.size) {
      setError("Выберите непустой PNG размером до 2 МБ.");
      return;
    }
    if (!/\.png$/i.test(selected.name)) {
      setError("Поддерживаются только PNG с прозрачным фоном.");
      return;
    }
    setChecking(true);
    try {
      const signature = new Uint8Array(
        await selected.slice(0, 8).arrayBuffer(),
      );
      if (choice.current !== selectedChoice) return;
      if (!PNG_SIGNATURE.every((value, index) => signature[index] === value)) {
        setError("Файл не является PNG. Экспортируйте логотип в формате PNG.");
        return;
      }
      const url = URL.createObjectURL(selected);
      previewRef.current = url;
      setPreview(url);
      setFile(selected);
    } catch {
      if (choice.current === selectedChoice)
        setError("Не удалось прочитать файл. Выберите его ещё раз.");
    } finally {
      if (choice.current === selectedChoice) setChecking(false);
    }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy || checking) return;
    setBusy(true);
    setError("");
    setNotice("");
    const body = new FormData();
    body.append("file", file);
    try {
      const value = await api<T>(endpoint, { method: "PUT", body });
      await onSaved(value);
      clearSelection();
      setNotice("Логотип обновлён.");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await api<T>(endpoint, { method: "DELETE" });
      await onSaved(value);
      clearSelection();
      setNotice("Восстановлен стандартный логотип.");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="branding-upload" aria-label={title} onSubmit={upload}>
      <div className="branding-upload-content">
        <div className="branding-logo-preview">
          <Image
            src={preview || currentUrl}
            alt={preview ? "Предпросмотр нового логотипа" : title}
            fill
            unoptimized
            sizes="100px"
            style={{ objectFit: "contain" }}
          />
        </div>
        <div className="branding-upload-fields">
          <label className="academic-field" htmlFor={inputId}>
            <span>{title}</span>
            <input
              ref={input}
              id={inputId}
              type="file"
              accept="image/png,.png"
              disabled={busy || checking}
              aria-describedby={`${inputId}-hint`}
              onChange={(event) => {
                void selectFile(event.currentTarget.files?.[0]);
              }}
            />
          </label>
          <p className="muted" id={`${inputId}-hint`}>
            PNG с прозрачным фоном, до 2 МБ. Размер от 32 до 4096 пикселей по
            каждой стороне.
          </p>
          {file && <p className="branding-file-name">{file.name}</p>}
          <div className="branding-upload-actions">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={!file || busy || checking}
            >
              <Upload size={15} aria-hidden="true" />{" "}
              {busy ? "Сохраняем…" : "Загрузить PNG"}
            </button>
            {custom && (
              <button
                className="btn btn-secondary"
                type="button"
                disabled={busy || checking}
                onClick={reset}
              >
                <RotateCcw size={15} aria-hidden="true" /> Стандартный логотип
              </button>
            )}
          </div>
        </div>
      </div>
      <ErrorNotice message={error} />
      <p className="branding-upload-notice" role="status" aria-live="polite">
        {checking ? "Проверяем PNG…" : notice}
      </p>
    </form>
  );
}
