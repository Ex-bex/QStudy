import type { Task } from "@/types";

export interface ActivityContext {
  page: string;
  subject?: string;
  topic?: string;
  task?: { question: string; status: string } | null;
  exam_question?: string | null;
}

export function setActivity(ctx: ActivityContext) {
  if (typeof window !== "undefined") {
    sessionStorage.setItem("studyhub_activity", JSON.stringify(ctx));
  }
}

export function getActivity(): ActivityContext | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem("studyhub_activity");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
