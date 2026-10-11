import type { LearningSelection } from "../types/learning";

export interface ActivityContext {
  page: string;
  subject?: string;
  topic?: string;
  task?: { question: string; status: string } | null;
  exam_question?: string | null;
  lecture?: { title: string; content: string } | null;
  course_id?: number;
  week_number?: number;
  module?: string;
  week_numbers?: number[];
  work_ids?: number[];
  use_web?: boolean;
}

export function learningActivityContext(
  activity: ActivityContext | null,
  selection: LearningSelection,
): ActivityContext {
  const context: ActivityContext = { ...(activity || { page: "chat" }) };
  delete context.use_web;
  delete context.course_id;
  delete context.week_number;
  delete context.module;
  delete context.week_numbers;
  delete context.work_ids;
  if ((activity?.course_id || null) !== selection.course_id) {
    delete context.lecture;
    delete context.task;
    delete context.exam_question;
    delete context.subject;
    delete context.topic;
    context.page = "chat";
  }
  if (selection.course_id) {
    context.course_id = selection.course_id;
    context.module = selection.module;
    context.week_numbers = [...selection.week_numbers];
    context.work_ids = [...selection.work_ids];
  }
  return context;
}

export function setActivity(context: ActivityContext) {
  if (typeof window !== "undefined") {
    sessionStorage.removeItem("studyhub_activity");
    sessionStorage.setItem("qstudy_activity", JSON.stringify(context));
  }
}

export function getActivity(): ActivityContext | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem("qstudy_activity");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
