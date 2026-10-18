import type { Metadata } from "next";
import { notFound } from "next/navigation";
import QTestsBankView from "@/components/qtests/bank";
import WorkspaceFrame from "@/components/qtests/workspace-frame";

export const metadata: Metadata = {
  title: { absolute: "Банк вопросов · QTests" },
  robots: { index: false, follow: false },
};

export default async function QTestsBankPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) notFound();
  return (
    <WorkspaceFrame path={`/qtests/banks/${id}`}>
      <QTestsBankView bankId={Number(id)} />
    </WorkspaceFrame>
  );
}
