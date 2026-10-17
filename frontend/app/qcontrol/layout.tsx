import type { Metadata } from "next";
import ControlShell from "@/components/control/shell";
import { requireControlAdmin } from "@/lib/control-session";
import { CONTROL_LOGO } from "@/lib/identity-brand";

export const metadata: Metadata = {
  title: {
    absolute: "QControl — управление экосистемой",
  },
  description: "Единое управление QStudy, QCareer, QBall и аккаунтами Q-ID.",
  robots: { index: false, follow: false },
  icons: { icon: CONTROL_LOGO, apple: CONTROL_LOGO },
};

export default async function ControlLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireControlAdmin();
  return <ControlShell>{children}</ControlShell>;
}
