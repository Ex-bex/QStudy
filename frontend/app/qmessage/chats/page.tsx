import type { Metadata } from "next";
import { Suspense } from "react";
import QMessageWorkspace from "@/components/qmessage/workspace";

export const metadata: Metadata = {
  title: { absolute: "Мои сообщения · QMessage" },
  robots: { index: false, follow: false },
};

export default function QMessageChatsPage() {
  return (
    <Suspense
      fallback={
        <div role="status" style={{ padding: 40 }}>
          Открываем QMessage…
        </div>
      }
    >
      <QMessageWorkspace />
    </Suspense>
  );
}
