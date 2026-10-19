import { safeBrandingAsset } from "./branding.ts";

export const QMESSAGE_LOGO = "/brand/qmessage-prototype.svg";
export type QMessageBranding = { logo_url: string; logo_custom: boolean };
export const DEFAULT_QMESSAGE_BRANDING: QMessageBranding = {
  logo_url: QMESSAGE_LOGO,
  logo_custom: false,
};

export function normalizeQMessageBranding(value: unknown): QMessageBranding {
  const logo =
    value && typeof value === "object"
      ? (value as Partial<QMessageBranding>).logo_url
      : null;
  return safeBrandingAsset(logo, "qmessage")
    ? { logo_url: logo, logo_custom: true }
    : DEFAULT_QMESSAGE_BRANDING;
}
