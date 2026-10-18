"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { RotateCcw, Upload, UserRound } from "lucide-react";
import { api } from "@/lib/api";
import type { DeveloperDepartment } from "@/types/developers";
import { safeDirectorPhotoUrl } from "@/lib/branding";
import "./branding.css";

export default function DirectorPhotoUpload({
  department,
  onSaved,
}: {
  department: DeveloperDepartment;
  onSaved: (value: DeveloperDepartment) => void | Promise<void>;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const previewRef = useRef("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );
  const photo = safeDirectorPhotoUrl(department);
  function clear(resetInput = true) {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = "";
    setPreview("");
    setFile(null);
    if (resetInput && input.current) input.current.value = "";
  }
  function choose(selected: File | undefined) {
    clear(false);
    setError("");
    setNotice("");
    if (!selected) return;
    if (
      !/\.(?:png|jpe?g)$/i.test(selected.name) ||
      !selected.size ||
      selected.size > 2 * 1024 * 1024
    ) {
      if (input.current) input.current.value = "";
      setError("Выберите фотографию PNG или JPEG размером до 2 МБ.");
      return;
    }
    const url = URL.createObjectURL(selected);
    previewRef.current = url;
    setPreview(url);
    setFile(selected);
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || busy) {
      if (!file) setError("Сначала выберите фотографию.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = new FormData();
      body.set("file", file);
      await onSaved(
        await api<DeveloperDepartment>(
          `/branding/departments/${department.id}/director-photo`,
          { method: "PUT", body },
        ),
      );
      clear();
      setNotice(
        "Фотография опубликована на главной QForce и в справочнике команды.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить фотографию",
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await onSaved(
        await api<DeveloperDepartment>(
          `/branding/departments/${department.id}/director-photo`,
          { method: "DELETE" },
        ),
      );
      clear();
      setNotice(
        "Фотография убрана. Имя руководителя и логотип подразделения сохранены.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось убрать фотографию",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={upload}
      className="branding-upload"
      style={{ marginTop: 20 }}
    >
      <div
        style={{
          display: "flex",
          gap: 18,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            width: 96,
            height: 112,
            borderRadius: 16,
            overflow: "hidden",
            background: "#f2f3f5",
            display: "grid",
            placeItems: "center",
          }}
        >
          {preview || photo ? (
            <Image
              src={preview || photo!}
              alt={department.director || "Фото руководителя"}
              width={96}
              height={112}
              unoptimized
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <UserRound size={30} color="#9c9fa8" />
          )}
        </div>
        <div style={{ flex: "1 1 220px" }}>
          <label
            htmlFor={id}
            style={{ display: "block", fontWeight: 650, marginBottom: 8 }}
          >
            Фото руководителя
          </label>
          <input
            ref={input}
            id={id}
            className="field"
            type="file"
            accept=".png,.jpg,.jpeg,image/png,image/jpeg"
            disabled={busy}
            onChange={(event) => choose(event.target.files?.[0])}
          />
          <p className="muted" style={{ fontSize: 11, marginBlock: 8 }}>
            PNG или JPEG до 2 МБ. Прозрачный фон не требуется.
          </p>
          <div className="academic-actions">
            <button
              className="btn btn-secondary"
              type="submit"
              disabled={busy || !file}
            >
              <Upload size={14} />
              {busy ? "Сохраняем…" : "Опубликовать фото"}
            </button>
            {photo && (
              <button
                className="btn btn-secondary"
                type="button"
                disabled={busy}
                onClick={() => void remove()}
              >
                <RotateCcw size={14} />
                Убрать фото
              </button>
            )}
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" style={{ color: "#b13944", marginTop: 10 }}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" style={{ marginTop: 10, fontSize: 12 }}>
          {notice}
        </p>
      )}
    </form>
  );
}
