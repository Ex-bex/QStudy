import type { Metadata } from "next";
import { pwaApp, pwaIconUrl, pwaManifestUrl, type PwaAppId } from "./pwa";

export function pwaMetadata(id: PwaAppId): Metadata {
  const app = pwaApp(id)!;
  return {
    manifest: pwaManifestUrl(id),
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: app.shortName,
    },
    icons: {
      apple: [
        { url: pwaIconUrl(id, 180), sizes: "180x180", type: "image/png" },
      ],
    },
  };
}
