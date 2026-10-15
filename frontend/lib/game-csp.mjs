import { URL } from "node:url";

/** Configuration has already passed the native/private-proxy origin gate. */
export function gameWebSocketOrigin(configuration) {
  const protocol = configuration.protocol || "http:";
  if (!["http:", "https:"].includes(protocol))
    throw new Error("Invalid game policy protocol");
  const origin = new URL(protocol + "//" + configuration.authority);
  if (
    origin.host !== configuration.authority ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid game policy authority");
  return (protocol === "https:" ? "wss://" : "ws://") + origin.host;
}

function extendPolicy(policy, webSocketOrigin) {
  const directives = policy.trim().split(";");
  let hasConnect = false;
  let fallback;
  for (let index = 0; index < directives.length; index++) {
    const tokens = directives[index].trim().split(/\s+/);
    if (tokens[0].toLowerCase() === "default-src" && !fallback)
      fallback = tokens.slice(1);
    if (tokens[0].toLowerCase() !== "connect-src") continue;
    hasConnect = true;
    // Preserve an explicit restrictive policy; only make its existing 'self'
    // allowance unambiguous for browsers that distinguish http(s) and ws(s).
    if (
      tokens.includes("'self'") &&
      !tokens.includes("'none'") &&
      !tokens.includes(webSocketOrigin)
    ) {
      tokens.push(webSocketOrigin);
      directives[index] = tokens.join(" ");
    }
  }
  if (
    !hasConnect &&
    fallback?.includes("'self'") &&
    !fallback.includes("'none'")
  )
    directives.push(["connect-src", ...fallback, webSocketOrigin].join(" "));
  return directives
    .map((value) => value.trim())
    .filter(Boolean)
    .join("; ");
}

export function gameContentSecurityPolicy(values, configuration) {
  const origin = gameWebSocketOrigin(configuration);
  const policies = (Array.isArray(values) ? values : [values])
    .filter((value) => typeof value === "string")
    .flatMap((value) => value.split(","))
    .filter((value) => value.trim())
    .map((value) => extendPolicy(value, origin));
  // Existing separate policies retain their intersection. Do not append a new
  // independent policy while leaving Next's original restrictive one in place.
  return [...new Set(policies)].join(", ");
}

/** Apply at the actual header commit, after Next's build-time headers. */
export function prepareGameResponse(response, configuration) {
  const original = response.writeHead;
  response.writeHead = function (...args) {
    const values = [this.getHeader("Content-Security-Policy")];
    const index =
      typeof args[1] === "string" || (args[1] == null && args[2]) ? 2 : 1;
    const supplied = args[index];
    if (Array.isArray(supplied)) {
      const headers = [];
      for (let offset = 0; offset < supplied.length; offset += 2) {
        if (
          String(supplied[offset]).toLowerCase() === "content-security-policy"
        )
          values.push(supplied[offset + 1]);
        else headers.push(supplied[offset], supplied[offset + 1]);
      }
      args[index] = headers;
    } else if (supplied && typeof supplied === "object") {
      const headers = {};
      for (const [name, value] of Object.entries(supplied)) {
        if (name.toLowerCase() === "content-security-policy")
          values.push(value);
        else headers[name] = value;
      }
      args[index] = headers;
    }
    const policy = gameContentSecurityPolicy(values.flat(), configuration);
    if (policy) this.setHeader("Content-Security-Policy", policy);
    return original.apply(this, args);
  };
}
