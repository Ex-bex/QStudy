import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StudyHub — умная учёба",
  description: "Личная учебная платформа с ИИ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className="bg-gray-950 text-gray-100 antialiased">{children}</body>
    </html>
  );
}
