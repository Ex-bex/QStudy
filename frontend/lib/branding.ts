import type { DepartmentLogo, DeveloperDepartment } from "../types/developers";

export const DEFAULT_PROJECT_LOGO = "/brand/qforce_logo_main.png";
export const DEPARTMENT_LOGOS: Record<DepartmentLogo, string> = {
  main: DEFAULT_PROJECT_LOGO,
  coding: "/brand/qforce_logo_coding.jpeg",
  tech: "/brand/qforce_logo_tech.jpeg",
  press: "/brand/qforce_logo_press.jpeg",
  business: "/brand/qforce_logo_business.jpeg",
};

export interface ProjectBranding {
  project_logo_url: string;
  project_logo_custom: boolean;
}

export const DEFAULT_BRANDING: ProjectBranding = {
  project_logo_url: DEFAULT_PROJECT_LOGO,
  project_logo_custom: false,
};

export function safeBrandingAsset(
  value: unknown,
  key: string,
): value is string {
  if (
    /^(project|qtests|qmessage|qid|qcontrol|qforce|(?:department|director)-[1-9][0-9]*)$/.exec(
      key,
    )?.[0] !== key
  )
    return false;
  return (
    typeof value === "string" &&
    new RegExp(`^/api/branding/assets/${key}/[a-f0-9]{64}\\.png$`).exec(
      value,
    )?.[0] === value
  );
}

export function normalizeBranding(value: unknown): ProjectBranding {
  if (!value || typeof value !== "object") return DEFAULT_BRANDING;
  const logo = (value as Partial<ProjectBranding>).project_logo_url;
  return safeBrandingAsset(logo, "project")
    ? { project_logo_url: logo, project_logo_custom: true }
    : DEFAULT_BRANDING;
}

export function safeDirectorPhotoUrl(
  department: Pick<DeveloperDepartment, "id" | "director_photo_url">,
): string | null {
  return safeBrandingAsset(
    department.director_photo_url,
    `director-${department.id}`,
  )
    ? department.director_photo_url!
    : null;
}

export function departmentLogoUrl(
  department: DeveloperDepartment,
  projectLogo = DEFAULT_PROJECT_LOGO,
) {
  if (safeBrandingAsset(department.logo_url, `department-${department.id}`))
    return department.logo_url;
  if (department.logo === "main")
    return safeBrandingAsset(projectLogo, "project")
      ? projectLogo
      : DEFAULT_PROJECT_LOGO;
  const standard = DEPARTMENT_LOGOS[department.logo];
  return typeof standard === "string" ? standard : DEFAULT_PROJECT_LOGO;
}
