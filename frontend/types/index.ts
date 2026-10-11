import type { LearningSourceContext } from "./learning";

export interface Subject {
  id: number;
  name: string;
  description: string;
  color: string;
  created_at: string;
}

export interface Topic {
  id: number;
  subject_id: number;
  title: string;
  description: string;
}

export interface Note {
  id: number;
  title: string;
  content: string;
  subject_id: number | null;
  topic_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  source_context?: LearningSourceContext | null;
  id: number;
  question: string;
  hint: string;
  difficulty: string;
  status: string;
  user_answer: string;
  subject_id: number | null;
  topic_id: number | null;
  created_at: string;
}

export interface TaskCheck {
  verdict: "correct" | "partial" | "wrong";
  score: number;
  feedback: string;
  task: Task;
}
export interface FileText {
  id: number;
  filename: string;
  processed: boolean;
  text: string;
}
export interface Material {
  id: number;
  filename: string;
  filepath: string;
  file_type: string;
  size: number;
  processed: boolean;
  subject_id: number | null;
  topic_id: number | null;
  created_at: string;
}
export interface ExamQuestion {
  id: number;
  order: number;
  question: string;
  reference?: string;
  user_answer: string;
  verdict: string;
  score: number;
  feedback: string;
}

export interface ExamSession {
  source_context?: LearningSourceContext | null;
  id: number;
  subject_id: number | null;
  topic_id: number | null;
  difficulty: string;
  status: string;
  summary: string;
  created_at: string;
  questions: ExamQuestion[];
  subject_ids?: number[];
  topic_ids?: number[];
  subject_names?: string[];
  topic_names?: string[];
}

export interface Flashcard {
  source_context?: LearningSourceContext | null;
  id: number;
  front: string;
  back: string;
  subject_id: number | null;
  topic_id: number | null;
  interval: number;
  repetitions: number;
  next_review: string;
  created_at: string;
}

export interface TestQuestion {
  id: number;
  order: number;
  question: string;
  options: string[];
  user_index: number | null;
  correct_index?: number;
  explanation?: string;
}

export interface TestSession {
  source_context?: LearningSourceContext | null;
  id: number;
  difficulty: string;
  status: string;
  score: number;
  summary: string;
  subject_ids: number[];
  topic_ids: number[];
  subject_names: string[];
  topic_names: string[];
  created_at: string;
  questions: TestQuestion[];
}

export interface Lecture {
  source_context?: LearningSourceContext | null;
  id: number;
  topic_id: number | null;
  content: string;
  status: string;
  updated_at: string;
  stale?: boolean;
  topic_title?: string;
  subject_name?: string;
  materials_count?: number;
}

export interface JobNotification {
  id: string;
  kind: string;
  title: string;
  status: string;
  error: string;
  result?: {
    test_id?: number;
    lecture_id?: number;
    exam_id?: number;
    task_ids?: number[];
    card_ids?: number[];
  };
}

export interface ChatSession {
  id: number;
  title: string;
  created_at: string;
}

export interface ChatMessage {
  source_context?: LearningSourceContext | null;
  id: number;
  session_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}
