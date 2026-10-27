import { pwaMetadata } from "@/lib/pwa-metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CareerProvider } from "@/components/career/context";
import CareerShell from "@/components/career/shell";

export const metadata: Metadata = {
  title: "QCareer — из учёбы в будущее",
  description:
    "Поймите свои навыки, найдите интересное направление и соберите следующий шаг на основе обучения в QStudy.",
  icons: {
    icon: { url: "/brand/qforcelogo_qcareer.png", type: "image/png" },
    apple: { url: "/brand/qforcelogo_qcareer.png", type: "image/png" },
  },
  ...pwaMetadata("qcareer"),
};

export default function CareerLayout({ children }: { children: ReactNode }) {
  return (
    <CareerProvider>
      <CareerShell>{children}</CareerShell>
    </CareerProvider>
  );
}
