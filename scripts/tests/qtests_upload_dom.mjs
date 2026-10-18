/**
 * React DOM regression tests for Word upload and replacement. No real accounts,
 * backend, documents, or AI requests are used; only the API/navigation are mocked.
 * The real components, React state/effects, FormData and DOM events are exercised.
 *
 * Run from the repository root with an isolated DOM test dependency:
 * npm install --prefix .local/qtests-ui-qa --no-save --package-lock=false --ignore-scripts jsdom@26.1.0
 * node scripts/tests/qtests_upload_dom.mjs --run --jsdom .local/qtests-ui-qa/node_modules/jsdom
 * If jsdom is already installed in frontend, --jsdom is optional.
 */
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--run")) {
  console.log(
    "SKIP: opt in with --run. Supply --jsdom <installed jsdom package path> if it is not installed in frontend.",
  );
  process.exit(0);
}
const project = fileURLToPath(new URL("../..", import.meta.url));
const appRequire = Module.createRequire(
  path.join(project, "frontend/package.json"),
);
const scriptRequire = Module.createRequire(import.meta.url);
const dependencyArgument = process.argv.indexOf("--jsdom");
let JSDOM;
try {
  if (dependencyArgument !== -1 && !process.argv[dependencyArgument + 1]) {
    throw new Error("--jsdom requires the path to an installed jsdom package.");
  }
  ({ JSDOM } =
    dependencyArgument === -1
      ? appRequire("jsdom")
      : scriptRequire(
          path.resolve(process.cwd(), process.argv[dependencyArgument + 1]),
        ));
} catch (cause) {
  console.error(
    "Cannot load DOM test dependency. Install jsdom in an isolated directory and pass --jsdom <package path>. See the script header.",
  );
  console.error(cause.message);
  process.exit(1);
}
const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "http://localhost/qtests/library" },
);
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "FormData",
  "File",
  "Event",
  "MouseEvent",
  "CustomEvent",
  "Node",
])
  global[key] = dom.window[key];
