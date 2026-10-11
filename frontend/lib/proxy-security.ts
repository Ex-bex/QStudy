import { isIP } from "node:net";

function siteOrigin(value: string | null | undefined): URL | null {
  if (!value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash ||
      url.pathname !== "/"
    ) return null;
    return url;
  } catch {
    return null;
  }
}

/** Use the configured public origin behind HTTPS termination, never client forwarding headers. */
export function sameSiteMutation(
  origin: string | null,
  host: string | null,
  protocol: string,
  publicBaseUrl?: string,
): boolean {
  const supplied = siteOrigin(origin);
  if (!supplied || !host) return false;
  if (publicBaseUrl) {
    const trusted = siteOrigin(publicBaseUrl);
    return !!trusted && supplied.origin === trusted.origin && supplied.host === host;
  }
  return supplied.host === host && supplied.protocol === protocol;
}

/** Only the private production proxy may provide one IP; the BFF authenticates it to the API. */
export function trustedClientIp(
  realIp: string | null,
  trustProxyHeaders: string | undefined,
  nodeEnv: string | undefined,
  proxySecret: string | undefined,
): string | null {
  if (
    trustProxyHeaders !== "true" || nodeEnv !== "production" ||
    !proxySecret || proxySecret.length < 32 || !realIp || !isIP(realIp)
  ) return null;
  return realIp;
}
