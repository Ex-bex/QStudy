import type { Metadata } from "next";
import type { ReactNode } from "react";
import QTestsShell from "@/components/qtests/shell";

export const metadata: Metadata = {
  title: {
    absolute: "QTests — практика из ваших вопросов",
    template: "%s · QTests",
  },
  description:
    "Загрузите вопросы из Word, проверьте банк и тренируйтесь на случайной подборке с перемешанными ответами и разбором ошибок.",
  icons: {
    icon: { url: "/brand/qtests-prototype.svg", type: "image/svg+xml" },
  },
};

export default function QTestsLayout({ children }: { children: ReactNode }) {
  return <QTestsShell>{children}</QTestsShell>;
}
