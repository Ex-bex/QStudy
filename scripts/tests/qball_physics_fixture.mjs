/** Disposable integration adapter for the actual browser FootballEngine.
 *
 * Only the engine's public constructor/input/advance/frame methods are used.
 * No test can set coordinates, velocities, timers, scores, or finished state.
 * JSON lines stay on private pipes; room IDs never appear in shared test logs.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const frontend = new URL("../../frontend/", import.meta.url);
const require = createRequire(new URL("package.json", frontend));
const ts = require("typescript");
const source = await readFile(new URL("lib/lumaball/engine.ts", frontend), "utf8");
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
  fileName: fileURLToPath(new URL("lib/lumaball/engine.ts", frontend)),
}).outputText.replace(
  /from (["'])planck\1/g,
  `from "${new URL("node_modules/planck/dist/planck.mjs", frontend).href}"`,
);
const { FootballEngine, validFrame } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);

let engine;
let matchId;
let members;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    if (line.length > 24 * 1024) throw new Error("invalid-command");
    const value = JSON.parse(line);
    if (value.action === "start" && !engine) {
      const room = value.room;
      if (!room || room.status !== "playing" || !room.match_id)
        throw new Error("invalid-room");
      members = new Set(room.members.map((member) => member.id));
      engine = new FootballEngine(room.members, room.score_limit, room.time_limit);
      matchId = room.match_id;
    } else if (value.action === "step" && engine) {
      if (!Array.isArray(value.inputs) || value.inputs.length > 16 ||
          !Number.isFinite(value.seconds) || value.seconds <= 0 || value.seconds > 0.2)
        throw new Error("invalid-step");
      for (const item of value.inputs) {
        if (!members.has(item.id)) throw new Error("invalid-member");
        engine.input(item.id, item.input);
      }
      engine.advance(value.seconds);
    } else throw new Error("invalid-command");
    const frame = engine.frame();
    frame.match_id = matchId;
    if (!validFrame(frame)) throw new Error("invalid-engine-frame");
    process.stdout.write(JSON.stringify({ source_sha256: sourceSha256, frame }) + "\n");
  } catch {
    // Do not echo arbitrary input or module diagnostics to shared CI output.
    process.stdout.write('{"error":"physics-fixture-command-failed"}\n');
    process.exitCode = 1;
    break;
  }
}
