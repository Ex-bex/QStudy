import type { Metadata } from "next";
import WorkspaceFrame from "@/components/qtests/workspace-frame";
import QTestsLibrary from "@/components/qtests/library";

export const metadata: Metadata = {
  title: { absolute: "Мои банки вопросов · QTests" },
  robots: { index: false, follow: false },
};

export default function QTestsLibraryPage() {
  return (
    <WorkspaceFrame>
      <QTestsLibrary />
    </WorkspaceFrame>
  );
}
