export type Group = {
  id: number;
  name: string;
  description: string;
  academic_year: string;
  curator: string;
  student_count: number;
  course_count: number;
  program?: string;
  study_year?: number | null;
  semester?: number | null;
  warnings?: string[];
};
export type Course = {
  id: number;
  group_id: number;
  title: string;
  description: string;
  teacher: string;
  credits: number;
  color: string;
  group_name?: string;
  weeks?: Week[];
  works?: Work[];
  syllabi?: Syllabus[];
};
export type Schedule = {
  id: number;
  group_id: number;
  course_id: number;
  course_title?: string;
  day_of_week: number;
  start_time: string;
  start_times?: string[];
  end_time: string | null;
  room: string;
  lesson_type: string;
  week_pattern: string;
  teacher?: string;
  notes?: string;
  source_name?: string;
  source_file?: string;
  source_sheet?: string;
  source_cell?: string;
  source_raw?: string;
  source_updated_at?: string;
  source_container?: string;
  source_container_sha256?: string;
  source_row_id?: string;
  source_sha256?: string;
  warnings?: string[];
};
export type TimetableSource = {
  imported: boolean;
  source_file: string;
  source_sha256: string;
  title: string;
  updated_at: string;
  university: string;
  school: string;
  academic_year: string;
  utc_offset: string;
  timezone_label: string;
  warnings: string[];
  counts: {
    groups: number;
    original_lessons: number;
    group_schedule_records: number;
    group_start_slots: number;
  };
  current_counts: {
    groups: number;
    courses: number;
    schedule_records: number;
    start_slots: number;
  };
  sources: {
    source_id: string;
    filename: string;
    sha256: string;
    sheet: string;
    course_heading: string;
    study_year: number | null;
    semester: number | null;
    course_conflict: boolean;
  }[];
  imported_at: string | null;
};
export type GroupDetail = Group & { courses: Course[]; schedule: Schedule[] };
export type Week = {
  id: number;
  course_id: number;
  week_number: number;
  title: string;
  content: string;
  tasks: string;
  assessment: string;
  hours: number;
  module: string;
  resources: string;
  my_progress?: { completed: boolean; note: string } | null;
};
export type Submission = {
  id: number;
  work_id: number;
  user_id: number;
  student_name?: string;
  student_email?: string;
  content: string;
  status: string;
  grade: number | null;
  feedback: string;
  updated_at: string;
};
export type Work = {
  id: number;
  course_id: number;
  title: string;
  description: string;
  module: string;
  week_number: number | null;
  due_date: string | null;
  max_score: number;
  kind: string;
  course_title?: string;
  group_name?: string;
  my_submission?: Submission | null;
};
export type DraftWeek = Omit<Week, "id" | "course_id" | "my_progress">;
export type DraftWork = Omit<
  Work,
  | "id"
  | "course_id"
  | "course_title"
  | "group_name"
  | "my_submission"
  | "due_date"
>;
export type SyllabusDraft = {
  title: string;
  summary: string;
  weeks: DraftWeek[];
  works: DraftWork[];
  course_facts?: CourseFacts | null;
};
export type CourseFacts = {
  credits: number | null;
  teacher: string;
  total_hours: number | null;
  source_group: string;
  semester: number | null;
};
export type Syllabus = {
  id: number;
  course_id: number;
  group_id?: number;
  title: string;
  filename: string;
  extracted_text?: string;
  summary: string;
  created_at: string;
  course_title?: string;
  group_name?: string;
  status: string;
  size: number;
  warnings: string[];
  draft?: SyllabusDraft | null;
  course_facts?: CourseFacts | null;
  weeks?: DraftWeek[];
  source_restricted?: boolean;
  source_sha256?: string;
  duplicate?: boolean;
  import_job?: { id: string; status: string; error: string } | null;
};
export type Account = {
  id: number;
  name: string;
  email: string;
  role: "admin" | "student";
  is_active: boolean;
  group_id: number | null;
  created_at: string;
};
