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
import { isIdentityPath } from "@/lib/identity-brand";
import { useQTestsBranding } from "@/components/qtests-brand";
import {
  QMessageBrandingProvider,
  useQMessageBranding,
} from "@/components/qmessage-brand";
import {
  EcosystemBrandingProvider,
  useEcosystemBranding,
} from "@/components/ecosystem-branding";

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
  const { branding: ecosystem } = useEcosystemBranding();
  const { branding: tests } = useQTestsBranding();
  const { branding: message } = useQMessageBranding();
  const pathname = usePathname();
  useEffect(() => {
    if (pathname === "/qcareer" || pathname.startsWith("/qcareer/")) return;
    const identity = isIdentityPath(pathname);
    const control =
      pathname === "/qcontrol" || pathname.startsWith("/qcontrol/");
    const logo =
      pathname === "/" || pathname === "/developers"
        ? ecosystem.force_logo_url
        : pathname === "/qmessage" || pathname.startsWith("/qmessage/")
          ? message.logo_url
          : pathname === "/qtests" || pathname.startsWith("/qtests/")
            ? tests.logo_url
            : identity
              ? ecosystem.identity_logo_url
              : control
                ? ecosystem.control_logo_url
                : branding.project_logo_url;
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
        link.href = logo;
        link.type = logo.endsWith(".svg") ? "image/svg+xml" : "image/png";
        link.sizes = "any";
      }
    }
  }, [
    branding.project_logo_url,
    ecosystem.force_logo_url,
    ecosystem.identity_logo_url,
    ecosystem.control_logo_url,
    tests.logo_url,
    message.logo_url,
    pathname,
  ]);
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
    <EcosystemBrandingProvider>
      <QMessageBrandingProvider>
        <DynamicProjectIcons />
        {children}
      </QMessageBrandingProvider>
    </EcosystemBrandingProvider>
  );
}
