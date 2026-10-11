export type DepartmentLogo = "main" | "coding" | "tech" | "press" | "business";

export interface DeveloperDepartment {
  id: number;
  name: string;
  director: string;
  description: string;
  email: string;
  telegram: string;
  website: string;
  logo: DepartmentLogo;
  logo_url: string;
  logo_custom: boolean;
  display_order: number;
}

export interface DeveloperDirectory {
  departments: DeveloperDepartment[];
}
