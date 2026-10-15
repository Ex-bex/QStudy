import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeStopConfiguration,
  nativeStopRequested,
} from "./native-stop.mjs";

test("private stop watcher accepts only its exact project path and instance-bound stop receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "qstudy-native-stop-"));
  const directory = join(root, ".local", "managed");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const instance = "a".repeat(32);
  const path = join(directory, "frontend-stop-" + instance + ".json");
  const other = join(directory, "other.json");
  const environment = {
    QSTUDY_INSTANCE: instance,
    QSTUDY_FRONTEND_STOP_FILE: path,
  };
  try {
    assert.equal(nativeStopConfiguration({}, root), null);
    assert.throws(() =>
      nativeStopConfiguration(
        { ...environment, QSTUDY_INSTANCE: "../bad" },
        root,
      ),
    );
    assert.throws(() =>
      nativeStopConfiguration(
        {
          ...environment,
          QSTUDY_FRONTEND_STOP_FILE: join(root, "outside.json"),
        },
        root,
      ),
    );
    assert.throws(() =>
      nativeStopConfiguration(
        {
          ...environment,
          QSTUDY_FRONTEND_STOP_FILE: join(
            directory,
            "frontend-stop-" + "b".repeat(32) + ".json",
          ),
        },
        root,
      ),
    );
    const config = nativeStopConfiguration(environment, root);
    assert.equal(nativeStopRequested(config), false);
    for (const receipt of [
      "{invalid",
      JSON.stringify({ version: 1, instance, action: "restart" }),
      JSON.stringify({ version: 1, instance: "b".repeat(32), action: "stop" }),
      JSON.stringify({ version: 1, instance, action: "stop", extra: true }),
      "x".repeat(1025),
    ]) {
      writeFileSync(path, receipt, { mode: 0o600 });
      assert.equal(nativeStopRequested(config), false);
    }
    writeFileSync(
      path,
      JSON.stringify({ version: 1, instance, action: "stop" }),
      { mode: 0o600 },
    );
    assert.equal(nativeStopRequested(config), true);
    linkSync(path, other);
    assert.equal(
      nativeStopRequested(config),
      false,
      "hard-linked control receipt is never followed",
    );
    unlinkSync(other);
    assert.equal(nativeStopRequested(config), true);
  } finally {
    try {
      unlinkSync(other);
    } catch {
      /* The extra hard link may already be removed. */
    }
    try {
      unlinkSync(path);
    } catch {
      /* A rejected configuration may not create the file. */
    }
    rmdirSync(directory);
    rmdirSync(join(root, ".local"));
    rmdirSync(root);
  }
});
