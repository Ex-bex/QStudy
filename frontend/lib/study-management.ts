"use client";

import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { isStudyManagement, studyPath } from "./study-routing";

// This controls where management UI is shown. API permissions remain server-side.
export function useStudyManagement() {
  const { user } = useAuth();
  const pathname = usePathname();
  return isStudyManagement(user.role, pathname);
}

export function useStudyPath() {
  const pathname = usePathname();
  return (href: string) => studyPath(href, pathname);
}
