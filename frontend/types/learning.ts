export interface LearningSelection {
  course_id: number | null;
  module: string;
  week_numbers: number[];
  work_ids: number[];
  use_web: boolean;
}

export interface LearningCourseOption {
  id: number;
  title: string;
  group_id: number;
  group_name: string;
  modules: string[];
  weeks: { week_number: number; title: string; module: string }[];
  works: {
    id: number;
    title: string;
    module: string;
    week_number: number | null;
  }[];
}

export interface ResearchMetadata {
  status: "verified" | "unavailable" | "disabled" | "no_sources";
  checked_at: string | null;
  sources: { title: string; url: string }[];
  warnings: string[];
  search_suggestions_html?: string;
}

export interface LearningSourceContext {
  version?: number;
  mode?: "course" | "personal";
  course_id?: number;
  course_title?: string;
  group_id?: number;
  group_name?: string;
  module?: string;
  week_numbers?: number[];
  work_ids?: number[];
  weeks?: {
    week_number: number;
    title: string;
    module: string;
    source_syllabus_id?: number | null;
  }[];
  works?: {
    id: number;
    title: string;
    module: string;
    week_number: number | null;
    source_syllabus_id?: number | null;
  }[];
  syllabi?: { id: number; title: string }[];
  subject_titles?: string[];
  topic_titles?: string[];
  generated_at?: string;
  research?: ResearchMetadata;
}
