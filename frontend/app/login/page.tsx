import type { Metadata } from "next";
import AuthForm from "@/components/auth-form";
import { QID_LOGO } from "@/lib/identity-brand";

export const metadata: Metadata = {
  title: { absolute: "Вход · Q-ID" },
  description:
    "Один аккаунт для QStudy, QCareer и QBall. Войдите в Q-ID, чтобы продолжить.",
  icons: { icon: QID_LOGO, apple: QID_LOGO },
};

export default function LoginPage() {
  return <AuthForm />;
}
