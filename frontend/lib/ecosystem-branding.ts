import { safeBrandingAsset } from "./branding.ts";
import { CONTROL_LOGO, QID_LOGO } from "./identity-brand.ts";

export const FORCE_LOGO = "/brand/qforce_logo_main.png";

export interface EcosystemBranding {
  force_logo_url: string;
  force_logo_custom: boolean;
  identity_logo_url: string;
  identity_logo_custom: boolean;
  control_logo_url: string;
  control_logo_custom: boolean;
}

export const DEFAULT_ECOSYSTEM_BRANDING: EcosystemBranding = {
  force_logo_url: FORCE_LOGO,
  force_logo_custom: false,
  identity_logo_url: QID_LOGO,
  identity_logo_custom: false,
  control_logo_url: CONTROL_LOGO,
  control_logo_custom: false,
};

export function normalizeEcosystemBranding(value: unknown): EcosystemBranding {
  const data =
    value && typeof value === "object"
      ? (value as Partial<EcosystemBranding>)
      : {};
  const force = safeBrandingAsset(data.force_logo_url, "qforce");
  const identity = safeBrandingAsset(data.identity_logo_url, "qid");
  const control = safeBrandingAsset(data.control_logo_url, "qcontrol");
  return {
    force_logo_url: force ? data.force_logo_url! : FORCE_LOGO,
    force_logo_custom: force,
    identity_logo_url: identity ? data.identity_logo_url! : QID_LOGO,
    identity_logo_custom: identity,
    control_logo_url: control ? data.control_logo_url! : CONTROL_LOGO,
    control_logo_custom: control,
  };
}
