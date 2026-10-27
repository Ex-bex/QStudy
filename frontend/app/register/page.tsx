import { pwaMetadata } from "@/lib/pwa-metadata";
import { pwaAppForPath } from "@/lib/pwa";
import type { Metadata } from "next";
import AuthForm from "@/components/auth-form";
import { QID_LOGO } from "@/lib/identity-brand";

const identityMetadata: Metadata = {
  title: { absolute: "Регистрация · Q-ID" },
  description:
    "Создайте Q-ID для обучения в QStudy, развития в QCareer и игры в QBall.",
  icons: { icon: QID_LOGO, apple: QID_LOGO },
};

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}): Promise<Metadata> {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : null;
  return {
    ...identityMetadata,
    ...pwaMetadata(pwaAppForPath("/register", next).id),
  };
}

export default function RegisterPage() {
  return <AuthForm register />;
}
