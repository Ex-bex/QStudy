import { isIP } from "node:net";
import { URL } from "node:url";

export function nativeServerConfiguration(environment, args) {
  if (!["local", "lan", "internet"].includes(environment.QSTUDY_ACCESS_MODE))
    throw new Error("Invalid native access mode");
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--hostname", "--port"].includes(args[i]) ||
      !args[i + 1] ||
      options[args[i]]
    )
      throw new Error("Invalid native frontend options");
    options[args[i]] = args[i + 1];
  }
  const bind = options["--hostname"];
  const port = Number(options["--port"]);
  if (
    !["127.0.0.1", "0.0.0.0"].includes(bind) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    String(port) !== options["--port"]
  )
    throw new Error("Invalid native listener");
  const literal =
    /^http:\/\/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([1-9][0-9]{0,4})\/?$/.exec(
      environment.PUBLIC_BASE_URL || "",
    );
  if (!literal || isIP(literal[1]) !== 4 || Number(literal[2]) !== port)
    throw new Error("Invalid native site address");
  const [a, b, c, d] = literal[1].split(".").map(Number);
  const privateIP =
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  const nonglobal =
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
  const mode = environment.QSTUDY_ACCESS_MODE;
  if (mode === "local" && (bind !== "127.0.0.1" || literal[1] !== "127.0.0.1"))
    throw new Error("Local mode must remain on loopback");
  if (mode === "lan" && (bind !== "0.0.0.0" || !privateIP))
    throw new Error("LAN mode requires a private address");
  if (
    mode === "internet" &&
    (bind !== "0.0.0.0" ||
      nonglobal ||
      environment.ALLOW_PUBLIC_HTTP !== "true")
  )
    throw new Error("Internet HTTP requires explicit public address opt-in");
  const origin = new URL(environment.PUBLIC_BASE_URL);
  return { bind, port, authority: origin.host, hostname: origin.hostname };
}

export function prepareNativeRequest(request, configuration) {
  const hostCount = request.rawHeaders.reduce(
    (count, value, i) =>
      count + (i % 2 === 0 && value.toLowerCase() === "host" ? 1 : 0),
    0,
  );
  const host = request.headers.host;
  const expected = configuration.authority;
  if (
    hostCount !== 1 ||
    typeof host !== "string" ||
    (host !== expected &&
      !(configuration.port === 80 && host === configuration.hostname + ":80"))
  )
    return false;
  if (
    !request.url?.startsWith("/") ||
    request.url.startsWith("//") ||
    request.url.includes("\\")
  )
    return false;
  const remote = request.socket.remoteAddress;
  const clientIP =
    typeof remote === "string" &&
    remote.startsWith("::ffff:") &&
    isIP(remote.slice(7)) === 4
      ? remote.slice(7)
      : remote;
  if (!clientIP || !isIP(clientIP)) return false;
  for (const key of Object.keys(request.headers)) {
    if (
      key === "forwarded" ||
      key === "x-real-ip" ||
      key.startsWith("x-forwarded-") ||
      key.startsWith("x-qstudy-")
    )
      delete request.headers[key];
  }
  // Next sees only server-owned forwarding metadata. The BFF signs this socket
  // address before the API uses it for rate limits; a browser cannot supply it.
  request.headers["x-real-ip"] = clientIP;
  request.headers["x-forwarded-proto"] = "http";
  request.headers["x-forwarded-host"] = expected;
  request.headers["x-forwarded-port"] = String(configuration.port);
  const raw = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const key = request.rawHeaders[i].toLowerCase();
    if (
      key === "forwarded" ||
      key === "x-real-ip" ||
      key.startsWith("x-forwarded-") ||
      key.startsWith("x-qstudy-")
    )
      continue;
    raw.push(request.rawHeaders[i], request.rawHeaders[i + 1]);
  }
  raw.push(
    "x-real-ip",
    clientIP,
    "x-forwarded-proto",
    "http",
    "x-forwarded-host",
    expected,
    "x-forwarded-port",
    String(configuration.port),
  );
  request.rawHeaders = raw;
  return true;
}

/** A separate explicit mode for the unpublished Docker listener behind Caddy. */
export function privateProxyConfiguration(environment, args) {
  if (
    environment.QSTUDY_ACCESS_MODE !== "proxy" ||
    environment.TRUST_PROXY_HEADERS !== "true"
  )
    throw new Error("Private proxy mode must be explicitly configured");
  const origin = new URL(environment.PUBLIC_BASE_URL);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (origin.protocol === "http:" && environment.ALLOW_PUBLIC_HTTP !== "true")
  )
    throw new Error("Invalid private proxy origin");
  if (
    args.length !== 4 ||
    args[0] !== "--hostname" ||
    args[1] !== "0.0.0.0" ||
    args[2] !== "--port" ||
    args[3] !== "3000"
  )
    throw new Error("Invalid private proxy listener");
  return {
    bind: "0.0.0.0",
    port: 3000,
    authority: origin.host,
    hostname: origin.hostname,
    protocol: origin.protocol,
  };
}

export function preparePrivateProxyRequest(request, configuration) {
  const hostCount = request.rawHeaders.reduce(
    (count, value, i) =>
      count + (i % 2 === 0 && value.toLowerCase() === "host" ? 1 : 0),
    0,
  );
  const host = request.headers.host;
  const socketIP = request.socket.remoteAddress?.replace(/^::ffff:/, "");
  const health =
    request.method === "GET" &&
    request.url === "/api/health" &&
    socketIP === "127.0.0.1" &&
    host === "127.0.0.1:3000";
  const defaultPort = configuration.protocol === "https:" ? "443" : "80";
  if (
    hostCount !== 1 ||
    typeof host !== "string" ||
    (!health &&
      host !== configuration.authority &&
      !(
        host === configuration.hostname + ":" + defaultPort &&
        !configuration.authority.includes(":")
      ))
  )
    return false;
  if (
    !request.url?.startsWith("/") ||
    request.url.startsWith("//") ||
    request.url.includes("\\")
  )
    return false;
  const clientIP = health
    ? "127.0.0.1"
    : request.headers["x-real-ip"] ||
      (socketIP === "127.0.0.1" ? "127.0.0.1" : undefined);
  // The frontend service has no published port. Caddy alone supplies X-Real-IP.
  if (typeof clientIP !== "string" || !isIP(clientIP)) return false;
  for (const key of Object.keys(request.headers))
    if (
      key === "forwarded" ||
      key.startsWith("x-forwarded-") ||
      key.startsWith("x-qstudy-")
    )
      delete request.headers[key];
  request.headers["x-real-ip"] = clientIP;
  request.headers["x-forwarded-proto"] = configuration.protocol.slice(0, -1);
  request.headers["x-forwarded-host"] = configuration.authority;
  request.headers["x-forwarded-port"] =
    new URL(configuration.protocol + "//" + configuration.authority).port ||
    defaultPort;
  const raw = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const key = request.rawHeaders[i].toLowerCase();
    if (
      key === "forwarded" ||
      key === "x-real-ip" ||
      key.startsWith("x-forwarded-") ||
      key.startsWith("x-qstudy-")
    )
      continue;
    raw.push(request.rawHeaders[i], request.rawHeaders[i + 1]);
  }
  for (const key of [
    "x-real-ip",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-forwarded-port",
  ])
    raw.push(key, request.headers[key]);
  request.rawHeaders = raw;
  return true;
}
