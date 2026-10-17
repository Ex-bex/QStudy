"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import {
  DEFAULT_BRANDING,
  normalizeBranding,
  type ProjectBranding,
} from "@/lib/branding";
import { createBrandingStore } from "@/lib/branding-store";

const store = createBrandingStore(DEFAULT_BRANDING, async () =>
  normalizeBranding(await api<ProjectBranding>("/branding")),
);
function forceRefreshBranding() {
  return store.refresh(true);
}

export function notifyBrandingChanged(value?: ProjectBranding) {
  if (value) {
    store.update(normalizeBranding(value));
  }
  window.dispatchEvent(new CustomEvent("qstudy:branding-updated"));
  try {
    localStorage.setItem("qstudy:branding-updated", String(Date.now()));
  } catch {}
}

export function useBranding() {
  const current = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  return { ...current, refresh: forceRefreshBranding };
}

function DynamicProjectIcons() {
  const { branding } = useBranding();
  const pathname = usePathname();
  useEffect(() => {
    if (pathname === "/qcareer" || pathname.startsWith("/qcareer/")) return;
    for (const rel of ["icon", "apple-touch-icon"]) {
      let links = [
        ...document.head.querySelectorAll<HTMLLinkElement>(
          `link[rel="${rel}"]`,
        ),
      ];
      if (!links.length) {
        const link = document.createElement("link");
        link.rel = rel;
        document.head.appendChild(link);
        links = [link];
      }
      for (const link of links) {
        link.href = branding.project_logo_url;
        link.type = "image/png";
        link.sizes = "any";
      }
    }
  }, [branding.project_logo_url, pathname]);
  return null;
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (store.getSnapshot().loading) void store.refresh();
    const refresh = () => {
      void forceRefreshBranding();
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === "qstudy:branding-updated") refresh();
    };
    window.addEventListener("qstudy:branding-updated", refresh);
    window.addEventListener("storage", storageChanged);
    return () => {
      window.removeEventListener("qstudy:branding-updated", refresh);
      window.removeEventListener("storage", storageChanged);
    };
  }, []);
  return (
    <>
      <DynamicProjectIcons />
      {children}
    </>
  );
}
