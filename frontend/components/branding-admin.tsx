"use client";

import { useAuth } from "@/lib/auth";
import type { ProjectBranding } from "@/lib/branding";
import { ErrorNotice } from "@/components/academic";
import {
  useBranding,
  notifyBrandingChanged,
} from "@/components/branding-provider";
import { LogoUpload } from "@/components/logo-upload";

export function BrandingAdmin() {
  const { user } = useAuth();
  const { branding, error, refresh } = useBranding();
  if (user.role !== "admin") return null;
  return (
    <section
      className="academic-section"
      aria-labelledby="branding-admin-title"
    >
      <div className="academic-section-heading">
        <div>
          <h2 id="branding-admin-title">Логотип QStudy</h2>
          <p className="muted branding-admin-description">
            Обновляется на всех страницах, в 3D-сцене и значке вкладки.
          </p>
        </div>
      </div>
      <div className="panel branding-admin-panel">
        {error && (
          <>
            <ErrorNotice message={error} />
            <button
              className="btn btn-secondary"
              type="button"
              onClick={refresh}
            >
              Повторить загрузку настроек
            </button>
          </>
        )}
        <LogoUpload<ProjectBranding>
          title="Логотип QStudy"
          currentUrl={branding.project_logo_url}
          custom={branding.project_logo_custom}
          endpoint="/branding/project-logo"
          onSaved={notifyBrandingChanged}
        />
      </div>
    </section>
  );
}
