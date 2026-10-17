"use client";

import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Check,
  Download,
  LoaderCircle,
  Power,
  RefreshCw,
  Server,
  Settings2,
  Upload,
} from "lucide-react";
import { api, formatBytes } from "@/lib/api";
import {
  ErrorNotice,
  Loading,
  errorMessage,
  useResource,
} from "@/components/academic";
import ServerSettingsForm, { type ServerSettings } from "./ServerSettingsForm";
import { archiveSelectionError } from "@/lib/system-upload";
import styles from "./system.module.css";

type HostStatus = {
  managed: boolean;
  control_ready: boolean;
  status: string;
  mode: string;
  public_url: string;
  ports: { frontend: number; backend: number };
  data_source: string;
  checked_utc: string | null;
  generation?: number | null;
  last_action?: {
    id: string;
    action: string;
    status: string;
    code?: string;
  } | null;
};
type ImportPreview = {
  transfer_id: string;
  format: "backup" | "portable";
  created_at: string;
  counts: {
    accounts: number;
    groups: number;
    courses: number;
    documents: number;
    uploads: number;
  };
  upload_bytes: number;
  has_settings: boolean;
  settings_keys: string[];
  warnings: string[];
  expires_at: string;
};
type RequestedAction = {
  status: string;
  request_id: string;
  action: string;
  message: string;
};
type PendingOperation = "restart" | "stop" | "import";

