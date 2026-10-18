export type QTestsConfig = {
  enabled: boolean;
  title: string;
  description: string;
  ai_available: boolean;
  announcement?: string;
  default_question_count?: number;
  max_file_mb?: number;
  max_questions?: number;
};

export type QTestsBank = {
  id: number;
  title: string;
  filename: string;
  status: "importing" | "ready" | "error";
  answer_mode: "first" | "marked";
  question_count: number;
  warnings: string[];
  error: string | null;
  job_id?: string | null;
  created_at: string;
  updated_at: string;
  questions?: QTestsBankQuestion[];
  lesson_id: number | null;
  lesson_title: string | null;
  has_document: boolean;
  replacement_status?: "importing" | "error" | null;
  replacement_filename?: string | null;
  replacement_error?: string | null;
};

export type QTestsLesson = {
  id: number;
  title: string;
  description: string;
  bank_count: number;
  question_count: number;
  created_at: string;
  updated_at: string;
};

export type QTestsBankQuestion = {
  id: number;
  order: number;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
};

export type QTestsQuestionInput = {
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
};

export type QTestsAttemptQuestion = {
  id: number;
  order: number;
  question: string;
  options: string[];
  user_index: number | null;
  correct_index?: number;
  explanation?: string;
  explanation_status?: string;
  explanation_source?: string;
};

export type QTestsAttempt = {
  id: number;
  bank_id: number | null;
  bank_title: string;
  status: "active" | "finished";
  question_count: number;
  answered_count: number;
  correct_count: number;
  score: number | null;
  created_at: string;
  finished_at: string | null;
  questions?: QTestsAttemptQuestion[];
};

export type QTestsOverview = {
  banks: QTestsBank[];
  lessons: QTestsLesson[];
  attempts: QTestsAttempt[];
  stats: {
    banks: number;
    questions: number;
    attempts: number;
    finished: number;
  };
  ai_available: boolean;
};

export type QTestsImport = { bank: QTestsBank; job_id: string };

export function qtestsError(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "Не удалось выполнить действие. Повторите попытку.";
}

export function qtestsDate(value: string): string {
  const date = new Date(
    value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`,
  );
  return Number.isNaN(date.getTime())
    ? "Дата не указана"
    : date.toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

export function optionLetter(index: number): string {
  return String.fromCharCode(65 + index);
}
