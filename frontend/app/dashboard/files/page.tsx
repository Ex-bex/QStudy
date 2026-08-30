"use client";
import { setActivity } from "@/lib/context";
import { useEffect, useRef, useState } from "react";
import { api, formatBytes } from "@/lib/api";
import type { Material, Subject, Topic } from "@/types";
import {
  Upload, Trash2, FileText, FileSpreadsheet, Image, Music, Video, File,
  CheckCircle2, Loader2, Sparkles, X, Copy,
} from "lucide-react";
const TYPE_ICONS: Record<string, any> = {
  pdf: FileText, docx: FileText, text: FileText,
  xlsx: FileSpreadsheet, pptx: FileText,
  image: Image, audio: Music, video: Video,
};

export default function FilesPage() {
  const [files, setFiles] = useState<Material[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [topicNames, setTopicNames] = useState<Record<number, string>>({});

  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [topics, setTopics] = useState<Topic[]>([]);

  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [processingId, setProcessingId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
const [viewing, setViewing] = useState<{ filename: string; text: string } | null>(null);
const [loadingText, setLoadingText] = useState<number | null>(null);
const [copied, setCopied] = useState(false);
  useEffect(() => {
    api<Material[]>("/files").then(setFiles).catch(() => {});
    (async () => {
      const subs = await api<Subject[]>("/subjects");
      setSubjects(subs);
      const map: Record<number, string> = {};
      for (const s of subs) {
        const ts = await api<Topic[]>(`/subjects/${s.id}/topics`);
        ts.forEach((t) => (map[t.id] = t.title));
      }
      setTopicNames(map);
    })().catch(() => {});
  }, []);

  useEffect(() => {
    setTopicId("");
    if (!subjectId) { setTopics([]); return; }
    api<Topic[]>(`/subjects/${subjectId}/topics`).then(setTopics).catch(() => {});
  }, [subjectId]);

  async function upload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        const fd = new FormData();
        fd.append("file", file);
        if (subjectId) fd.append("subject_id", subjectId);
        if (topicId) fd.append("topic_id", topicId);
        const material = await api<Material>("/files/upload", { method: "POST", body: fd });
        setFiles((prev) => [material, ...prev]);
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }
  useEffect(() => {
    setActivity({
      page: "files",
      subject: subjects.find((s) => s.id === Number(subjectId))?.name,
    });
  }, [subjectId, subjects]);
  async function deleteFile(id: number) {
    if (!confirm("Удалить файл?")) return;
    await api(`/files/${id}`, { method: "DELETE" });
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  async function processFile(f: Material) {
    setProcessingId(f.id);
    try {
      await api(`/files/${f.id}/process`, { method: "POST" });
      setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, processed: true } : x)));
    } catch (err: any) {
      alert(`ИИ не смог прочитать файл: ${err.message}`);
    } finally {
      setProcessingId(null);
    }
  }
async function viewText(f: Material) {
  setLoadingText(f.id);
  try {
    const data = await api<{ filename: string; text: string }>(`/files/${f.id}/text`);
    setViewing({ filename: data.filename, text: data.text });
    setCopied(false);
  } catch (err: any) {
    alert(err.message);
  } finally {
    setLoadingText(null);
  }
}

function copyText() {
  if (!viewing) return;
  navigator.clipboard.writeText(viewing.text);
  setCopied(true);
  setTimeout(() => setCopied(false), 1500);
}
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold">Файлы</h1>
      <p className="mb-8 text-gray-400">
        Загружай и жми «Обработать ИИ» — он прочитает документ, фото, запись или видео
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={subjectId}
          onChange={(e) => setSubjectId(e.target.value)}
          className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
        >
          <option value="">Без предмета</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select
          value={topicId}
          onChange={(e) => setTopicId(e.target.value)}
          disabled={!subjectId}
          className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm outline-none focus:border-indigo-500 disabled:opacity-40"
        >
          <option value="">Без темы</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>{t.title}</option>
          ))}
        </select>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        className={`mb-6 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-10 transition
          ${dragOver ? "border-indigo-500 bg-indigo-500/10" : "border-gray-700 hover:border-gray-500"}`}
      >
        {uploading ? (
          <Loader2 className="mb-2 h-8 w-8 animate-spin text-indigo-400" />
        ) : (
          <Upload className="mb-2 h-8 w-8 text-gray-500" />
        )}
        <p className="text-sm text-gray-400">
          {uploading ? "Загружаем..." : "Перетащи файлы сюда или кликни для выбора"}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,.ogg,.m4a,.webm,.mp4,.mov,.avi,.mkv,.txt,.md"
          onChange={(e) => upload(e.target.files)}
        />
      </div>

      <div className="space-y-2">
        {files.map((f) => {
          const Icon = TYPE_ICONS[f.file_type] || File;
          return (
            <div key={f.id} className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 p-3">
              <Icon className="h-5 w-5 shrink-0 text-indigo-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{f.filename}</div>
                <div className="text-xs text-gray-500">
                  {formatBytes(f.size)} · {new Date(f.created_at).toLocaleDateString("ru")}
                  {f.subject_id && ` · ${subjects.find((s) => s.id === f.subject_id)?.name ?? ""}`}
                  {f.topic_id && ` · ${topicNames[f.topic_id] ?? ""}`}
                </div>
              </div>

              {processingId === f.id ? (
  <span className="flex items-center gap-1 text-xs text-indigo-300">
    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Читаем...
  </span>
) : f.processed ? (
  <>
    <span className="flex items-center gap-1 text-xs text-green-400">
      <CheckCircle2 className="h-3.5 w-3.5" /> ИИ прочитал
    </span>
    <button
      onClick={() => viewText(f)}
      className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700"
    >
      {loadingText === f.id ? "..." : "Текст"}
    </button>
  </>
) : (
  <button
    onClick={() => processFile(f)}
    className="flex items-center gap-1 rounded-lg bg-indigo-600/90 px-3 py-1.5 text-xs hover:bg-indigo-500"
  >
    <Sparkles className="h-3.5 w-3.5" /> Обработать ИИ
  </button>
)}

              <button onClick={() => deleteFile(f.id)} className="text-gray-500 hover:text-red-400">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          );
        })}
        {files.length === 0 && <p className="text-gray-500">Файлов пока нет.</p>}
      </div>
      {viewing && (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    onClick={() => setViewing(null)}
  >
    <div
      className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-gray-700 bg-gray-900"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-gray-800 p-4">
        <h3 className="truncate pr-4 font-semibold">{viewing.filename}</h3>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={copyText}
            className="flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700"
          >
            <Copy className="h-3.5 w-3.5" /> {copied ? "Скопировано" : "Копировать"}
          </button>
          <button onClick={() => setViewing(null)} className="rounded-lg p-1.5 hover:bg-gray-800">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <pre className="flex-1 overflow-y-auto whitespace-pre-wrap p-4 text-sm leading-relaxed text-gray-300">
        {viewing.text || "(пусто)"}
      </pre>
      <div className="border-t border-gray-800 px-4 py-2 text-xs text-gray-500">
        Это текст, который ИИ извлёк и запомнил. Его используют Тренажёр и (скоро) чат.
      </div>
    </div>
  </div>
)}
    </div>
  );
}
