"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Download, ExternalLink, Smartphone, X } from "lucide-react";
import {
  pwaAppForPath,
  pwaIconUrl,
  pwaManifestUrl,
  type PwaApp,
} from "@/lib/pwa";
import styles from "./app-install.module.css";

type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
type InstallState = {
  app: PwaApp;
  prompt: InstallPrompt | null;
  secure: boolean | null;
  installed: boolean;
  ios: boolean;
  reloadRequired: boolean;
  clearPrompt(): void;
};
const InstallContext = createContext<InstallState | null>(null);

export function AppInstallProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const app = pwaAppForPath(pathname, search.get("next"));
  const [initialApp] = useState(app.id);
  const currentApp = useRef(app.id);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [secure, setSecure] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const reloadRequired = initialApp !== app.id;

  useEffect(() => {
    currentApp.current = app.id;
    setPrompt(null);
    const manifest = pwaManifestUrl(app.id);
    const links = [
      ...document.head.querySelectorAll<HTMLLinkElement>(
        'link[rel="manifest"]',
      ),
    ];
    const link = links.shift() || document.createElement("link");
    link.rel = "manifest";
    link.href = manifest;
    link.crossOrigin = "anonymous";
    if (!link.parentNode) document.head.appendChild(link);
    for (const duplicate of links) duplicate.remove();
    const icons = [
      ...document.head.querySelectorAll<HTMLLinkElement>(
        'link[rel="apple-touch-icon"]',
      ),
    ];
    const apple = icons.shift() || document.createElement("link");
    apple.rel = "apple-touch-icon";
    apple.href = pwaIconUrl(app.id, 180);
    apple.type = "image/png";
    apple.sizes = "180x180";
    if (!apple.parentNode) document.head.appendChild(apple);
    for (const duplicate of icons) duplicate.remove();
    let theme = document.head.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (!theme) {
      theme = document.createElement("meta");
      theme.name = "theme-color";
      document.head.appendChild(theme);
    }
    theme.content = app.color;
    for (const [name, content] of [
      ["apple-mobile-web-app-title", app.shortName],
      ["mobile-web-app-capable", "yes"],
    ]) {
      let meta = document.head.querySelector<HTMLMetaElement>(
        `meta[name="${name}"]`,
      );
      if (!meta) {
        meta = document.createElement("meta");
        meta.name = name;
        document.head.appendChild(meta);
      }
      meta.content = content;
    }
  }, [app.id, app.color, app.shortName]);

  useEffect(() => {
    setSecure(window.isSecureContext);
    setIos(
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    );
    const display = window.matchMedia("(display-mode: standalone)");
    const updateDisplay = () =>
      setInstalled(
        display.matches ||
          Boolean(
            (navigator as Navigator & { standalone?: boolean }).standalone,
          ),
      );
    updateDisplay();
    display.addEventListener("change", updateDisplay);
    const beforeInstall = (event: Event) => {
      // A prompt prepared for another manifest must never install the wrong product.
      if (currentApp.current !== initialApp || !window.isSecureContext) return;
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const didInstall = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", didInstall);
    if (window.isSecureContext && "serviceWorker" in navigator) {
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((registration) => registration.update())
        .catch(() => {
          /* Browser installation stays available if offline setup fails. */
        });
    }
    return () => {
      display.removeEventListener("change", updateDisplay);
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", didInstall);
    };
  }, [initialApp]);

  return (
    <InstallContext.Provider
      value={{
        app,
        prompt,
        secure,
        installed: installed && !reloadRequired,
        ios,
        reloadRequired,
        clearPrompt: () => setPrompt(null),
      }}
    >
      {children}
    </InstallContext.Provider>
  );
}

