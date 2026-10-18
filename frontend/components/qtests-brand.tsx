"use client";

import Image, { type ImageProps } from "next/image";
import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { safeBrandingAsset } from "@/lib/branding";
import { createBrandingStore } from "@/lib/branding-store";

export const QTESTS_LOGO = "/brand/qtests-prototype.svg";
export type QTestsBranding = { logo_url: string; logo_custom: boolean };
const EVENT = "qtests:branding-updated";
const normalize = (value: QTestsBranding) => ({
  project_logo_url: safeBrandingAsset(value.logo_url, "qtests")
    ? value.logo_url
    : QTESTS_LOGO,
  project_logo_custom: safeBrandingAsset(value.logo_url, "qtests"),
});
const store = createBrandingStore(
  normalize({ logo_url: QTESTS_LOGO, logo_custom: false }),
  async () => normalize(await api<QTestsBranding>("/branding/tests")),
);
export function notifyQTestsBranding(value: QTestsBranding) {
  store.update(normalize(value));
  window.dispatchEvent(new Event(EVENT));
  try {
    localStorage.setItem(EVENT, String(Date.now()));
  } catch {}
}
export function useQTestsBranding() {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  useEffect(() => {
    if (store.getSnapshot().loading) void store.refresh();
    const refresh = () => {
      if (document.visibilityState !== "hidden") void store.refresh(true);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === EVENT) refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener(EVENT, refresh);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener("storage", storage);
    };
  }, []);
  return {
    branding: {
      logo_url: state.branding.project_logo_url,
      logo_custom: state.branding.project_logo_custom,
    },
    loading: state.loading,
    error: state.error,
    refresh: () => store.refresh(true),
  };
}
export function QTestsLogo({
  alt = "QTests",
  width = 40,
  height = 40,
  ...props
}: Omit<ImageProps, "src" | "alt"> & { alt?: string }) {
  const { branding } = useQTestsBranding();
  return (
    <Image
      {...props}
      src={branding.logo_url}
      width={width}
      height={height}
      alt={alt}
      unoptimized
      onError={(event) => {
        if (!event.currentTarget.src.endsWith(QTESTS_LOGO))
          event.currentTarget.src = QTESTS_LOGO;
      }}
    />
  );
}
