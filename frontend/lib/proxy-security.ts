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

/** A default port may appear in Host even though URL.origin removes it. */
function matchesOriginHost(origin: URL, host: string): boolean {
  if (origin.host === host) return true;
  const defaultPort = origin.protocol === "http:" ? "80" : "443";
  return !origin.port && host === `${origin.hostname}:${defaultPort}`;
}

/** Public HTTP is available only for an explicitly configured, canonical public IPv4. */
export function publicHttpOrigin(
  publicBaseUrl: string | undefined,
  allowPublicHttp: string | undefined,
): URL | null {
  if (allowPublicHttp !== "true" || !publicBaseUrl) return null;
  const literal = /^http:\/\/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([1-9][0-9]{0,4})\/?$/.exec(publicBaseUrl);
  if (!literal || isIP(literal[1]) !== 4) return null;
  const [a, b, c, d] = literal[1].split(".").map(Number);
  // Match IPv4 global-address rules, also excluding multicast and reserved ranges.
  if (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) return null;
  return siteOrigin(publicBaseUrl);
}

/** Use the configured public origin behind the private proxy, never client forwarding headers. */
export function sameSiteMutation(
  origin: string | null,
  host: string | null,
  protocol: string,
  publicBaseUrl?: string,
  allowPublicHttp?: string,
  nodeEnv?: string,
): boolean {
  const supplied = siteOrigin(origin);
  if (!supplied || !host) return false;
  if (publicBaseUrl) {
    const trusted = siteOrigin(publicBaseUrl);
    if (
      nodeEnv === "production" && trusted?.protocol === "http:" &&
      !publicHttpOrigin(publicBaseUrl, allowPublicHttp)
    ) return false;
    return !!trusted && supplied.origin === trusted.origin && matchesOriginHost(trusted, host);
  }
  if (nodeEnv === "production") return false;
  return matchesOriginHost(supplied, host) && supplied.protocol === protocol;
}

/** Keep identical cookie attributes for creation and expiry, including HTTP opt-in. */
export function sessionCookieOptions(
  host: string | null,
  protocol: string,
  nodeEnv: string | undefined,
  publicBaseUrl: string | undefined,
  allowPublicHttp: string | undefined,
) {
  const publicHttp = publicHttpOrigin(publicBaseUrl, allowPublicHttp);
  const configuredHttpRequest = !!publicHttp && !!host && matchesOriginHost(publicHttp, host) && protocol === "http:";
  return {
    httpOnly: true,
    secure: protocol === "https:" || (nodeEnv === "production" && !configuredHttpRequest),
    sameSite: "strict" as const,
    path: "/",
  };
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
