import type { Metadata } from "next";
import RecoveryForm from "@/components/recovery-form";
import { QID_LOGO } from "@/lib/identity-brand";

export const metadata: Metadata = {
  title: { absolute: "Восстановление доступа · Q-ID" },
  description:
    "Восстановите доступ к общему аккаунту Q-ID по электронной почте.",
  icons: { icon: QID_LOGO, apple: QID_LOGO },
};

export default function ForgotPasswordPage() {
  return <RecoveryForm />;
}
