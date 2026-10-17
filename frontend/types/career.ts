export interface CareerConfig {
  enabled: boolean;
  title: string;
  description: string;
  announcement: string;
  logo_url: string | null;
  logo_custom?: boolean;
  accent?: "orange";
}

export interface CareerEvidence {
  kind: "test" | "submission";
  source_id: number;
  title: string;
  score: number;
  level: number;
  course_id: number;
  module: string;
  href: string;
  verified_at: string | null;
}
export interface CareerSkill {
  id: number;
  slug: string;
  name: string;
  description: string;
  category: string;
  is_active: boolean;
  level?: number;
  evidence?: CareerEvidence[];
}
export interface CareerRequirement {
  skill_id: number;
  skill_name?: string;
  level: number;
  current_level?: number;
  gap?: number;
}
export interface CareerDirection {
  id: number;
  slug: string;
  title: string;
  description: string;
  category: string;
  study_paths: string[];
  career_paths: string[];
  is_active: boolean;
  requirements: CareerRequirement[];
  readiness?: number | null;
  matched_skills?: number;
  total_requirements?: number;
}
export interface CareerProfile {
  user_id: number;
  name: string;
  group_id: number | null;
  group_name: string | null;
  target_direction_id: number | null;
  interests: string[];
  about: string;
  saved_opportunity_ids: number[];
}
export interface CareerStep {
  id: number | string;
  title: string;
  description: string;
  course_id: number;
  course_title: string;
  module: string;
  week_number: number | null;
  work_id: number | null;
  skill_id: number;
  skill_name: string;
  from_level: number;
  to_level: number;
  prerequisites: CareerRequirement[];
  href: string;
  test_href: string;
  reason: string;
  gains?: {
    skill_id: number;
    skill_name: string;
    from_level: number;
    to_level: number;
  }[];
}
export interface CareerRecommendations {
  mode: "rules";
  steps: CareerStep[];
  remaining_gaps: {
    skill_id: number;
    skill_name: string;
    current_level: number;
    required_level: number;
    gap: number;
  }[];
  reason: string;
  assumptions: string[];
  direction_id?: number | null;
  direction_title?: string | null;
}
export interface CareerWorkspace {
  profile: CareerProfile;
  summary: {
    demonstrated_skills: number;
    evidence_count: number;
    readiness: number | null;
    target_direction_id: number | null;
    target_direction_title: string | null;
  };
  skills: CareerSkill[];
  directions: CareerDirection[];
  recommendations: CareerRecommendations;
  activity: {
    completed_weeks: number;
    finished_tests: number;
    graded_works: number;
  };
  disclaimer: string;
}
export type CareerOpportunityKind = "job" | "internship" | "study" | "course";
export interface CareerOpportunity {
  id: number;
  title: string;
  organization: string;
  description: string;
  kind: CareerOpportunityKind;
  url: string;
  location: string;
  direction_id: number | null;
  direction_title?: string | null;
  published_at: string;
  expires_at: string | null;
  is_active: boolean;
  saved?: boolean;
  readiness?: number | null;
  requirements_met?: boolean | null;
}
export interface CareerLearningLink {
  id: number;
  skill_id: number;
  course_id: number;
  module: string;
  week_number: number | null;
  work_id: number | null;
  syllabus_id: number | null;
  title: string;
  description: string;
  target_level: number;
  min_score: number;
  prerequisites: CareerRequirement[];
  is_active: boolean;
  skill_name?: string;
  course_title?: string;
  group_id?: number;
  group_name?: string;
  href?: string;
  test_href?: string;
}
export interface CareerSourceCourse {
  id: number;
  title: string;
  group_id: number;
  group_name: string;
  modules: string[];
  weeks: {
    id: number;
    week_number: number;
    title: string;
    module: string;
    source_syllabus_id: number | null;
  }[];
  works: {
    id: number;
    title: string;
    module: string;
    week_number: number | null;
    source_syllabus_id: number | null;
  }[];
  syllabi: { id: number; title: string }[];
}
export interface CareerStudent {
  id: number;
  name: string;
  email: string;
  group_id: number | null;
  group_name: string | null;
  target_direction_id: number | null;
  target_direction_title: string | null;
  demonstrated_skills: number;
  evidence_count: number;
  readiness: number | null;
}
export interface CareerOverview {
  students_count: number;
  active_skills: number;
  active_directions: number;
  active_links: number;
  active_opportunities: number;
  groups: {
    id: number;
    name: string;
    students_count: number;
    demonstrated_skills: number;
    evidence_count: number;
  }[];
}
