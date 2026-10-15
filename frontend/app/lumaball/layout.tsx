import type { Metadata } from "next";
import type { ReactNode } from "react";
import { LumaBallProvider } from "@/components/lumaball/context";
import LumaShell from "@/components/lumaball/shell";
import "./lumaball.css";

export const metadata: Metadata = {
  title: "LumaBall — время сыграть",
  description:
    "Динамичный футбол в браузере. Создайте комнату, соберите команду и играйте с аккаунтом QStudy или в гостевом режиме.",
};

export default function LumaBallLayout({ children }: { children: ReactNode }) {
  return (
    <LumaBallProvider>
      <LumaShell>{children}</LumaShell>
    </LumaBallProvider>
  );
}