function publicAddress(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export default function SystemPanel() {
  const {
    data: host,
    error: hostError,
    loading: hostLoading,
    reload: reloadHost,
  } = useResource<HostStatus>("/admin/system/status");
  const {
    data: settings,
    error: settingsError,
    loading: settingsLoading,
    reload: reloadSettings,
  } = useResource<ServerSettings>("/admin/system/settings");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [includeSettings, setIncludeSettings] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [controlConfirmation, setControlConfirmation] = useState<
    "restart" | "stop" | null
  >(null);
  const [operation, setOperation] = useState<PendingOperation | null>(null);
  const [operationMessage, setOperationMessage] = useState("");
  const [recoveryTimedOut, setRecoveryTimedOut] = useState(false);
  const operationGeneration = useRef<number | null>(null);
  const operationRequest = useRef<string | null>(null);
  const upload = useRef<XMLHttpRequest | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const canControl = Boolean(host?.managed && host.control_ready);
  const disabled = busy || operation !== null;
  const address = publicAddress(host?.public_url);

  useEffect(
    () => () => {
      upload.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!operation || operation === "stop") return;
    let active = true;
    let sawUnavailable = false;
    let inFlight = false;
    const began = Date.now();
    const check = async () => {
      if (inFlight || !active) return;
      if (Date.now() - began > 180_000) {
        setRecoveryTimedOut(true);
        return;
      }
      inFlight = true;
      try {
        const response = await fetch("/api/health", {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) sawUnavailable = true;
        else if (active) {
          const state = await fetch("/api/admin/system/status", {
            credentials: "same-origin",
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
          });
          if (state.status === 401) window.location.assign("/login");
          else if (state.ok) {
            const current: HostStatus = await state.json();
            if (
              current.last_action?.id === operationRequest.current &&
              current.last_action.status === "failed"
            ) {
              setOperation(null);
              setError(
                "Восстановление архива не завершилось. Проверьте сообщение в окне запуска хоста; повторно применять архив автоматически не будем.",
              );
              void reloadHost();
              return;
            }
            if (
              sawUnavailable ||
              (typeof operationGeneration.current === "number" &&
                typeof current.generation === "number" &&
                current.generation > operationGeneration.current)
            )
              window.location.assign("/login");
          }
        }
      } catch {
        sawUnavailable = true;
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => {
      void check();
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [operation, reloadHost]);

  function chooseFile(selected: File | null) {
    setPreview(null);
    setConfirmed(false);
    setError("");
    if (!selected) {
      setFile(null);
      return;
    }
    const invalid = archiveSelectionError(selected);
    if (invalid) {
      setError(invalid);
      setFile(null);
      return;
    }
    setFile(selected);
  }

  function inspectArchive() {
    if (!file || disabled) return;
    setBusy(true);
    setError("");
    setPreview(null);
    setConfirmed(false);
    setProgress(0);
    const request = new XMLHttpRequest();
    upload.current = request;
    request.open("POST", "/api/admin/system/imports");
    request.setRequestHeader("Content-Type", "application/zip");
    request.timeout = 30 * 60_000;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        setProgress(
          Math.min(100, Math.round((event.loaded * 100) / event.total)),
        );
    };
    const finish = () => {
      upload.current = null;
      setBusy(false);
      setProgress(null);
    };
    request.onload = () => {
      finish();
      let result: ImportPreview & { detail?: string };
      try {
        result = JSON.parse(request.responseText);
      } catch {
        setError("Сервер не смог проверить архив. Повторите загрузку.");
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        if (request.status === 401)
          window.dispatchEvent(new Event("qstudy:unauthorized"));
        setError(
          typeof result.detail === "string"
            ? result.detail
            : "Архив не принят. Проверьте его формат и повторите загрузку.",
        );
        return;
      }
      if (
        !result.transfer_id ||
        !result.counts ||
        !["backup", "portable"].includes(result.format)
      ) {
        setError(
          "Сервер вернул неполные сведения об архиве. Применение остановлено.",
        );
        return;
      }
      setPreview(result);
      setIncludeSettings(result.has_settings);
    };
    request.onerror = () => {
      finish();
      setError("Загрузка прервалась. Проверьте соединение и повторите её.");
    };
    request.ontimeout = () => {
      finish();
      setError(
        "Не удалось передать архив за отведённое время. Проверьте соединение.",
      );
    };
    request.onabort = () => {
      finish();
      setError("Загрузка отменена. Данные сайта не изменены.");
    };
    request.send(file);
  }

  async function requestAction(action: PendingOperation) {
    if (
      disabled ||
      !canControl ||
      (action === "import" && (!preview || !confirmed))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const currentHost = await api<HostStatus>("/admin/system/status");
      operationGeneration.current =
        typeof currentHost.generation === "number"
          ? currentHost.generation
          : null;
      const endpoint =
        action === "import"
          ? `/admin/system/imports/${encodeURIComponent(preview!.transfer_id)}/apply`
          : `/admin/system/${action}`;
      const result = await api<RequestedAction>(endpoint, {
        method: "POST",
        ...(action === "import"
          ? {
              body: JSON.stringify({
                include_settings: includeSettings && preview!.has_settings,
              }),
            }
          : {}),
      });
      operationRequest.current = result.request_id;
      setOperation(action);
      setOperationMessage(
        result.message ||
          (action === "stop"
            ? "Сайт останавливается. Все данные сохранены."
            : "Сайт перезапускается. После завершения войдите в аккаунт снова."),
      );
      setControlConfirmation(null);
      setRecoveryTimedOut(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.system}>
      <section aria-labelledby="host-heading" id="system-host">
        <div className="academic-section-heading">
          <h2 id="host-heading">
            <Server size={18} /> Работа и остановка сайта
          </h2>
          <button
            className="btn btn-secondary"
            disabled={disabled}
            onClick={() => {
              void reloadHost();
            }}
          >
            <RefreshCw size={15} /> Обновить
          </button>
        </div>
        <ErrorNotice message={hostError} />
        <div className={`panel ${styles.card}`}>
          {hostLoading && !host ? (
            <Loading />
          ) : (
            <>
              <div className={styles.summary}>
                <div>
                  <small>Режим доступа</small>
                  <strong>
                    {host?.mode === "internet"
                      ? "Из интернета"
                      : host?.mode === "lan"
                        ? "Локальная сеть"
                        : host?.mode === "local"
                          ? "Этот компьютер"
                          : "Текущий запуск"}
                  </strong>
                </div>
                <div>
                  <small>Данные</small>
                  <strong>
                    {host?.data_source || "Постоянное хранилище QStudy"}
                  </strong>
                </div>
                <div>
                  <small>Адрес сайта</small>
                  {address ? (
                    <a href={address} target="_blank" rel="noopener noreferrer">
                      {address}
                    </a>
                  ) : (
                    <strong>Текущий адрес браузера</strong>
                  )}
                </div>
              </div>
              {!canControl && (
                <p className={styles.note}>
                  Для остановки на компьютере хоста есть отдельный файл{" "}
                  <strong>Stop-QStudy.cmd</strong>. Управление из браузера
                  доступно при запуске через Start-QStudy.cmd,
                  Start-QStudy-LAN.cmd или Start-QStudy-Internet.cmd.
                </p>
              )}
              {host?.last_action?.status === "failed" && (
                <p className={styles.note}>
                  Последняя операция восстановления не завершилась. Проверьте
                  сообщение в окне запуска хоста перед повторной загрузкой
                  архива.
                </p>
              )}
              {settings?.restart_required && (
                <p className={styles.note}>
                  Сохранены новые настройки. Перезапустите сайт, чтобы применить
                  их.
                </p>
              )}
              <div className={styles.actions}>
                <button
                  className="btn btn-secondary"
                  disabled={!canControl || disabled}
                  onClick={() => setControlConfirmation("restart")}
                >
                  <RefreshCw size={15} /> Перезапустить
                </button>
                <button
                  className="btn btn-danger"
                  disabled={disabled}
                  onClick={() => setControlConfirmation("stop")}
                >
                  <Power size={15} /> Остановить сайт
                </button>
              </div>
              {controlConfirmation && (
                <div
                  className={styles.confirmation}
                  role="group"
                  aria-label="Подтверждение управления сайтом"
                >
                  <strong>
                    {controlConfirmation === "stop"
                      ? canControl
                        ? "Остановить QStudy и игру для всех пользователей?"
                        : "Как остановить сайт на этом хосте"
                      : "Перезапустить QStudy?"}
                  </strong>
                  <p>
                    {controlConfirmation === "stop"
                      ? canControl
                        ? "Завершатся работа сайта и все игровые комнаты. Аккаунты, материалы и настройки сохранятся. Чтобы включить сайт снова, откройте нужный Start-QStudy на компьютере хоста."
                        : "Откройте папку QStudy на компьютере хоста и дважды щёлкните Stop-QStudy.cmd. Если приложение запущено вручную в терминале или Docker, остановите именно этот запуск в его терминале или Docker Desktop. Данные сохранятся. Для последующего управления из браузера запустите сайт штатным Start-QStudy."
                      : "Сайт станет ненадолго недоступен. Данные и пароли аккаунтов сохранятся."}
                  </p>
                  <div className={styles.actions}>
                    {(canControl || controlConfirmation !== "stop") && (
                      <button
                        className="btn btn-primary"
                        disabled={disabled}
                        onClick={() => {
                          void requestAction(controlConfirmation);
                        }}
                      >
                        Подтвердить
                      </button>
                    )}
                    <button
                      className="btn btn-secondary"
                      disabled={disabled}
                      onClick={() => setControlConfirmation(null)}
                    >
                      {canControl ? "Отмена" : "Понятно"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {operation && (
        <div
          className={`panel ${styles.operation}`}
          role="status"
          aria-live="polite"
        >
          <LoaderCircle
            size={23}
            className={
              operation === "stop" || recoveryTimedOut ? "" : styles.spin
            }
          />
          <div>
            <strong>
              {operation === "stop"
                ? "Сайт останавливается"
                : recoveryTimedOut
                  ? "Запуск занимает больше времени"
                  : operation === "import"
                    ? "Переносим данные и перезапускаем сайт"
                    : "Перезапускаем сайт"}
            </strong>
            <p>{operationMessage}</p>
            {operation === "stop" ? (
              <p>
                Для следующего запуска откройте Start-QStudy.cmd,
                Start-QStudy-LAN.cmd или Start-QStudy-Internet.cmd на хосте.
              </p>
            ) : recoveryTimedOut ? (
              <p>
                Проверьте окно запуска на хосте. Когда сайт будет готов,{" "}
                <a href="/login">откройте страницу входа</a>.
              </p>
            ) : (
              <p>
                Страница входа откроется автоматически после готовности сайта.
              </p>
            )}
          </div>
        </div>
      )}
      <ErrorNotice message={error} />

      <section aria-labelledby="transfer-heading" id="system-transfer">
        <div className="academic-section-heading">
          <h2 id="transfer-heading">
            <Archive size={18} /> Данные и перенос
          </h2>
        </div>
        <div className={styles.transferGrid}>
          <div className={`panel ${styles.card}`}>
            <Download size={24} className={styles.cardIcon} />
            <h3>Скачать весь проект</h3>
            <p className={styles.caption}>
              Один ZIP с кодом проекта, аккаунтами, учебными материалами,
              загруженными файлами и настройками почты и ИИ.
            </p>
            <a
              className="btn btn-primary"
              href="/api/admin/system/exports/project/download"
              download
              aria-disabled={disabled}
              onClick={(e) => {
                if (disabled) e.preventDefault();
              }}
            >
              <Download size={16} /> Скачать полный ZIP
            </a>
            <p className={styles.caption}>
              Архив содержит приватные настройки. Храните его у себя и
              передавайте только владельцу нового хоста.
            </p>
          </div>
          <div className={`panel ${styles.card}`}>
            <Upload size={24} className={styles.cardIcon} />
            <h3>Загрузить проект или копию</h3>
            <p className={styles.caption}>
              Подойдёт полный ZIP QStudy или резервная копия с данными. Сначала
              проверим содержимое; текущий сайт при загрузке не изменяется.
            </p>
            <label className={styles.filePicker}>
              ZIP-файл до 2 ГБ
              <input
                ref={fileInput}
                type="file"
                accept=".zip,application/zip"
                disabled={disabled}
                onChange={(e) => chooseFile(e.target.files?.[0] || null)}
              />
            </label>
            {file && (
              <p className={styles.fileName}>
                {file.name} · {formatBytes(file.size)}
              </p>
            )}
            <div className={styles.actions}>
              <button
                className="btn btn-secondary"
                disabled={disabled || !file}
                onClick={inspectArchive}
              >
                {busy && progress !== null ? (
                  <LoaderCircle size={16} className={styles.spin} />
                ) : (
                  <Upload size={16} />
                )}
                Проверить архив
              </button>
              {progress !== null && (
                <button
                  className="btn btn-secondary"
                  onClick={() => upload.current?.abort()}
                >
                  Отменить
                </button>
              )}
            </div>
            {progress !== null && (
              <div className={styles.progress} role="status">
                <progress
                  max={100}
                  value={progress}
                  aria-label="Загрузка ZIP"
                />
                <span>
                  {progress < 100
                    ? `Передано ${progress}%`
                    : "Архив передан. Проверяем содержимое…"}
                </span>
              </div>
            )}
          </div>
        </div>
        {preview && (
          <div
            className={`panel ${styles.preview}`}
            aria-labelledby="preview-heading"
          >
            <div className={styles.previewHeading}>
              <Check size={20} />
              <div>
                <h3 id="preview-heading">Архив проверен</h3>
                <p>
                  {preview.format === "portable"
                    ? "Полный проект QStudy"
                    : "Резервная копия данных"}{" "}
                  · файлы: {formatBytes(preview.upload_bytes)}
                </p>
              </div>
            </div>
            <div className={styles.counts}>
              {[
                { key: "accounts", label: "Аккаунты" },
                { key: "groups", label: "Группы" },
                { key: "courses", label: "Дисциплины" },
                { key: "documents", label: "Документы" },
                { key: "uploads", label: "Файлы" },
              ].map((item) => (
                <div key={item.key}>
                  <strong>
                    {preview.counts[
                      item.key as keyof ImportPreview["counts"]
                    ] ?? 0}
                  </strong>
                  <small>{item.label}</small>
                </div>
              ))}
            </div>
            {preview.warnings?.map((warning, index) => (
              <p className={styles.note} key={index}>
                {warning}
              </p>
            ))}
            {preview.has_settings ? (
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={includeSettings}
                  onChange={(e) => setIncludeSettings(e.target.checked)}
                />
                Перенести настройки почты, ИИ и сервера из архива
              </label>
            ) : (
              <p className={styles.caption}>
                В архиве нет настроек сервера. Текущие настройки почты и ИИ
                сохранятся.
              </p>
            )}
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                disabled={disabled || !canControl}
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Понимаю, что восстановление заменит текущие аккаунты и материалы
              содержимым архива.
            </label>
            <div className={styles.actions}>
              <button
                className="btn btn-primary"
                disabled={disabled || !canControl || !confirmed}
                onClick={() => {
                  void requestAction("import");
                }}
              >
                <Archive size={16} /> Восстановить и перезапустить
              </button>
              <button
                className="btn btn-secondary"
                disabled={disabled}
                onClick={() => {
                  setPreview(null);
                  setConfirmed(false);
                }}
              >
                Отмена
              </button>
            </div>
            <p className={styles.caption}>
              После переноса войдите с аккаунтом из архива. Для восстановления
              требуется запущенное управление сайтом.
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="settings-heading">
        <details className={`panel ${styles.card}`}>
          <summary className={styles.settingsHeading}>
            <Settings2 size={18} />
            <h2 id="settings-heading">Настройки сервера</h2>
            <span className={styles.caption}>Почта · ИИ · доступ · копии</span>
          </summary>
          <ErrorNotice message={settingsError} />
          {settingsLoading && !settings ? (
            <Loading />
          ) : settings ? (
            <ServerSettingsForm
              initial={settings}
              disabled={disabled}
              onSaved={reloadSettings}
            />
          ) : (
            <p className={styles.caption}>
              Настройки недоступны. Обновите страницу после запуска сервера.
            </p>
          )}
        </details>
      </section>
    </div>
  );
}
