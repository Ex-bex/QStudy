"use client";
import { setActivity } from "@/lib/context";
import { useEffect, useRef, useState } from "react";
import { api, formatBytes, getToken, API_URL } from "@/lib/api";
import type { Material, Subject } from "@/types";
import { Mic, Square, Trash2, Music, Play, Loader2 } from "lucide-react";

export default function VoicePage() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [subjectId, setSubjectId] = useState("");
  const [files, setFiles] = useState<Material[]>([]);

  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [playingId, setPlayingId] = useState<number | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [loadingPlay, setLoadingPlay] = useState<number | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api<Subject[]>("/subjects").then(setSubjects).catch(() => {});
    api<Material[]>("/files")
      .then((all) => setFiles(all.filter((f) => f.file_type === "audio")))
      .catch(() => {});
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);
useEffect(() => { setActivity({ page: "review" }); }, []);
  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setSeconds(0);
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      alert("Нет доступа к микрофону. Разреши доступ в браузере и попробуй снова.");
    }
  }

  function stop() {
    recorderRef.current?.stop();
    setRecording(false);
    if (timer.current) clearInterval(timer.current);
  }

async function upload() {
  if (!audioUrl) return;
  setUploading(true);
  try {
    const blob = await (await fetch(audioUrl)).blob();
    const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
    // Имя без запрещённых символов (: / \ * ? " < > |)
    const stamp = new Date()
      .toLocaleString("ru", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      })
      .replace(/[:/\\*?"<>|]/g, "-");
    const fd = new FormData();
    fd.append("file", new File([blob], `Запись ${stamp}.${ext}`, { type: blob.type }));
    if (subjectId) fd.append("subject_id", subjectId);
    const material = await api<Material>("/files/upload", { method: "POST", body: fd });
    setFiles((prev) => [material, ...prev]);
    setAudioUrl(null);
  } catch (err: any) {
    alert(err.message);
  } finally {
    setUploading(false);
  }
}

  async function playSaved(f: Material) {
    if (playingId === f.id) {
      setPlayingId(null);
      setPlayingUrl(null);
      return;
    }
    setLoadingPlay(f.id);
    try {
      const res = await fetch(`${API_URL}/files/${f.id}/download`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error("Не удалось загрузить запись");
      setPlayingUrl(URL.createObjectURL(await res.blob()));
      setPlayingId(f.id);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setLoadingPlay(null);
    }
  }

  async function deleteFile(id: number) {
    if (!confirm("Удалить запись?")) return;
    await api(`/files/${id}`, { method: "DELETE" });
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold">Диктофон</h1>
      <p className="mb-8 text-gray-400">
        Записывай лекции с голоса. Позже ИИ расшифрует записи в текст.
      </p>

      {/* Запись */}
      <div className="mb-6 flex flex-col items-center rounded-2xl border border-gray-800 bg-gray-900 p-6">
        {recording ? (
          <>
            <button
              onClick={stop}
              className="flex h-20 w-20 animate-pulse items-center justify-center rounded-full bg-red-600 hover:bg-red-500"
            >
              <Square className="h-8 w-8" />
            </button>
            <p className="mt-3 font-mono text-xl text-red-400">{mm}:{ss}</p>
            <p className="text-xs text-gray-500">Идёт запись...</p>
          </>
        ) : (
          <>
            <button
              onClick={start}
              className="flex h-20 w-20 items-center justify-center rounded-full bg-indigo-600 hover:bg-indigo-500"
            >
              <Mic className="h-8 w-8" />
            </button>
            <p className="mt-3 text-sm text-gray-400">Нажми, чтобы начать запись</p>
          </>
        )}

        {audioUrl && !recording && (
          <div className="mt-5 w-full border-t border-gray-800 pt-5">
            <audio controls src={audioUrl} className="w-full" />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
                className="rounded-lg border border-gray-800 bg-gray-800 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
              >
                <option value="">Без предмета</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <button
                onClick={upload}
                disabled={uploading}
                className="flex items-center gap-1 rounded-lg bg-indigo-600 px-4 py-1.5 text-sm hover:bg-indigo-500 disabled:opacity-50"
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Сохранить
              </button>
              <button
                onClick={() => setAudioUrl(null)}
                className="rounded-lg bg-gray-800 px-4 py-1.5 text-sm hover:bg-gray-700"
              >
                Выбросить
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Сохранённые записи */}
      <h2 className="mb-3 font-semibold">Сохранённые записи</h2>
      <div className="space-y-2">
        {files.map((f) => (
          <div key={f.id} className="rounded-xl border border-gray-800 bg-gray-900 p-3">
            <div className="flex items-center gap-3">
              <Music className="h-5 w-5 shrink-0 text-indigo-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{f.filename}</div>
                <div className="text-xs text-gray-500">
                  {formatBytes(f.size)} · {new Date(f.created_at).toLocaleDateString("ru")}
                </div>
              </div>
              <button
                onClick={() => playSaved(f)}
                className="flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700"
              >
                {loadingPlay === f.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {playingId === f.id ? "Скрыть" : "Прослушать"}
              </button>
              <button onClick={() => deleteFile(f.id)} className="text-gray-500 hover:text-red-400">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            {playingId === f.id && playingUrl && (
              <audio controls autoPlay src={playingUrl} className="mt-3 w-full" />
            )}
          </div>
        ))}
        {files.length === 0 && (
          <p className="text-gray-500">Записей пока нет — запиши первую.</p>
        )}
      </div>
    </div>
  );
}