Object.defineProperty(global, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = appRequire("react");
const { act } = React;
const { createRoot } = appRequire("react-dom/client");
const ts = appRequire("typescript");
const lesson = {
  id: 12,
  title: "История",
  description: "",
  bank_count: 0,
  question_count: 0,
};
const empty = {
  banks: [],
  lessons: [lesson],
  attempts: [],
  stats: { banks: 0, questions: 0, attempts: 0, finished: 0 },
  ai_available: true,
};
const savedBank = {
  id: 52,
  title: "Существующий банк",
  filename: "saved.docx",
  status: "ready",
  answer_mode: "first",
  question_count: 1,
  warnings: [],
  error: null,
  created_at: "2026-10-20T01:00:00Z",
  updated_at: "2026-10-20T01:00:00Z",
  questions: [
    {
      id: 7,
      order: 0,
      question: "Два плюс два?",
      options: ["4", "5"],
      correct_index: 0,
      explanation: "",
    },
  ],
  lesson_id: null,
  lesson_title: null,
  has_document: true,
};
let apiCalls = [],
  navigations = [],
  failUpload = false,
  holdUpload = null;
const api = async (url, options = {}) => {
  apiCalls.push({ url, options });
  if (url === "/qtests/overview") return empty;
  if (url === "/qtests/config") return { default_question_count: 40 };
  if (url.startsWith("/qtests/lessons")) return [lesson];
  if (url === "/qtests/banks/52" && !options.method) return savedBank;
  if (
    (url === "/qtests/banks" || url === "/qtests/banks/52/document") &&
    options.method === "POST"
  ) {
    if (failUpload)
      throw new Error("Сервер не принял документ. Проверьте файл.");
    if (holdUpload) await holdUpload;
    return { bank: savedBank, job_id: "job-52" };
  }
  throw new Error("Unexpected API " + url);
};
const modules = new Map();
function load(relative) {
  const filename = path.join(project, "frontend", relative);
  if (modules.has(filename)) return modules.get(filename).exports;
  const target = new Module(filename);
  modules.set(filename, target);
  target.filename = filename;
  target.paths = Module._nodeModulePaths(path.dirname(filename));
  target.require = (request) => {
    if (request === "@/lib/api")
      return { api, formatBytes: (value) => `${value} Б` };
    if (request === "@/lib/auth")
      return {
        useAuth: () => ({ user: { name: "Студент", role: "student" } }),
      };
    if (request === "next/navigation")
      return {
        useRouter: () => ({ push: (value) => navigations.push(value) }),
      };
    if (request === "next/link")
      return {
        __esModule: true,
        default: ({ children, ...props }) =>
          React.createElement("a", props, children),
      };
    if (request.endsWith(".css"))
      return {
        __esModule: true,
        default: new Proxy({}, { get: (_, key) => key }),
      };
    if (request.startsWith("@/")) return load(request.slice(2) + ".ts");
    if (request.startsWith(".")) {
      let resolved = path.join(path.dirname(relative), request);
      if (!/\.[cm]?[jt]sx?$/.test(resolved))
        resolved += fs.existsSync(
          path.join(project, "frontend", resolved + ".tsx"),
        )
          ? ".tsx"
          : ".ts";
      return load(resolved);
    }
    return appRequire(request);
  };
  target._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    filename,
  );
  return target.exports;
}
let root;
async function flush(action = () => {}) {
  await act(async () => {
    await action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function mount(name, props = {}) {
  if (root) await flush(() => root.unmount());
  document.getElementById("root").innerHTML = "";
  root = createRoot(document.getElementById("root"));
  apiCalls = [];
  navigations = [];
  failUpload = false;
  holdUpload = null;
  const View = load("components/qtests/" + name + ".tsx").default;
  await flush(() => root.render(React.createElement(View, props)));
}
const input = () => document.querySelector("input[type=file]");
const uploadForm = () =>
  document.querySelector('form[aria-label="Загрузка банка вопросов из Word"]');
const replacementForm = () =>
  document.querySelector('form[aria-label="Замена документа Word"]');
async function select(file) {
  await flush(() => {
    Object.defineProperty(input(), "files", {
      configurable: true,
      value: [file],
    });
    input().dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function submit(form) {
  await flush(() =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
}
async function focusRefresh() {
  await flush(() => window.dispatchEvent(new Event("focus")));
}
const word = (name = "300 вопросов.docx") =>
  new File(["word-zip-fixture"], name, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
const posts = () => apiCalls.filter((call) => call.options.method === "POST");
(async () => {
  await mount("library");
  assert.equal(input().closest("label").htmlFor, input().id);
  await submit(uploadForm());
  assert.match(uploadForm().textContent, /Сначала выберите/);
  assert.equal(posts().length, 0);
  await select(
    new File(["legacy"], "Банк.doc", { type: "application/msword" }),
  );
  assert.match(uploadForm().textContent, /Сохранить как/);
  await focusRefresh();
  assert.match(uploadForm().textContent, /Сохранить как/);
  assert.equal(input().getAttribute("aria-invalid"), "true");
  await select(word("🧪".repeat(210) + ".docx"));
  assert.equal(input().getAttribute("aria-invalid"), "false");
  const lessonSelect = Array.from(uploadForm().querySelectorAll("select")).find(
    (select) =>
      Array.from(select.options).some((option) => option.value === "12"),
  );
  await flush(() => {
    lessonSelect.value = "12";
    lessonSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  failUpload = true;
  await submit(uploadForm());
  assert.equal(posts().length, 1);
  const sent = posts()[0].options.body;
  assert.equal(sent.get("file").name, "🧪".repeat(210) + ".docx");
  assert.equal(Array.from(sent.get("title")).length, 180);
  assert.equal(sent.get("answer_mode"), "first");
  assert.equal(sent.get("lesson_id"), "12");
  assert.match(uploadForm().textContent, /Сервер не принял/);
  await focusRefresh();
  assert.match(uploadForm().textContent, /Сервер не принял/);
  failUpload = false;
  await submit(uploadForm());
  assert.equal(posts().length, 2);
  assert.deepEqual(navigations, ["/qtests/banks/52"]);
  await mount("library");
  await select(word());
  const dropzone = input().closest("label");
  const invalidDrop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(invalidDrop, "dataTransfer", {
    value: { files: [new File(["wrong"], "Неверный.pdf")] },
  });
  await flush(() => dropzone.dispatchEvent(invalidDrop));
  await submit(uploadForm());
  assert.equal(posts().length, 0);
  assert.match(uploadForm().textContent, /Сначала выберите/);
  const dropped = word("из перетаскивания.docx");
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [dropped] } });
  await flush(() => dropzone.dispatchEvent(drop));
  let release;
  holdUpload = new Promise((resolve) => (release = resolve));
  await submit(uploadForm());
  assert.equal(uploadForm().getAttribute("aria-busy"), "true");
  assert.match(uploadForm().textContent, /Передаём Word/);
  assert.equal(input().disabled, true);
  await flush(() => release());
  assert.equal(posts()[0].options.body.get("file").name, dropped.name);
  assert.deepEqual(navigations, ["/qtests/banks/52"]);
  await mount("bank", { bankId: 52 });
  const details = document.querySelector("details.replaceDocument");
  if (details) details.open = true;
  await select(new File(["legacy"], "Банк.doc"));
  await focusRefresh();
  assert.match(replacementForm().textContent, /Сохранить как/);
  await select(word("замена.docx"));
  await submit(replacementForm());
  assert.match(document.body.textContent, /Обновить вопросы из/);
  const confirm = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent.includes("Да, обновить банк"),
  );
  failUpload = true;
  await flush(() => confirm.click());
  assert.match(replacementForm().textContent, /Сервер не принял/);
  await focusRefresh();
  assert.match(replacementForm().textContent, /Сервер не принял/);
  failUpload = false;
  await flush(() => confirm.click());
  assert.equal(posts().at(-1).url, "/qtests/banks/52/document");
  assert.equal(posts().at(-1).options.body.get("file").name, "замена.docx");
  assert.equal(posts().at(-1).options.body.get("answer_mode"), "first");
  await flush(() => root.unmount());
  console.log(
    "PASS: native file control, missing/legacy file, local errors survive focus refresh, exact FormData, 180-character title, lesson/answer mode, retry, drag/drop invalid clears stalefile, upload busy feedback, safe replacement confirmation + API error/retry.",
  );
})().catch(async (error) => {
  console.error(error);
  if (root) await flush(() => root.unmount());
  process.exitCode = 1;
});
