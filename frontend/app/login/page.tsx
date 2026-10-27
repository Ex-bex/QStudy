import { pwaMetadata } from "@/lib/pwa-metadata";
import { pwaAppForPath } from "@/lib/pwa";
import type { Metadata } from "next";
import AuthForm from "@/components/auth-form";
import { QID_LOGO } from "@/lib/identity-brand";

const identityMetadata: Metadata = {
  title: { absolute: "Вход · Q-ID" },
  description:
    "Один аккаунт для QStudy, QCareer и QBall. Войдите в Q-ID, чтобы продолжить.",
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
    ...pwaMetadata(pwaAppForPath("/login", next).id),
  };
}

export default function LoginPage() {
  return <AuthForm />;
}
