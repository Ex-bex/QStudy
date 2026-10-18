/**
 * React DOM tests for the QForce team directory and director photo upload. No real accounts or backend are used. API, Next.js image/link and logo boundaries
 * are mocked. The real page/components, branding URL validation, React state/effects,
 * FormData and DOM events are exercised. This is not browser visual testing.
 *
 * Run from the repository root with an isolated DOM test dependency:
 * npm install --prefix .local/qtests-ui-qa --no-save --package-lock=false --ignore-scripts jsdom@26.1.0
 * node scripts/tests/qforce_dom.mjs --run --jsdom .local/qtests-ui-qa/node_modules/jsdom
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
  { url: "http://localhost/" },
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
const makePhoto = (letter) =>
  `/api/branding/assets/director-2/${letter.repeat(64)}.png`;
const firstPhoto = makePhoto("a");
const changedPhoto = makePhoto("b");
const department = {
  id: 2,
  name: "QForce Coding",
  director: "Ирина Павлова",
  description: "Разработка проектов экосистемы.",
  email: "coding@example.test",
  telegram: "https://t.me/qforcecoding",
  website: "",
  logo: "coding",
  logo_url: "/brand/qforce_logo_coding.jpeg",
  logo_custom: false,
  director_photo_url: firstPhoto,
  director_photo_custom: true,
  display_order: 2,
};
const press = {
  ...department,
  id: 3,
  name: "QForce Press",
  director: "Андрей Соколов",
  logo: "press",
  logo_url: "/brand/qforce_logo_press.jpeg",
  director_photo_url: null,
  director_photo_custom: false,
  display_order: 1,
  telegram: "",
};
let directoryBody = { departments: [department, press] };
let failDirectory = false;
let directoryHold = null;
let fetchCalls = [];
global.fetch = async (url, options = {}) => {
  fetchCalls.push({ url, options });
  assert.equal(url, "/api/developers");
  assert.equal(options.cache, "no-store");
  assert.equal(options.credentials, "same-origin");
  if (directoryHold) await directoryHold;
  if (failDirectory) return { ok: false, status: 503 };
  return { ok: true, json: async () => directoryBody };
};
let savedDepartment = department;
let failPhoto = false;
let photoHold = null;
let apiCalls = [];
let savedCalls = [];
const api = async (url, options = {}) => {
  apiCalls.push({ url, options });
  assert.equal(url, "/branding/departments/2/director-photo");
  if (photoHold) await photoHold;
  if (failPhoto)
    throw new Error("Фотографию не удалось сохранить. Повторите попытку.");
  if (options.method === "PUT")
    return { ...department, director_photo_url: changedPhoto };
  assert.equal(options.method, "DELETE");
  return {
    ...department,
    director_photo_url: null,
    director_photo_custom: false,
  };
};
let objectUrlIndex = 0;
const revoked = [];
URL.createObjectURL = () => `blob:qforce-test-${++objectUrlIndex}`;
URL.revokeObjectURL = (value) => revoked.push(value);
const modules = new Map();
const ImageMock = ({ fill, unoptimized, priority, ...props }) =>
  React.createElement("img", props);
const LogoMock = ({ kind, ...props }) =>
  React.createElement(ImageMock, {
    ...props,
    src: `/test-logo-${kind || "project"}.png`,
  });
function load(relative) {
  const filename = path.join(project, "frontend", relative);
  if (modules.has(filename)) return modules.get(filename).exports;
  const target = new Module(filename);
  modules.set(filename, target);
  target.filename = filename;
  target.paths = Module._nodeModulePaths(path.dirname(filename));
  target.require = (request) => {
    if (request === "@/lib/api") return { api };
    if (request === "next/image")
      return { __esModule: true, default: ImageMock };
    if (request === "next/link")
      return {
        __esModule: true,
        default: ({ children, ...props }) =>
          React.createElement("a", props, children),
      };
    if (request === "@/components/ecosystem-branding")
      return { EcosystemLogo: LogoMock };
    if (request === "@/components/project-logo")
      return { ProjectLogo: LogoMock };
    if (request === "@/components/qtests-brand")
      return { QTestsLogo: LogoMock };
    if (request.endsWith(".css"))
      return {
        __esModule: true,
        default: new Proxy({}, { get: (_, key) => key }),
      };
    let resolved;
    if (request.startsWith("@/")) resolved = request.slice(2);
    else if (request.startsWith("."))
      resolved = path.join(path.dirname(relative), request);
    if (resolved) {
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
async function mount(Component, props = {}) {
  if (root) await flush(() => root.unmount());
  document.getElementById("root").innerHTML = "";
  root = createRoot(document.getElementById("root"));
  await flush(() => root.render(React.createElement(Component, props)));
}
function PhotoHarness() {
  const [value, setValue] = React.useState(savedDepartment);
  const Upload = load("components/director-photo-upload.tsx").default;
  return React.createElement(Upload, {
    department: value,
    onSaved: (next) => {
      savedCalls.push(next);
      setValue(next);
    },
  });
}
const team = () => document.getElementById("team");
const currentInput = () => document.querySelector("input[type=file]");
const byText = (text) =>
  Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent.includes(text),
  );
async function select(file) {
  await flush(() => {
    Object.defineProperty(currentInput(), "files", {
      configurable: true,
      value: [file],
    });
    currentInput().dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function submit() {
  await flush(() =>
    document
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
(async () => {
  const Home = load("components/qforce/home.tsx").default;
  let releaseDirectory;
  directoryHold = new Promise((resolve) => (releaseDirectory = resolve));
  await mount(Home);
  assert.match(team().textContent, /Знакомим с командой/);
  await flush(() => releaseDirectory());
  directoryHold = null;
  assert.deepEqual(
    Array.from(team().querySelectorAll("article h3")).map(
      (heading) => heading.textContent,
    ),
    [press.director, department.director],
  );
  assert.match(team().textContent, /QForce Coding/);
  assert.match(team().textContent, /QForce Press/);
  assert.equal(
    team()
      .querySelector(`img[alt="Фото: ${department.director}"]`)
      .getAttribute("src"),
    firstPhoto,
  );
  assert.match(team().textContent, /Фото скоро появится/);
  assert.equal(
    team().querySelector('a[href="https://t.me/qforcecoding"]').rel,
    "noopener noreferrer",
  );
  assert.equal(
    team()
      .querySelector('a[href="mailto:coding%40example.test"]')
      .getAttribute("href"),
    "mailto:coding%40example.test",
  );
  for (const [name, href] of [
    ["QStudy", "/qstudy"],
    ["QTests", "/qtests"],
    ["QCareer", "/qcareer"],
    ["QBall", "/qball"],
    ["Q-ID", "/login"],
    ["QControl", "/qcontrol"],
  ]) {
    assert.equal(
      document.querySelector(`a[aria-label^="${name} —"]`).getAttribute("href"),
      href,
    );
  }
  const photoImage = team().querySelector(
    `img[alt="Фото: ${department.director}"]`,
  );
  await flush(() => photoImage.dispatchEvent(new Event("error")));
  assert.equal(
    team().querySelector(`img[alt="Фото: ${department.director}"]`),
    null,
  );
  assert.match(team().textContent, /ИП/);
  directoryBody = {
    departments: [{ ...department, director_photo_url: changedPhoto }],
  };
  await flush(() => window.dispatchEvent(new Event("qstudy:branding-updated")));
  assert.equal(
    team()
      .querySelector(`img[alt="Фото: ${department.director}"]`)
      .getAttribute("src"),
    changedPhoto,
  );
  const countBeforeStorage = fetchCalls.length;
  directoryBody = {
    departments: [
      {
        ...department,
        director_photo_url: "https://example.test/untrusted.png",
      },
    ],
  };
  await flush(() =>
    window.dispatchEvent(
      new dom.window.StorageEvent("storage", {
        key: "qstudy:branding-updated",
        newValue: "changed",
      }),
    ),
  );
  assert.equal(fetchCalls.length, countBeforeStorage + 1);
  assert.equal(
    team().querySelector('img[src="https://example.test/untrusted.png"]'),
    null,
  );
  assert.match(team().textContent, /ИП/);
  directoryBody = { departments: [] };
  await flush(() => window.dispatchEvent(new Event("qstudy:branding-updated")));
  assert.match(team().textContent, /Скоро здесь появятся подразделения/);
  failDirectory = true;
  await flush(() => window.dispatchEvent(new Event("qstudy:branding-updated")));
  assert.match(
    team().querySelector('[role="alert"]').textContent,
    /Не удалось загрузить команду/,
  );
  failDirectory = false;
  directoryBody = {
    departments: [
      department,
      null,
      { id: -1, name: "invalid" },
      { id: 7, name: 7 },
    ],
  };
  await flush(() => byText("Обновить").click());
  assert.equal(team().querySelectorAll("article").length, 1);
  directoryBody = { unexpected: [] };
  await flush(() => window.dispatchEvent(new Event("qstudy:branding-updated")));
  assert.match(
    team().querySelector('[role="alert"]').textContent,
    /Не удалось загрузить команду/,
  );
  directoryBody = { departments: [department] };
  await flush(() => byText("Обновить").click());
  assert.match(team().textContent, /Ирина Павлова/);

  await mount(PhotoHarness);
  assert.equal(document.querySelector("label").htmlFor, currentInput().id);
  await submit();
  assert.match(
    document.querySelector('[role="alert"]').textContent,
    /Сначала выберите фотографию/,
  );
  await select(new File(["svg"], "wrong.svg", { type: "image/svg+xml" }));
  assert.match(
    document.querySelector('[role="alert"]').textContent,
    /PNG или JPEG/,
  );
  assert.equal(apiCalls.length, 0);
  const png = new File(["fake-png-for-ui-events"], "director.png", {
    type: "image/png",
  });
  await select(png);
  const preview = document.querySelector("img").getAttribute("src");
  assert.match(preview, /^blob:qforce-test-/);
  failPhoto = true;
  await submit();
  assert.equal(apiCalls[0].options.method, "PUT");
  assert.equal(apiCalls[0].options.body.get("file").name, "director.png");
  assert.equal(apiCalls[0].options.body.get("file").size, png.size);
  assert.match(
    document.querySelector('[role="alert"]').textContent,
    /Повторите попытку/,
  );
  assert.equal(document.querySelector("img").getAttribute("src"), preview);
  failPhoto = false;
  let releasePhoto;
  photoHold = new Promise((resolve) => (releasePhoto = resolve));
  await submit();
  assert.equal(currentInput().disabled, true);
  assert.match(byText("Сохраняем").textContent, /Сохраняем/);
  await flush(() => releasePhoto());
  photoHold = null;
  assert.equal(savedCalls.length, 1);
  assert.equal(document.querySelector("img").getAttribute("src"), changedPhoto);
  assert.equal(revoked.includes(preview), true);
  assert.match(
    document.querySelector('[role="status"]').textContent,
    /опубликована/,
  );
  failPhoto = true;
  await flush(() => byText("Убрать фото").click());
  assert.equal(apiCalls.at(-1).options.method, "DELETE");
  assert.match(
    document.querySelector('[role="alert"]').textContent,
    /Повторите попытку/,
  );
  assert.equal(document.querySelector("img").getAttribute("src"), changedPhoto);
  failPhoto = false;
  await flush(() => byText("Убрать фото").click());
  assert.equal(savedCalls.length, 2);
  assert.equal(savedCalls.at(-1).director_photo_url, null);
  assert.equal(document.querySelector("img"), null);
  assert.equal(byText("Убрать фото"), undefined);
  assert.match(
    document.querySelector('[role="status"]').textContent,
    /Фотография убрана/,
  );
  await select(new File(["jpeg"], "director.jpeg", { type: "image/jpeg" }));
  const lastPreview = document.querySelector("img").getAttribute("src");
  await flush(() => root.unmount());
  root = null;
  assert.equal(revoked.includes(lastPreview), true);
  console.log(
    "PASS: QForce team loading/order/names/photos/project links, image fallback, branding+storage refresh, safe photo URLs, empty/error/schema/retry; DirectorPhotoUpload native input, validation, PUT FormData, busy state, API error/retry, DELETE, onSaved and preview cleanup.",
  );
})().catch(async (cause) => {
  console.error(cause);
  if (root) await flush(() => root.unmount());
  process.exitCode = 1;
});
