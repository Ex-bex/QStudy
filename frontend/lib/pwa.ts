import type { MetadataRoute } from "next";

export type PwaAppId =
  | "qforce"
  | "qstudy"
  | "qball"
  | "qcareer"
  | "qtests"
  | "qmessage"
  | "qcontrol"
  | "qid";

export type PwaApp = {
  id: PwaAppId;
  name: string;
  shortName: string;
  description: string;
  color: string;
  backgroundColor: string;
  startUrl: string;
  scope: string;
};

// A stable manifest id keeps each installed product independent from the others.
// Scopes intentionally have no trailing slash: Next serves /dashboard, not /dashboard/.
export const PWA_APPS: readonly PwaApp[] = [
  {
    id: "qforce",
    name: "QForce",
    shortName: "QForce",
    description: "Команда QForce и проекты экосистемы.",
    color: "#25252b",
    backgroundColor: "#f7f6f2",
    startUrl: "/",
    scope: "/",
  },
  {
    id: "qstudy",
    name: "QStudy",
    shortName: "QStudy",
    description:
      "Расписание, учебные материалы и личное пространство студента.",
    color: "#607a52",
    backgroundColor: "#f7f6f2",
    startUrl: "/dashboard",
    scope: "/dashboard",
  },
  {
    id: "qball",
    name: "QBall",
    shortName: "QBall",
    description: "Футбол в браузере: комнаты, команды и матчи с друзьями.",
    color: "#7645c7",
    backgroundColor: "#f6f3fb",
    startUrl: "/qball/play",
    scope: "/qball",
  },
  {
    id: "qcareer",
    name: "QCareer",
    shortName: "QCareer",
    description: "Навыки, учебный прогресс и следующие шаги к профессии.",
    color: "#b95821",
    backgroundColor: "#fff8f2",
    startUrl: "/qcareer/workspace",
    scope: "/qcareer",
  },
  {
    id: "qtests",
    name: "QTests",
    shortName: "QTests",
    description:
      "Сохранённые банки вопросов и тестирование по учебным материалам.",
    color: "#0c7184",
    backgroundColor: "#f0f8f9",
    startUrl: "/qtests/library",
    scope: "/qtests",
  },
  {
    id: "qmessage",
    name: "QMessage",
    shortName: "QMessage",
    description: "Личные переписки, стикеры и изображения с общим входом Q-ID.",
    color: "#167e91",
    backgroundColor: "#f1fafa",
    startUrl: "/qmessage/chats",
    scope: "/qmessage",
  },
  {
    id: "qcontrol",
    name: "QControl",
    shortName: "QControl",
    description:
      "Управление аккаунтами, проектами и сервером экосистемы QForce.",
    color: "#b63d46",
    backgroundColor: "#fcf6f5",
    startUrl: "/qcontrol",
    scope: "/qcontrol",
  },
  {
    id: "qid",
    name: "Q-ID",
    shortName: "Q-ID",
    description: "Единый аккаунт для проектов экосистемы QForce.",
    color: "#343c53",
    backgroundColor: "#f5f6fa",
    startUrl: "/login",
    scope: "/",
  },
];

export function pwaApp(id: string): PwaApp | null {
  return PWA_APPS.find((app) => app.id === id) || null;
}

function productAtPath(pathname: string): PwaApp | null {
  if (pathname === "/qstudy" || pathname.startsWith("/qstudy/"))
    return pwaApp("qstudy");
  return (
    PWA_APPS.find(
      (app) =>
        app.scope !== "/" &&
        (pathname === app.scope || pathname.startsWith(`${app.scope}/`)),
    ) || null
  );
}

export function pwaAppForPath(pathname: string, next?: string | null): PwaApp {
  if (
    ["/login", "/register", "/forgot-password", "/reset-password"].includes(
      pathname,
    )
  ) {
    // Never accept a remote or protocol-relative return address for app selection.
    if (
      next?.startsWith("/") &&
      !next.startsWith("//") &&
      !Array.from(next).some(
        (character) => character === "\\" || character.charCodeAt(0) <= 32,
      )
    ) {
      const target = next.split(/[?#]/, 1)[0];
      const product = productAtPath(target);
      if (product) return product;
    }
    return pwaApp("qid")!;
  }
  return productAtPath(pathname) || pwaApp("qforce")!;
}

export function pwaManifestUrl(app: PwaAppId): string {
  return `/apps/${app}/manifest.webmanifest`;
}

export function pwaIconUrl(app: PwaAppId, size: 180 | 192 | 512 = 192): string {
  return `/apps/${app}/icon/${size}.png`;
}

export function pwaManifest(appId: PwaAppId): MetadataRoute.Manifest {
  const app = pwaApp(appId)!;
  return {
    id: `/apps/${app.id}`,
    name: app.name,
    short_name: app.shortName,
    description: app.description,
    lang: "ru",
    start_url: app.startUrl,
    scope: app.scope,
    display: "standalone",
    background_color: app.backgroundColor,
    theme_color: app.color,
    prefer_related_applications: false,
    icons: [
      {
        src: pwaIconUrl(app.id, 192),
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: pwaIconUrl(app.id, 512),
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: pwaIconUrl(app.id, 512) + "?purpose=maskable",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
