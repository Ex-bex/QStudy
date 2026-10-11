"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  Check,
  Copy,
  Download,
  FileText,
  FileUp,
  Pencil,
  Search,
  Sparkles,
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
  Modal,
  DeleteButton,
  errorMessage,
} from "@/components/academic";
import type { Material, Subject, Topic } from "@/types";

function FileEditor({
  file,
  subjects,
  onSaved,
}: {
  file: Material;
  subjects: Subject[];
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [subjectId, setSubjectId] = useState(String(file.subject_id || ""));
  const [topicId, setTopicId] = useState(String(file.topic_id || ""));
  const { data: topics } = useResource<Topic[]>(
    open && subjectId ? `/subjects/${subjectId}/topics` : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(`/files/${file.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          filename: form.get("filename"),
          subject_id: subjectId ? Number(subjectId) : null,
          topic_id: topicId ? Number(topicId) : null,
        }),
      });
      await onSaved();
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="academic-icon-button"
        aria-label={`Редактировать ${file.filename}`}
        title="Редактировать файл"
        onClick={() => {
          setSubjectId(String(file.subject_id || ""));
          setTopicId(String(file.topic_id || ""));
          setError("");
          setOpen(true);
        }}
      >
        <Pencil size={16} />
      </button>
      {open && (
        <Modal
          title="Редактировать файл"
          close={() => setOpen(false)}
          busy={busy}
        >
          <form onSubmit={save}>
            <div className="academic-fields">
              <label className="academic-field">
                <span>Название файла</span>
                <input
                  className="field"
                  name="filename"
                  required
                  maxLength={180}
                  defaultValue={file.filename}
                />
              </label>
              <label className="academic-field">
                <span>Предмет</span>
                <select
                  className="field"
                  value={subjectId}
                  onChange={(e) => {
                    setSubjectId(e.target.value);
                    setTopicId("");
                  }}
                >
                  <option value="">Без предмета</option>
                  {subjects.map((subject) => (
                    <option value={subject.id} key={subject.id}>
                      {subject.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="academic-field">
                <span>Тема</span>
                <select
                  className="field"
                  value={topicId}
                  onChange={(e) => setTopicId(e.target.value)}
                  disabled={!subjectId}
                >
                  <option value="">Без темы</option>
                  {subjectId &&
                    topics?.map((topic) => (
                      <option value={topic.id} key={topic.id}>
                        {topic.title}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <ErrorNotice message={error} />
            <div className="academic-form-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Отмена
              </button>
              <button className="btn btn-primary" disabled={busy}>
                {busy ? "Сохраняем…" : "Сохранить"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export default function FilesPage() {
  const {
    data: files,
    loading,
    error: loadError,
    reload,
    setData: setFiles,
  } = useResource<Material[]>("/files");
  useJobRefresh("file", reload);
  const { data: subjects, error: subjectError } =
    useResource<Subject[]>("/subjects");
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const { data: topics } = useResource<Topic[]>(
    subjectId ? `/subjects/${subjectId}/topics` : null,
  );
  const [query, setQuery] = useState("");
  const [uploading, setUploading] = useState(false);
  const [processingId, setProcessingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<{
    filename: string;
    text: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setActivity({
      page: "files",
      subject: subjects?.find((subject) => subject.id === Number(subjectId))
        ?.name,
    });
  }, [subjectId, subjects]);
  async function upload(list: FileList | null) {
    if (!list?.length || uploading) return;
    setUploading(true);
    setError("");
    try {
      for (const file of Array.from(list)) {
        if (!file.size) throw new Error(`Файл «${file.name}» пустой.`);
        const form = new FormData();
        form.append("file", file);
        if (subjectId) form.append("subject_id", subjectId);
        if (topicId) form.append("topic_id", topicId);
        const result = await api<Material>("/files/upload", {
          method: "POST",
          body: form,
        });
        setFiles((previous) => [result, ...(previous || [])]);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function processFile(file: Material) {
    setProcessingId(file.id);
    setError("");
    try {
      await api(`/files/${file.id}/process`, { method: "POST" });
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProcessingId(null);
    }
  }
  async function readText(file: Material) {
    setError("");
    try {
      setViewing(
        await api<{ filename: string; text: string }>(`/files/${file.id}/text`),
      );
      setCopied(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function copy() {
    if (!viewing) return;
    try {
      await navigator.clipboard.writeText(viewing.text);
      setCopied(true);
    } catch {
      setError(
        "Не удалось скопировать текст. Выделите его и скопируйте вручную.",
      );
    }
  }
  const filtered =
    files?.filter((file) =>
      file.filename.toLowerCase().includes(query.toLowerCase()),
    ) || [];
  return (
    <div>
      <PageTitle
        eyebrow="ЛИЧНАЯ БИБЛИОТЕКА"
        title="Учебные файлы"
        description="Конспекты, документы и записи, на которые может опираться ваш ИИ-помощник."
      >
        <Link href="/dashboard/syllabi" className="btn btn-secondary">
          Учебные силабусы
        </Link>
      </PageTitle>
      <div className="panel" style={{ padding: 25, marginBottom: 25 }}>
        <div className="form-grid" style={{ marginBottom: 19 }}>
          <label className="academic-field">
            <span>Предмет для новых файлов</span>
            <select
              className="field"
              value={subjectId}
              onChange={(e) => {
                setSubjectId(e.target.value);
                setTopicId("");
              }}
            >
              <option value="">Без предмета</option>
              {subjects?.map((subject) => (
                <option value={subject.id} key={subject.id}>
                  {subject.name}
                </option>
              ))}
            </select>
          </label>
          <label className="academic-field">
            <span>Тема</span>
            <select
              className="field"
              value={topicId}
              disabled={!subjectId}
              onChange={(e) => setTopicId(e.target.value)}
            >
              <option value="">Без темы</option>
              {subjectId &&
                topics?.map((topic) => (
                  <option value={topic.id} key={topic.id}>
                    {topic.title}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label
          className="academic-upload"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void upload(e.dataTransfer.files);
          }}
        >
          <FileUp size={28} color="#6b8d64" />
          <strong>
            {uploading
              ? "Загружаем файлы…"
              : "Перетащите файлы или выберите с устройства"}
          </strong>
          <input
            ref={fileInput}
            type="file"
            multiple
            disabled={uploading}
            accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,.ogg,.m4a,.webm,.mp4,.mov,.avi,.mkv,.txt,.md"
            onChange={(e) => void upload(e.target.files)}
          />
          <p>
            Документы, изображения, аудио и видео. После загрузки обработайте
            материал, чтобы использовать его в чате и тренажёре.
          </p>
        </label>
      </div>
      <ErrorNotice message={error || loadError || subjectError} />
      <div className="academic-filter">
        <label className="academic-field" style={{ width: "min(100%,380px)" }}>
          <span className="sr-only">Поиск файла</span>
          <div style={{ position: "relative" }}>
            <Search
              size={16}
              style={{
                position: "absolute",
                left: 13,
                top: 14,
                color: "#849080",
              }}
            />
            <input
              className="field"
              style={{ paddingLeft: 38, width: "100%" }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Найти файл"
            />
          </div>
        </label>
        <span className="muted" style={{ fontSize: 12 }}>
          {files?.length || 0} файлов
        </span>
      </div>
      {loading ? (
        <Loading />
      ) : filtered.length ? (
        <div className="academic-stack">
          {filtered.map((file) => (
            <article className="panel academic-file" key={file.id}>
              <div className="academic-card-icon">
                <FileText size={22} />
              </div>
              <div className="academic-file-info">
                <h3>{file.filename}</h3>
                <p className="academic-meta" style={{ marginTop: 6 }}>
                  {formatBytes(file.size)} ·{" "}
                  {new Date(file.created_at).toLocaleDateString("ru-RU")}
                  {file.subject_id
                    ? ` · ${subjects?.find((subject) => subject.id === file.subject_id)?.name || ""}`
                    : ""}
                </p>
              </div>
              <div className="academic-actions">
                {file.processed ? (
                  <>
                    <span className="badge">
                      <Check size={12} /> Прочитан
                    </span>
                    <button
                      className="btn btn-secondary"
                      onClick={() => readText(file)}
                    >
                      Текст
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-secondary"
                    disabled={processingId !== null}
                    onClick={() => processFile(file)}
                  >
                    <Sparkles size={15} />
                    {processingId === file.id ? "Читаем…" : "Обработать"}
                  </button>
                )}
                <a
                  className="academic-icon-button"
                  title="Скачать файл"
                  aria-label={`Скачать ${file.filename}`}
                  href={`${API_URL}/files/${file.id}/download`}
                  download
                >
                  <Download size={16} />
                </a>
                <FileEditor
                  file={file}
                  subjects={subjects || []}
                  onSaved={reload}
                />
                <DeleteButton
                  title={`Удалить «${file.filename}»?`}
                  endpoint={`/files/${file.id}`}
                  onDeleted={reload}
                />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty title={query ? "Файл не найден" : "Библиотека пока пуста"}>
          {query
            ? "Попробуйте другое название."
            : "Загрузите материалы, чтобы использовать их в учебном пространстве."}
        </Empty>
      )}
      {viewing && (
        <Modal title={viewing.filename} close={() => setViewing(null)}>
          <div className="academic-syllabus-text" style={{ maxHeight: "55vh" }}>
            {viewing.text ||
              "Текст не найден. Для сканов может потребоваться распознавание."}
          </div>
          <div className="academic-form-actions">
            <button className="btn btn-secondary" onClick={copy}>
              <Copy size={15} />
              {copied ? "Скопировано" : "Копировать"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
