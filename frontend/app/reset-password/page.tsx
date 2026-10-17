import type { Metadata } from "next";
import RecoveryForm from "@/components/recovery-form";
import { QID_LOGO } from "@/lib/identity-brand";

export const metadata: Metadata = {
  title: { absolute: "Новый пароль · Q-ID" },
  description: "Установите новый пароль для своего аккаунта Q-ID.",
  icons: { icon: QID_LOGO, apple: QID_LOGO },
};

export default function ResetPasswordPage() {
  return <RecoveryForm reset />;
}
