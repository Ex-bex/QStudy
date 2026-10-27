import { pwaMetadata } from "@/lib/pwa-metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { QMessageProvider } from "@/components/qmessage/context";

export const metadata: Metadata = {
  title: {
    absolute: "QMessage — ближе друг к другу",
    template: "%s · QMessage",
  },
  description:
    "Личные сообщения в экосистеме QForce. Общий вход Q-ID, переписка, реакции и стикеры в браузере.",
  icons: {
    icon: { url: "/brand/qmessage-prototype.svg", type: "image/svg+xml" },
  },
  ...pwaMetadata("qmessage"),
};

export default function QMessageLayout({ children }: { children: ReactNode }) {
  return <QMessageProvider>{children}</QMessageProvider>;
}
