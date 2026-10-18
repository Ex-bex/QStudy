"use client";

import { useAuth } from "@/lib/auth";
import type { EcosystemBranding } from "@/lib/ecosystem-branding";
import {
  useEcosystemBranding,
  notifyEcosystemBrandingChanged,
} from "@/components/ecosystem-branding";
import { LogoUpload } from "@/components/logo-upload";
import { ErrorNotice } from "@/components/academic";

export default function EcosystemBrandingAdmin() {
  const { user } = useAuth();
  const { branding, error, refresh } = useEcosystemBranding();
  if (user.role !== "admin") return null;
  return (
    <section className="academic-section">
      <div className="academic-section-heading">
        <div>
          <h2>QForce, Q-ID и QControl</h2>
          <p className="muted">
            Логотипы экосистемы, входа и центра управления. Прозрачный PNG до 2
            МБ. Логотип QForce на общей главной и странице команды изменяется
            отдельно от QStudy.
          </p>
        </div>
      </div>
      <ErrorNotice message={error} />
      {error && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void refresh()}
        >
          Повторить загрузку
        </button>
      )}
      <div className="panel branding-admin-panel">
        <LogoUpload<EcosystemBranding>
          title="Логотип QForce"
          currentUrl={branding.force_logo_url}
          custom={branding.force_logo_custom}
          endpoint="/branding/force-logo"
          onSaved={notifyEcosystemBrandingChanged}
        />
        <LogoUpload<EcosystemBranding>
          title="Логотип Q-ID"
          currentUrl={branding.identity_logo_url}
          custom={branding.identity_logo_custom}
          endpoint="/branding/identity-logo"
          onSaved={notifyEcosystemBrandingChanged}
        />
        <LogoUpload<EcosystemBranding>
          title="Логотип QControl"
          currentUrl={branding.control_logo_url}
          custom={branding.control_logo_custom}
          endpoint="/branding/control-logo"
          onSaved={notifyEcosystemBrandingChanged}
        />
      </div>
    </section>
  );
}
