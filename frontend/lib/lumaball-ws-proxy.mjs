import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { Buffer } from "node:buffer";
import { URL } from "node:url";

/** This is a fixed-target WebSocket tunnel, never a user-controlled HTTP proxy. */
export function gameUpgradeRequest(request, environment, configuration) {
  const host = request.headers.host;
  const expected = new URL(environment.PUBLIC_BASE_URL);
  if (
    request.method !== "GET" ||
    request.headers.origin !== expected.origin ||
    typeof host !== "string" ||
    (host !== expected.host &&
      !(configuration.port === 80 && host === expected.hostname + ":80"))
  )
    return null;
  if (
    typeof request.url !== "string" ||
    request.url.length > 1024 ||
    !request.url.startsWith("/api/lumaball/ws?")
  )
    return null;
  const url = new URL(request.url, expected);
  if (
    url.pathname !== "/api/lumaball/ws" ||
    url.hash ||
    url.searchParams.getAll("room").length !== 1 ||
    url.searchParams.getAll("ticket").length !== 1 ||
    [...url.searchParams.keys()].some(
      (key) => key !== "room" && key !== "ticket",
    )
  )
    return null;
  if (
    !/^[a-f0-9]{32}$/.test(url.searchParams.get("room") || "") ||
    !/^[a-zA-Z0-9_-]{24,160}$/.test(url.searchParams.get("ticket") || "")
  )
    return null;
  if (
    request.headers.upgrade?.toLowerCase() !== "websocket" ||
    request.headers["sec-websocket-version"] !== "13" ||
    typeof request.headers["sec-websocket-key"] !== "string" ||
    !/^[a-zA-Z0-9+/]{22}==$/.test(request.headers["sec-websocket-key"])
  )
    return null;
  const proof = environment.BFF_PROXY_SECRET;
  if (typeof proof !== "string" || proof.length < 32) return null;
  const backend = new URL(environment.BACKEND_URL || "http://127.0.0.1:8000");
  if (
    backend.protocol !== "http:" ||
    backend.username ||
    backend.password ||
    backend.search ||
    backend.hash ||
    backend.pathname !== "/" ||
    !(
      backend.hostname === "127.0.0.1" ||
      (environment.QSTUDY_ACCESS_MODE === "proxy" &&
        backend.hostname === "backend")
    )
  )
    return null;
  const actual = request.socket.remoteAddress?.replace(/^::ffff:/, "");
  const ip =
    environment.QSTUDY_ACCESS_MODE === "proxy" &&
    environment.TRUST_PROXY_HEADERS === "true"
      ? request.headers["x-real-ip"]
      : actual;
  if (typeof ip !== "string" || !isIP(ip)) return null;
  return {
    hostname: backend.hostname,
    port: backend.port || "80",
    path: url.pathname + url.search,
    headers: {
      Host: backend.host,
      Connection: "Upgrade",
      Upgrade: "websocket",
      Origin: expected.origin,
      "Sec-WebSocket-Key": request.headers["sec-websocket-key"],
      "Sec-WebSocket-Version": "13",
      "X-QStudy-Proxy-Key": proof,
      "X-QStudy-Client-IP": ip,
    },
  };
}

export function createGameUpgradeProxy(environment, configuration) {
  const sockets = new Set();
  const reject = (socket, code = 403) => {
    if (!socket.destroyed)
      socket.end(
        `HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
      );
  };
  return {
    upgrade(request, socket, head) {
      let target;
      try {
        target = gameUpgradeRequest(request, environment, configuration);
      } catch {
        target = null;
      }
      if (!target || head.length > 24 * 1024 || sockets.size >= 256) {
        reject(socket);
        return;
      }
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.pause();
      const upstream = httpRequest({
        ...target,
        method: "GET",
        maxHeaderSize: 16384,
        timeout: 10_000,
      });
      let connected = false;
      socket.on("close", () => {
        if (!connected) upstream.destroy();
      });
      upstream.on("upgrade", (response, remote, remoteHead) => {
        if (socket.destroyed || response.statusCode !== 101) {
          remote.destroy();
          return;
        }
        connected = true;
        upstream.setTimeout(0);
        remote.setTimeout(0);
        sockets.add(remote);
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Connection: Upgrade",
          "Upgrade: websocket",
        ];
        const accept = response.headers["sec-websocket-accept"];
        if (
          typeof accept !== "string" ||
          !/^[a-zA-Z0-9+/]{27}=$/.test(accept)
        ) {
          remote.destroy();
          socket.destroy();
          return;
        }
        headers.push(
          "Sec-WebSocket-Accept: " + accept,
          "Cache-Control: no-store",
        );
        socket.write(Buffer.from(headers.join("\r\n") + "\r\n\r\n"));
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        remote.on("close", () => {
          sockets.delete(remote);
          socket.destroy();
        });
        remote.on("error", () => socket.destroy());
        socket.on("close", () => remote.destroy());
        socket.pipe(remote);
        remote.pipe(socket);
        socket.resume();
      });
      upstream.on("response", (response) => {
        response.resume();
        reject(socket, response.statusCode === 403 ? 403 : 502);
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!connected) reject(socket, 502);
      });
      upstream.end();
    },
    close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}
