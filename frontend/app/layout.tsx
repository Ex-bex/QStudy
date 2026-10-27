import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import "./globals.css";
import { BrandingProvider } from "@/components/branding-provider";
import { AppInstallProvider } from "@/components/app-install";
import { pwaMetadata } from "@/lib/pwa-metadata";

export const metadata: Metadata = {
  ...pwaMetadata("qforce"),
  title: {
    default: "QStudy — пространство для роста",
    template: "%s · QStudy",
  },
  description:
    "Ваше обучение в одном пространстве: группы, расписание, учебный план и личный ИИ-помощник.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#24334b",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru" data-scroll-behavior="smooth">
      <body className="antialiased">
        <BrandingProvider>
          <Suspense fallback={children}>
            <AppInstallProvider>{children}</AppInstallProvider>
          </Suspense>
        </BrandingProvider>
      </body>
    </html>
  );
}
