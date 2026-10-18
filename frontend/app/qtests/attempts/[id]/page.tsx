import type { Metadata } from "next";
import { notFound } from "next/navigation";
import QTestsAttemptView from "@/components/qtests/attempt";
import WorkspaceFrame from "@/components/qtests/workspace-frame";

export const metadata: Metadata = {
  title: { absolute: "Тренировка · QTests" },
  robots: { index: false, follow: false },
};

export default async function QTestsAttemptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) notFound();
  return (
    <WorkspaceFrame path={`/qtests/attempts/${id}`}>
      <QTestsAttemptView attemptId={Number(id)} />
    </WorkspaceFrame>
  );
}
