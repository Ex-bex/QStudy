"use client";

import { AuthProvider } from "@/lib/auth";
import CareerWorkspace from "@/components/career/workspace";

export default function CareerWorkspacePage() {
  return (
    <AuthProvider loginPath="/login?next=%2Fqcareer%2Fworkspace">
      <CareerWorkspace />
    </AuthProvider>
  );
}
