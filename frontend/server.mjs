import { createServer } from "node:http";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";
import { setTimeout, setInterval, clearInterval } from "node:timers";
import next from "next";
import {
  nativeServerConfiguration,
  prepareNativeRequest,
} from "./lib/native-server.mjs";
import {
  nativeStopConfiguration,
  nativeStopRequested,
} from "./lib/native-stop.mjs";

async function main() {
  const configuration = nativeServerConfiguration(
    process.env,
    process.argv.slice(2),
  );
  const stopConfiguration = nativeStopConfiguration(
    process.env,
    fileURLToPath(new URL("..", import.meta.url)),
  );
  const app = next({
    dev: false,
    dir: fileURLToPath(new URL(".", import.meta.url)),
    hostname: configuration.bind,
    port: configuration.port,
  });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = createServer(
    { maxHeaderSize: 16384, requestTimeout: 30 * 60_000 },
    (request, response) => {
      if (!prepareNativeRequest(request, configuration)) {
        response.writeHead(421, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end("Откройте QStudy по адресу, указанному в окне запуска.");
        return;
      }
      handle(request, response).catch(() => {
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(
            JSON.stringify({ detail: "Не удалось обработать запрос QStudy" }),
          );
        }
      });
    },
  );
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("error", () => {
    console.error("QStudy: frontend listener failed. Check the selected port.");
    void app.close().finally(() => process.exit(1));
  });
  server.listen(configuration.port, configuration.bind);
  let stopping = false;
  let stopWatcher;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (stopWatcher) clearInterval(stopWatcher);
    const deadline = setTimeout(() => process.exit(1), 15_000);
    deadline.unref();
    server.close(() => {
      void app.close().finally(() => process.exit(0));
    });
  };
  if (stopConfiguration) {
    stopWatcher = setInterval(() => {
      if (nativeStopRequested(stopConfiguration)) stop();
    }, 200);
    stopWatcher.unref();
  }
  for (const event of process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM"])
    process.on(event, stop);
}
main().catch(() => {
  console.error(
    "QStudy: frontend could not start. Check the launch report and build.",
  );
  process.exitCode = 1;
});