function InstallDialog({
  state,
  close,
  error,
  installing,
  request,
}: {
  state: InstallState;
  close(): void;
  error: string;
  installing: boolean;
  request(): void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
      if (event.key !== "Tab") return;
      const buttons = panel.current?.querySelectorAll<HTMLElement>(
        "a[href],button:not([disabled])",
      );
      if (!buttons?.length) return;
      const first = buttons[0],
        last = buttons[buttons.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === panel.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === panel.current)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keyDown);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", keyDown);
      previous?.focus();
    };
  }, [close]);
  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panel}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-title"
        tabIndex={-1}
        style={{ "--install-color": state.app.color } as CSSProperties}
      >
        <button
          className={styles.close}
          type="button"
          onClick={close}
          aria-label="Закрыть установку"
        >
          <X size={19} />
        </button>
        <Smartphone size={30} className={styles.symbol} aria-hidden="true" />
        <h2 id="install-title">{state.app.name} на вашем устройстве</h2>
        {state.installed ? (
          <p>
            Приложение уже открыто в отдельном окне. Его можно запускать с
            экрана устройства.
          </p>
        ) : state.secure === false ? (
          <>
            <p>
              Для установки нужен защищённый адрес <strong>HTTPS</strong>.
              Сейчас сайт открыт по обычному HTTP.
            </p>
            <p>
              Попросите владельца хоста подключить HTTPS, затем откройте
              защищённый адрес на телефоне. После этого браузер сможет
              установить приложение.
            </p>
          </>
        ) : state.reloadRequired ? (
          <>
            <p>
              Подготовим отдельную установку {state.app.name}. Страница
              перезагрузится с настройками этого приложения.
            </p>
            <button
              type="button"
              className={styles.primary}
              onClick={() => window.location.reload()}
            >
              Подготовить установку <ExternalLink size={16} />
            </button>
          </>
        ) : state.prompt ? (
          <>
            <p>
              У приложения будет своя иконка и отдельное окно. Вход — через ваш
              обычный Q-ID.
            </p>
            <button
              type="button"
              className={styles.primary}
              onClick={request}
              disabled={installing}
            >
              {installing ? "Ожидаем браузер…" : `Установить ${state.app.name}`}{" "}
              <Download size={16} />
            </button>
          </>
        ) : state.ios ? (
          <>
            <p>
              В браузере откройте{" "}
              <strong>«Поделиться» → «На экран „Домой“» → «Добавить»</strong>.
              Если есть переключатель «Открывать как веб-приложение», включите
              его.
            </p>
            <p>
              Приложение откроется отдельно, со своей иконкой {state.app.name}.
            </p>
          </>
        ) : (
          <>
            <p>
              Откройте меню браузера и выберите{" "}
              <strong>«Установить приложение»</strong> или{" "}
              <strong>«Установить {state.app.name}»</strong>. Проверка сайта
              браузером может занять несколько секунд.
            </p>
            <p>
              На Android используйте Chrome или Samsung Internet. Во встроенном
              браузере мессенджера откройте сайт во внешнем браузере.
            </p>
          </>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <Link href="/apps" className={styles.help} onClick={close}>
          Все приложения и инструкция <ExternalLink size={14} />
        </Link>
      </div>
    </div>,
    document.body,
  );
}

export function AppInstallButton({ compact = false }: { compact?: boolean }) {
  const state = useContext(InstallContext);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");
  // Keep the dialog callback stable so keyboard focus is not reset on state changes.
  const close = useCallback(() => setOpen(false), []);
  if (!state)
    return (
      <Link href="/apps" className={styles.button}>
        <Download size={16} />
        <span>Установить</span>
      </Link>
    );
  const request = async () => {
    setError("");
    if (
      !state.prompt ||
      state.reloadRequired ||
      !state.secure ||
      state.installed
    ) {
      setOpen(true);
      return;
    }
    setInstalling(true);
    try {
      await state.prompt.prompt();
      await state.prompt.userChoice;
      setOpen(false);
    } catch {
      setError("Браузер не завершил установку. Попробуйте через его меню.");
      setOpen(true);
    } finally {
      state.clearPrompt();
      setInstalling(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className={`${styles.button} ${compact ? styles.compact : ""}`}
        onClick={() => void request()}
        disabled={installing}
        aria-label={`Установить ${state.app.name}`}
        title={`Установить ${state.app.name}`}
        style={{ "--install-color": state.app.color } as CSSProperties}
      >
        <Download size={16} aria-hidden="true" />
        <span>{state.installed ? "Приложение" : "Установить"}</span>
      </button>
      {open && (
        <InstallDialog
          state={state}
          close={close}
          error={error}
          installing={installing}
          request={() => void request()}
        />
      )}
    </>
  );
}
