"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Download,
  FileText,
  Mic,
  Music,
  Play,
  Save,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { api, API_URL, formatBytes } from "@/lib/api";
import { setActivity } from "@/lib/context";
import { useJobRefresh } from "@/lib/notifications";
import {
  useResource,
  PageTitle,
  ErrorNotice,
  Empty,
  Loading,
  RecordEditor,
  DeleteButton,
  errorMessage,
} from "@/components/academic";
import type { Material, Subject } from "@/types";

const MAX_SECONDS = 3600;
const MAX_BYTES = 25 * 1024 * 1024;
export default function VoicePage() {
  const { data: subjects } = useResource<Subject[]>("/subjects");
  const {
    data: materials,
    loading,
    error: loadError,
    reload,
  } = useResource<Material[]>("/files");
  useJobRefresh("file", reload);
  const files = materials?.filter((file) => file.file_type === "audio") || [];
  const [subjectId, setSubjectId] = useState("");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioExtension, setAudioExtension] = useState("webm");
  const [uploading, setUploading] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [processingId, setProcessingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const blob = useRef<Blob | null>(null);
  const bytes = useRef(0);
  const elapsed = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);
  const objectUrl = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    setActivity({ page: "voice" });
    return () => {
      mounted.current = false;
      if (timer.current) clearInterval(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);
  function discard() {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    blob.current = null;
    setAudioUrl(null);
    setSeconds(0);
  }
  function stop() {
    if (recorder.current?.state === "recording") recorder.current.stop();
    if (timer.current) clearInterval(timer.current);
    setRecording(false);
  }
  async function start() {
    setRequesting(true);
    setError("");
    setSuccess("");
    try {
      if (!window.isSecureContext)
        throw new Error(
          "Запись с микрофона недоступна при подключении по HTTP. Используйте текстовый ввод или загрузите аудиофайл в разделе файлов.",
        );
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(
          "Браузер не поддерживает запись. Можно загрузить готовую аудиозапись в разделе файлов.",
        );
      const capture = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      if (!mounted.current) {
        capture.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = capture;
      const captureRecorder = new MediaRecorder(capture);
      chunks.current = [];
      bytes.current = 0;
      elapsed.current = 0;
      captureRecorder.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.current.push(event.data);
          bytes.current += event.data.size;
          if (bytes.current >= MAX_BYTES) {
            stop();
            setError(
              "Достигнут лимит записи 25 МБ. Сохраните текущую запись и начните следующую.",
            );
          }
        }
      };
      captureRecorder.onstop = () => {
        capture.getTracks().forEach((track) => track.stop());
        if (timer.current) clearInterval(timer.current);
        if (!mounted.current) return;
        const recordingBlob = new Blob(chunks.current, {
          type: captureRecorder.mimeType || "audio/webm",
        });
        blob.current = recordingBlob;
        setAudioExtension(
          recordingBlob.type.includes("mp4")
            ? "m4a"
            : recordingBlob.type.includes("ogg")
              ? "ogg"
              : "webm",
        );
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        const url = URL.createObjectURL(recordingBlob);
        objectUrl.current = url;
        setAudioUrl(url);
        setRecording(false);
      };
      captureRecorder.start(1000);
      recorder.current = captureRecorder;
      setSeconds(0);
      setRecording(true);
      timer.current = setInterval(() => {
        elapsed.current += 1;
        setSeconds(elapsed.current);
        if (elapsed.current >= MAX_SECONDS) stop();
      }, 1000);
    } catch (e) {
      stream.current?.getTracks().forEach((track) => track.stop());
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Разрешите доступ к микрофону в браузере."
          : errorMessage(e),
      );
    } finally {
      setRequesting(false);
    }
  }
  async function upload() {
    const recordingBlob = blob.current;
    if (!recordingBlob) return;
    if (recordingBlob.size > MAX_BYTES) {
      setError(
        "Запись превышает 25 МБ. Скачайте её и разделите на части перед загрузкой.",
      );
      return;
    }
    setUploading(true);
    setError("");
    try {
      const extension = recordingBlob.type.includes("mp4")
        ? "m4a"
        : recordingBlob.type.includes("ogg")
          ? "ogg"
          : "webm";
      const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
      const form = new FormData();
      form.append(
        "file",
        new File([recordingBlob], `Запись-${stamp}.${extension}`, {
          type: recordingBlob.type,
        }),
      );
      if (subjectId) form.append("subject_id", subjectId);
      await api("/files/upload", { method: "POST", body: form });
      await reload();
      discard();
      setSuccess(
        "Запись сохранена. Нажмите «Расшифровать», чтобы получить текст.",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }
  async function process(file: Material) {
    setProcessingId(file.id);
    setError("");
    try {
      await api(`/files/${file.id}/process`, { method: "POST" });
      await reload();
      setSuccess("Запись расшифрована. Текст доступен в разделе файлов.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProcessingId(null);
    }
  }
  return (
    <div>
      <PageTitle
        eyebrow="СЛУШАТЬ И ЗАПОМИНАТЬ"
        title="Диктофон"
        description="Сохраните лекцию голосом, а затем превратите её в учебный текст."
      />
      <ErrorNotice message={error || loadError} />
      {success && (
        <p className="academic-success" role="status">
          {success}
        </p>
      )}
      <section
        className="panel"
        style={{ maxWidth: 800, margin: "0 auto 30px", padding: 32 }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 16,
          }}
        >
          <button
            className={`btn ${recording ? "btn-danger" : "btn-primary"}`}
            style={{ width: 78, height: 78, borderRadius: "50%" }}
            disabled={
              requesting || uploading || (Boolean(audioUrl) && !recording)
            }
            aria-label={recording ? "Остановить запись" : "Начать запись"}
            onClick={recording ? stop : start}
          >
            {recording ? <Square size={27} /> : <Mic size={28} />}
          </button>
          <strong
            style={{
              fontSize: 27,
              fontVariantNumeric: "tabular-nums",
              fontWeight: 500,
            }}
          >
            {String(Math.floor(seconds / 60)).padStart(2, "0")}:
            {String(seconds % 60).padStart(2, "0")}
          </strong>
          <p className="muted" style={{ fontSize: 12, textAlign: "center" }}>
            {recording
              ? "Идёт запись. Нажмите кнопку, чтобы остановить."
              : audioUrl
                ? "Прослушайте и сохраните запись."
                : "Нажмите, чтобы начать. До 60 минут или 25 МБ."}
          </p>
        </div>
        {audioUrl && !recording && (
          <div
            className="academic-stack"
            style={{
              borderTop: "1px solid #e7eae7",
              marginTop: 25,
              paddingTop: 25,
            }}
          >
            <audio controls src={audioUrl} style={{ width: "100%" }} />
            <label className="academic-field">
              <span>Предмет</span>
              <select
                className="field"
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
              >
                <option value="">Без предмета</option>
                {subjects?.map((subject) => (
                  <option value={subject.id} key={subject.id}>
                    {subject.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="academic-actions">
              <button
                className="btn btn-primary"
                disabled={uploading}
                onClick={upload}
              >
                <Save size={15} />
                {uploading ? "Сохраняем…" : "Сохранить"}
              </button>
              <a
                className="btn btn-secondary"
                href={audioUrl}
                download={`Запись.${audioExtension}`}
              >
                <Download size={15} /> Скачать
              </a>
              <button
                className="btn btn-secondary"
                disabled={uploading}
                onClick={discard}
              >
                <X size={15} /> Отменить
              </button>
            </div>
          </div>
        )}
      </section>
      <div className="academic-section-heading">
        <h2>Мои записи</h2>
        <Link href="/dashboard/files" className="btn btn-secondary">
          <FileText size={15} /> Все файлы
        </Link>
      </div>
      {loading ? (
        <Loading />
      ) : files.length ? (
        <div className="academic-stack">
          {files.map((file) => (
            <article className="panel" key={file.id}>
              <div className="academic-file" style={{ padding: 0 }}>
                <div className="academic-card-icon">
                  <Music size={20} />
                </div>
                <div className="academic-file-info">
                  <h3>{file.filename}</h3>
                  <p className="academic-meta" style={{ marginTop: 6 }}>
                    {formatBytes(file.size)} ·{" "}
                    {new Date(file.created_at).toLocaleDateString("ru-RU")}
                  </p>
                </div>
                <div className="academic-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={() =>
                      setPlayingId(playingId === file.id ? null : file.id)
                    }
                  >
                    <Play size={14} />
                    {playingId === file.id ? "Скрыть" : "Прослушать"}
                  </button>
                  {!file.processed && (
                    <button
                      className="btn btn-secondary"
                      disabled={processingId !== null}
                      onClick={() => process(file)}
                    >
                      <Sparkles size={14} />
                      {processingId === file.id
                        ? "Распознаём…"
                        : "Расшифровать"}
                    </button>
                  )}
                  <RecordEditor
                    compact
                    title="Переименовать запись"
                    fields={[
                      { name: "filename", label: "Название", required: true },
                    ]}
                    initial={{ filename: file.filename }}
                    method="PATCH"
                    endpoint={`/files/${file.id}`}
                    onSaved={reload}
                  />
                  <DeleteButton
                    title="Удалить запись?"
                    disabled={processingId === file.id}
                    endpoint={`/files/${file.id}`}
                    onDeleted={async () => {
                      if (playingId === file.id) setPlayingId(null);
                      await reload();
                    }}
                  />
                </div>
              </div>
              {playingId === file.id && (
                <audio
                  controls
                  autoPlay
                  preload="metadata"
                  src={`${API_URL}/files/${file.id}/download`}
                  onError={() =>
                    setError(
                      "Не удалось воспроизвести запись. Попробуйте скачать её в разделе файлов.",
                    )
                  }
                  style={{ width: "100%", marginTop: 20 }}
                />
              )}
            </article>
          ))}
        </div>
      ) : (
        <Empty title="Записей пока нет">
          Запишите первую лекцию или загрузите готовое аудио в разделе файлов.
        </Empty>
      )}
    </div>
  );
}
