/**
 * React DOM regression tests for independent QForce branding and QControl uploads.
 * No real accounts or backend are used. API/auth/Next image/navigation/QTests
 * context are mocked; actual ecosystem/project providers, logos, admin controls,
 * PNG input, React state/effects, FormData and DOM events are exercised.
 * This is not browser visual testing.
 *
 * Run from the repository root with an isolated DOM test dependency:
 * npm install --prefix .local/qtests-ui-qa --no-save --package-lock=false --ignore-scripts jsdom@26.1.0
 * node scripts/tests/qforce_branding_dom.mjs --run --jsdom .local/qtests-ui-qa/node_modules/jsdom
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
global.localStorage = dom.window.localStorage;
// jsdom's File/Blob implement FileReader; provide the browser arrayBuffer API
// used by the real PNG-signature validator without bypassing that validator.
dom.window.Blob.prototype.arrayBuffer = function () {
  return new Promise((resolve, reject) => {
    const reader = new dom.window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(this);
  });
};
const asset = (key, character) =>
  `/api/branding/assets/${key}/${character.repeat(64)}.png`;
const defaultForce = "/brand/qforce_logo_main.png";
const initialIdentity = asset("qid", "1");
const initialControl = asset("qcontrol", "2");
const studyLogo = asset("project", "3");
let branding = {
  force_logo_url: defaultForce,
  force_logo_custom: false,
  identity_logo_url: initialIdentity,
  identity_logo_custom: true,
  control_logo_url: initialControl,
  control_logo_custom: true,
};
let apiCalls = [];
let role = "admin";
let pathname = "/";
let failForce = false;
let failEcosystem = false;
let ecosystemHold = null;
let mutationHold = null;
const api = async (url, options = {}) => {
  apiCalls.push({ url, options });
  if (url === "/branding")
    return { project_logo_url: studyLogo, project_logo_custom: true };
  if (url === "/branding/ecosystem") {
    const result = { ...branding };
    if (ecosystemHold) await ecosystemHold;
    if (failEcosystem) throw new Error("Логотипы временно недоступны.");
    return result;
  }
  assert.equal(
    url,
    "/branding/force-logo",
    "only the independent QForce endpoint may mutate in this fixture",
  );
  if (mutationHold) await mutationHold;
  if (failForce)
    throw new Error("Не удалось сохранить логотип QForce. Повторите попытку.");
  assert.ok(["PUT", "DELETE"].includes(options.method));
  branding = {
    ...branding,
    force_logo_url:
      options.method === "PUT" ? asset("qforce", "a") : defaultForce,
    force_logo_custom: options.method === "PUT",
  };
  return { ...branding };
};
global.fetch = async (url) => {
  assert.equal(url, "/api/developers");
  return { ok: true, json: async () => ({ departments: [] }) };
};
let objectUrlIndex = 0;
const revoked = [];
URL.createObjectURL = () => `blob:qforce-logo-test-${++objectUrlIndex}`;
URL.revokeObjectURL = (value) => revoked.push(value);
const modules = new Map();
const ImageMock = ({ fill, unoptimized, priority, ...props }) =>
  React.createElement("img", props);
function load(relative) {
  const filename = path.join(project, "frontend", relative);
  if (modules.has(filename)) return modules.get(filename).exports;
  const target = new Module(filename);
  modules.set(filename, target);
  target.filename = filename;
  target.paths = Module._nodeModulePaths(path.dirname(filename));
  target.require = (request) => {
    if (request === "@/lib/api") return { api };
    if (request === "@/lib/auth")
      return { useAuth: () => ({ user: { role } }) };
    if (request === "next/navigation") return { usePathname: () => pathname };
    if (request === "next/image")
      return { __esModule: true, default: ImageMock };
    if (request === "next/link")
      return {
        __esModule: true,
        default: ({ children, ...props }) =>
          React.createElement("a", props, children),
      };
    if (request === "@/components/qtests-brand")
      return {
        useQTestsBranding: () => ({
          branding: { logo_url: "/brand/qtests-prototype.svg" },
        }),
        QTestsLogo: (props) =>
          React.createElement(ImageMock, {
            ...props,
            src: "/brand/qtests-prototype.svg",
          }),
      };
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
const ecosystem = load("components/ecosystem-branding.tsx");
const { BrandingProvider } = load("components/branding-provider.tsx");
const { ProjectLogo } = load("components/project-logo.tsx");
const Admin = load("components/control/ecosystem-branding-admin.tsx").default;
const Home = load("components/qforce/home.tsx").default;
function Harness({ showHome = false }) {
  return React.createElement(
    BrandingProvider,
    null,
    React.createElement(
      "div",
      { id: "independent-logos" },
      React.createElement(ecosystem.EcosystemLogo, {
        kind: "force",
        alt: "Live QForce",
        width: 40,
        height: 40,
        "data-test-logo": "force",
      }),
      React.createElement(ecosystem.EcosystemLogo, {
        kind: "identity",
        alt: "Live Q-ID",
        width: 40,
        height: 40,
        "data-test-logo": "identity",
      }),
      React.createElement(ecosystem.EcosystemLogo, {
        kind: "control",
        alt: "Live QControl",
        width: 40,
        height: 40,
        "data-test-logo": "control",
      }),
      React.createElement(ProjectLogo, {
        alt: "Live QStudy",
        width: 40,
        height: 40,
        "data-test-logo": "study",
      }),
    ),
    showHome ? React.createElement(Home) : React.createElement(Admin),
  );
}
let root;
async function flush(action = () => {}) {
  await act(async () => {
    await action();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
async function mount(props = {}) {
  if (root) await flush(() => root.unmount());
  document.getElementById("root").innerHTML = "";
  root = createRoot(document.getElementById("root"));
  await flush(() => root.render(React.createElement(Harness, props)));
}
const logo = (name) =>
  document.querySelector(`[data-test-logo="${name}"]`).getAttribute("src");
const forceForm = () =>
  document.querySelector('form[aria-label="Логотип QForce"]');
const controlForms = () =>
  Array.from(document.querySelectorAll("form[aria-label]")).map((form) =>
    form.getAttribute("aria-label"),
  );
function assertUnrelated() {
  assert.equal(logo("identity"), initialIdentity);
  assert.equal(logo("control"), initialControl);
  assert.equal(logo("study"), studyLogo);
}
const setForce = (character) => {
  branding = {
    ...branding,
    force_logo_url: asset("qforce", character),
    force_logo_custom: true,
  };
};
const refreshEvent = () =>
  window.dispatchEvent(new Event("qstudy:ecosystem-branding-updated"));
async function choose(file) {
  await flush(() => {
    const input = forceForm().querySelector('input[type="file"]');
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function submit() {
  await flush(() =>
    forceForm().dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
}
const png = () =>
  new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])],
    "qforce.png",
    { type: "image/png" },
  );
(async () => {
  await mount();
  assert.deepEqual(controlForms(), [
    "Логотип QForce",
    "Логотип Q-ID",
    "Логотип QControl",
  ]);
  assert.equal(logo("force"), defaultForce);
  assertUnrelated();
  setForce("b");
  await flush(() => ecosystem.notifyEcosystemBrandingChanged(branding));
  assert.equal(logo("force"), asset("qforce", "b"));
  assert.equal(
    document.head.querySelector('link[rel="icon"]').getAttribute("href"),
    asset("qforce", "b"),
  );
  assertUnrelated();
  setForce("c");
  await flush(refreshEvent);
  assert.equal(logo("force"), asset("qforce", "c"));
  setForce("d");
  const readsBefore = apiCalls.filter(
    (call) => call.url === "/branding/ecosystem",
  ).length;
  await flush(() =>
    window.dispatchEvent(
      new dom.window.StorageEvent("storage", {
        key: "qstudy:ecosystem-branding-updated",
        newValue: "updated",
      }),
    ),
  );
  assert.equal(
    apiCalls.filter((call) => call.url === "/branding/ecosystem").length,
    readsBefore + 1,
  );
  assert.equal(logo("force"), asset("qforce", "d"));
  assertUnrelated();
  setForce("e");
  await flush(() => window.dispatchEvent(new Event("focus")));
  assert.equal(logo("force"), asset("qforce", "e"));
  let release;
  ecosystemHold = new Promise((resolve) => (release = resolve));
  setForce("f");
  await flush(refreshEvent);
  setForce("9");
  await flush(() => ecosystem.notifyEcosystemBrandingChanged(branding));
  await flush(() => release());
  ecosystemHold = null;
  assert.equal(
    logo("force"),
    asset("qforce", "9"),
    "a stale request must not overwrite a newer branding event",
  );
  assertUnrelated();
  await flush(() =>
    document
      .querySelector('[data-test-logo="force"]')
      .dispatchEvent(new Event("error")),
  );
  assert.equal(logo("force"), defaultForce);
  setForce("8");
  await flush(() => ecosystem.notifyEcosystemBrandingChanged(branding));
  assert.equal(logo("force"), asset("qforce", "8"));

  await choose(new File(["not PNG"], "not-png.png", { type: "image/png" }));
  assert.match(forceForm().textContent, /Файл не является PNG/);
  assert.equal(
    apiCalls.some((call) => call.options.method),
    false,
  );
  const file = png();
  await choose(file);
  assert.match(
    forceForm().querySelector("img").getAttribute("src"),
    /^blob:qforce-logo-test-/,
  );
  failForce = true;
  await submit();
  assert.match(forceForm().textContent, /Не удалось сохранить логотип QForce/);
  assert.equal(logo("force"), asset("qforce", "8"));
  assertUnrelated();
  failForce = false;
  let releaseMutation;
  mutationHold = new Promise((resolve) => (releaseMutation = resolve));
  await submit();
  assert.equal(forceForm().querySelector('input[type="file"]').disabled, true);
  assert.match(forceForm().textContent, /Сохраняем/);
  await flush(() => releaseMutation());
  mutationHold = null;
  const put = apiCalls.filter((call) => call.options.method === "PUT").at(-1);
  assert.equal(put.url, "/branding/force-logo");
  assert.equal(put.options.body.get("file").name, file.name);
  assert.equal(put.options.body.get("file").size, file.size);
  assert.equal(logo("force"), asset("qforce", "a"));
  assert.match(forceForm().textContent, /Логотип обновлён/);
  assertUnrelated();
  failForce = true;
  const reset = () =>
    Array.from(forceForm().querySelectorAll("button")).find((button) =>
      button.textContent.includes("Стандартный логотип"),
    );
  await flush(() => reset().click());
  assert.match(forceForm().textContent, /Не удалось сохранить логотип QForce/);
  assert.equal(logo("force"), asset("qforce", "a"));
  failForce = false;
  await flush(() => reset().click());
  assert.equal(
    apiCalls.filter((call) => call.options.method === "DELETE").at(-1).url,
    "/branding/force-logo",
  );
  assert.equal(logo("force"), defaultForce);
  assert.match(forceForm().textContent, /Восстановлен стандартный логотип/);
  assertUnrelated();
  assert.equal(
    apiCalls.filter(
      (call) => call.options.method && call.url !== "/branding/force-logo",
    ).length,
    0,
  );

  failEcosystem = true;
  await flush(refreshEvent);
  assert.match(document.body.textContent, /Логотипы временно недоступны/);
  failEcosystem = false;
  setForce("7");
  await flush(() =>
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent.includes("Повторить загрузку"))
      .click(),
  );
  assert.equal(logo("force"), asset("qforce", "7"));
  assertUnrelated();
  await mount({ showHome: true });
  assert.equal(
    document.querySelectorAll(`img[src="${asset("qforce", "7")}"]`).length,
    4,
    "standalone live logo plus QForce header, hero and footer use force branding",
  );
  assert.equal(
    document.querySelector('a[aria-label^="QStudy —"] img').getAttribute("src"),
    studyLogo,
  );
  setForce("6");
  await flush(() => ecosystem.notifyEcosystemBrandingChanged(branding));
  assert.equal(
    document.querySelectorAll(`img[src="${asset("qforce", "6")}"]`).length,
    4,
  );
  assertUnrelated();
  pathname = "/qstudy";
  await flush(() =>
    root.render(React.createElement(Harness, { showHome: true })),
  );
  assert.equal(
    document.head.querySelector('link[rel="icon"]').getAttribute("href"),
    studyLogo,
  );
  assert.equal(logo("force"), asset("qforce", "6"));
  role = "student";
  await mount();
  assert.equal(
    forceForm(),
    null,
    "students cannot see the admin branding controls",
  );
  assert.equal(controlForms().length, 0);
  await flush(() => root.unmount());
  root = null;
  assert.ok(revoked.length > 0);
  console.log(
    "PASS: real QControl QForce PNG control/PUT/DELETE/error+retry, independent force/Q-ID/QControl/QStudy logos, live event/refresh/storage/focus, stale-response guard, fallback/recovery, home header+hero+footer/favicon, QStudy favicon independence, provider error/retry and hidden student controls.",
  );
})().catch(async (cause) => {
  console.error(cause);
  if (root) await flush(() => root.unmount());
  process.exitCode = 1;
});
