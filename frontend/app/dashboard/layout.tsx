import type { Metadata } from "next";
import DashboardShell from "@/components/dashboard-shell";
import { pwaMetadata } from "@/lib/pwa-metadata";

export const metadata: Metadata = {
  ...pwaMetadata("qstudy"),
  title: { absolute: "QStudy — моё обучение" },
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardShell>{children}</DashboardShell>;
}
