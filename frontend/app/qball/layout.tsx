import { pwaMetadata } from "@/lib/pwa-metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { QBallProvider } from "@/components/lumaball/context";
import LumaShell from "@/components/lumaball/shell";
import "./qball.css";

export const metadata: Metadata = {
  title: "QBall — время сыграть",
  description:
    "Динамичный футбол в браузере. Создайте комнату, соберите команду и играйте с аккаунтом QStudy или в гостевом режиме.",
  icons: {
    icon: "/branding/qball-logo.png",
    apple: "/branding/qball-logo.png",
  },
  ...pwaMetadata("qball"),
};

export default function QBallLayout({ children }: { children: ReactNode }) {
  return (
    <QBallProvider>
      <LumaShell>{children}</LumaShell>
    </QBallProvider>
  );
}
