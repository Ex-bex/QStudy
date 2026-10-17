import { safeBrandingAsset } from "./branding.ts";
import { CONTROL_LOGO, QID_LOGO } from "./identity-brand.ts";

export interface EcosystemBranding {
  identity_logo_url: string;
  identity_logo_custom: boolean;
  control_logo_url: string;
  control_logo_custom: boolean;
}

export const DEFAULT_ECOSYSTEM_BRANDING: EcosystemBranding = {
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
  const identity = safeBrandingAsset(data.identity_logo_url, "qid");
  const control = safeBrandingAsset(data.control_logo_url, "qcontrol");
  return {
    identity_logo_url: identity ? data.identity_logo_url! : QID_LOGO,
    identity_logo_custom: identity,
    control_logo_url: control ? data.control_logo_url! : CONTROL_LOGO,
    control_logo_custom: control,
  };
}
