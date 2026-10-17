import type { Metadata } from "next";
import AuthForm from "@/components/auth-form";
import { QID_LOGO } from "@/lib/identity-brand";

export const metadata: Metadata = {
  title: { absolute: "Регистрация · Q-ID" },
  description:
    "Создайте Q-ID для обучения в QStudy, развития в QCareer и игры в QBall.",
  icons: { icon: QID_LOGO, apple: QID_LOGO },
};

export default function RegisterPage() {
  return <AuthForm register />;
}
