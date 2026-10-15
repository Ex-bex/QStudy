import { lstatSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { Buffer } from "node:buffer";
import { resolve, join } from "node:path";
import process from "node:process";

function ordinaryDirectory(path) {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("Invalid private control directory");
}

export function nativeStopConfiguration(environment, projectRoot) {
  const supplied = environment.QSTUDY_FRONTEND_STOP_FILE;
  const instance = environment.QSTUDY_INSTANCE;
  if (!supplied && !instance) return null;
  if (typeof supplied !== "string" || !/^[a-f0-9]{32}$/.test(instance || ""))
    throw new Error("Invalid private stop configuration");
  const root = resolve(projectRoot);
  const directory = join(root, ".local", "managed");
  const expected = join(directory, "frontend-stop-" + instance + ".json");
  const samePath =
    process.platform === "win32"
      ? resolve(supplied).toLowerCase() === expected.toLowerCase()
      : resolve(supplied) === expected;
  if (!samePath)
    throw new Error("Private stop file must belong to this project instance");
  for (const path of [root, join(root, ".local"), directory])
    ordinaryDirectory(path);
  return { root, directory, path: expected, instance };
}

export function nativeStopRequested(configuration) {
  if (!configuration) return false;
  let descriptor;
  try {
    for (const path of [
      configuration.root,
      join(configuration.root, ".local"),
      configuration.directory,
    ])
      ordinaryDirectory(path);
    const entry = lstatSync(configuration.path);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1 ||
      entry.size < 1 ||
      entry.size > 1024
    )
      return false;
    descriptor = openSync(configuration.path, "r");
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino ||
      opened.size > 1024 ||
      opened.nlink !== 1
    )
      return false;
    const bytes = Buffer.alloc(1025);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length < 1 || length > 1024) return false;
    const value = JSON.parse(
      bytes.toString("utf8", 0, length).replace(/^\uFEFF/, ""),
    );
    return (
      value !== null &&
      typeof value === "object" &&
      Object.keys(value).length === 3 &&
      value.version === 1 &&
      value.instance === configuration.instance &&
      value.action === "stop"
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
