"use client";

import type { ReactNode } from "react";
import { AuthProvider } from "@/lib/auth";
import { QTestsLogo } from "@/components/qtests-brand";

export default function WorkspaceFrame({
  children,
  path = "/qtests/library",
}: {
  children: ReactNode;
  path?: string;
}) {
  return (
    <AuthProvider
      loginPath={`/login?next=${encodeURIComponent(path)}`}
      loadingMark={<QTestsLogo width={56} height={56} />}
    >
      {children}
    </AuthProvider>
  );
}
