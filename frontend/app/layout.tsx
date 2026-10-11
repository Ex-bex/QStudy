import type { Metadata } from "next";
import "./globals.css";
import { BrandingProvider } from "@/components/branding-provider";

export const metadata: Metadata = {
  title: {
    default: "QStudy — пространство для роста",
    template: "%s · QStudy",
  },
  description:
    "Ваше обучение в одном пространстве: группы, расписание, учебный план и личный ИИ-помощник.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru" data-scroll-behavior="smooth">
      <body className="antialiased">
        <BrandingProvider>{children}</BrandingProvider>
      </body>
    </html>
  );
}
