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
  id: number;
  subject_id: number | null;
  topic_id: number | null;
  difficulty: string;
  status: string;
  summary: string;
  created_at: string;
  questions: ExamQuestion[];
}

export interface Flashcard {
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