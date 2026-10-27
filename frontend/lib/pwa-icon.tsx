import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import type { PwaApp } from "./pwa";

type LogoSource = {
  file: string;
  config: string;
  field: string;
  key: string;
};

const SOURCES: Record<PwaApp["id"], LogoSource> = {
  qforce: {
    file: "brand/qforce_logo_main.png",
    config: "/branding/ecosystem",
    field: "force_logo_url",
    key: "qforce",
  },
  qstudy: {
    file: "brand/qforce_logo_main.png",
    config: "/branding",
    field: "project_logo_url",
    key: "project",
  },
  qball: {
    file: "branding/qball-logo.png",
    config: "/lumaball/config",
    field: "logo_url",
    key: "lumaball",
  },
  qcareer: {
    file: "brand/qforcelogo_qcareer.png",
    config: "/career/config",
    field: "logo_url",
    key: "qcareer",
  },
  qtests: {
    file: "brand/qtests-prototype.svg",
    config: "/branding/tests",
    field: "logo_url",
    key: "qtests",
  },
  qmessage: {
    file: "brand/qmessage-prototype.svg",
    config: "/branding/message",
    field: "logo_url",
    key: "qmessage",
  },
  qcontrol: {
    file: "brand/qforcelogo_qcontrol.png",
    config: "/branding/ecosystem",
    field: "control_logo_url",
    key: "qcontrol",
  },
  qid: {
    file: "brand/qforcelogo_q-id.png",
    config: "/branding/ecosystem",
    field: "identity_logo_url",
    key: "qid",
  },
};
const MAX_LOGO = 2 * 1024 * 1024;

async function boundedBytes(response: Response, maximum: number) {
  if (!response.ok || response.redirected || !response.body) return null;
  if (Number(response.headers.get("content-length") || 0) > maximum) {
    await response.body.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maximum) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

async function logoData(app: PwaApp) {
  const source = SOURCES[app.id];
  const backend = (process.env.BACKEND_URL || "http://127.0.0.1:8000").replace(
    /\/$/,
    "",
  );
  try {
    const response = await fetch(backend + "/api" + source.config, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(4000),
      headers: { Accept: "application/json" },
    });
    const configBytes = await boundedBytes(response, 32 * 1024);
    const value: unknown = configBytes
      ? JSON.parse(configBytes.toString("utf-8"))
      : null;
    const url =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[source.field]
        : null;
    const accepted =
      typeof url === "string" &&
      (app.id === "qball"
        ? /^\/api\/lumaball\/logo\?v=[a-f0-9]{64}$/.test(url)
        : new RegExp(
            `^/api/branding/assets/${source.key}/[a-f0-9]{64}\\.png$`,
          ).test(url));
    if (accepted) {
      // The backend supplies only a relative, per-product public logo path. Do not
      // follow arbitrary URLs or forward the current user's session to this fetch.
      const image = await fetch(backend + (url as string), {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(4000),
        headers: { Accept: "image/png" },
      });
      const bytes = await boundedBytes(image, MAX_LOGO);
      if (
        bytes &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        return `data:image/png;base64,${bytes.toString("base64")}`;
    }
  } catch {
    // A temporary API outage must not make the app's install icon unavailable.
  }
  try {
    const bytes = await readFile(
      path.join(process.cwd(), "public", source.file),
    );
    const mime = source.file.endsWith(".svg") ? "image/svg+xml" : "image/png";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function pwaIconResponse(
  app: PwaApp,
  size: 180 | 192 | 512,
  maskable = false,
) {
  const logo = await logoData(app);
  // A square mark of 56% fits completely inside the maskable safe circle
  // (radius 40%). Normal icons use a larger mark; Apple gets an opaque icon.
  const markSize = Math.round(size * (maskable ? 0.56 : 0.76));
  const response = new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: app.color,
      }}
    >
      {logo ? (
        // Native image data is already bounded and sanitized; next/image is not
        // supported inside ImageResponse's server-side renderer.
        <img
          src={logo}
          width={markSize}
          height={markSize}
          alt=""
          style={{ objectFit: "contain" }}
        />
      ) : (
        <span
          style={{
            color: "white",
            fontSize: Math.round(size * 0.32),
            fontWeight: 700,
          }}
        >
          {app.shortName}
        </span>
      )}
    </div>,
    {
      width: size,
      height: size,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
  return response;
}
