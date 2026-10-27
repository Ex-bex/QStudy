/**
 * Actual React DOM regression tests for AppInstallProvider/AppInstallButton.
 * Real app catalog and route selection; Next navigation and browser install/SW
 * boundaries are fixtures. No real browser installation, live account or server
 * is modified. This is not visual/browser acceptance testing.
 *
 * node scripts/tests/pwa_install_dom.mjs --run --jsdom .local/qtests-ui-qa/node_modules/jsdom
 */
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--run")) {
  console.log(
    "SKIP: opt in with --run; optionally --jsdom <installed package path>.",
  );
  process.exit(0);
}
const project = fileURLToPath(new URL("../..", import.meta.url));
const appRequire = Module.createRequire(
  path.join(project, "frontend/package.json"),
);
const scriptRequire = Module.createRequire(import.meta.url);
const dependencyArgument = process.argv.indexOf("--jsdom");
if (dependencyArgument !== -1 && !process.argv[dependencyArgument + 1])
  throw new Error("--jsdom requires the path to an installed jsdom package.");
const { JSDOM } =
  dependencyArgument === -1
    ? appRequire("jsdom")
    : scriptRequire(path.resolve(process.argv[dependencyArgument + 1]));
let dom;
function exposeDOM(nextDOM) {
  dom = nextDOM;
  for (const name of [
    "window",
    "document",
    "HTMLElement",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "Node",
  ])
    global[name] = dom.window[name];
  Object.defineProperty(global, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
}
exposeDOM(
  new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://fixture.test/",
  }),
);
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = appRequire("react");
const { act } = React;
const { createRoot } = appRequire("react-dom/client");
const ts = appRequire("typescript");
let pathname = "/";
let search = "";
const navigationListeners = new Set();
const subscribe = (notify) => {
  navigationListeners.add(notify);
  return () => navigationListeners.delete(notify);
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
    if (request === "next/navigation")
      return {
        usePathname: () =>
          React.useSyncExternalStore(
            subscribe,
            () => pathname,
            () => pathname,
          ),
        useSearchParams: () =>
          new URLSearchParams(
            React.useSyncExternalStore(
              subscribe,
              () => search,
              () => search,
            ),
          ),
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
const { AppInstallProvider, AppInstallButton } = load(
  "components/app-install.tsx",
);
const { PWA_APPS, pwaAppForPath, pwaIconUrl, pwaManifestUrl } =
  load("lib/pwa.ts");
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush(action = () => {}) {
  await act(async () => {
    await action();
    await new Promise((done) => setTimeout(done, 5));
  });
}
const dialog = () => document.querySelector('[role="dialog"]');
const button = () =>
  document.querySelector('button[aria-label^="Установить "]');
const closeButton = () =>
  document.querySelector('button[aria-label="Закрыть установку"]');
const text = () => document.body.textContent;
let root = null;
let registered = [];
let updates = 0;
let media;
let report = { metadata_routes: 0, scenarios: 0 };

async function mount({
  route = "/qmessage/chats",
  secure = true,
  ios = false,
  standalone = false,
  serviceWorker = true,
  duplicates = false,
  workerFails = false,
} = {}) {
  if (root) await unmount();
  dom.window.close();
  exposeDOM(
    new JSDOM(
      '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
      {
        url: `${secure ? "https://fixture.test" : "http://94.125.99.135:8080"}${route}`,
      },
    ),
  );
  const url = new URL(route, "https://fixture.test");
  pathname = url.pathname;
  search = url.search;
  registered = [];
  updates = 0;
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: secure,
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: ios
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1"
      : "Mozilla/5.0 Android Chrome/130.0",
  });
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: ios ? "iPhone" : "Linux armv8l",
  });
  Object.defineProperty(navigator, "standalone", {
    configurable: true,
    value: false,
  });
  const mediaListeners = new Set();
  media = {
    matches: standalone,
    media: "(display-mode: standalone)",
    addEventListener: (name, listener) => {
      assert.equal(name, "change");
      mediaListeners.add(listener);
    },
    removeEventListener: (name, listener) => {
      assert.equal(name, "change");
      mediaListeners.delete(listener);
    },
    emit: (matches) => {
      media.matches = matches;
      for (const listener of mediaListeners) listener();
    },
    listeners: mediaListeners,
  };
  window.matchMedia = (query) => {
    assert.equal(query, "(display-mode: standalone)");
    return media;
  };
  if (serviceWorker)
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async (url, options) => {
          registered.push({ url, options });
          if (workerFails) throw new Error("Offline registration fixture");
          return {
            update: async () => {
              updates++;
            },
          };
        },
      },
    });
  if (duplicates)
    for (let index = 0; index < 2; index++)
      for (const rel of ["manifest", "apple-touch-icon"]) {
        const link = document.createElement("link");
        link.rel = rel;
        link.href = "/old-fixture";
        document.head.appendChild(link);
      }
  root = createRoot(document.getElementById("root"));
  await flush(() =>
    root.render(
      React.createElement(
        AppInstallProvider,
        null,
        React.createElement(AppInstallButton),
      ),
    ),
  );
}
async function unmount() {
  await flush(() => root.unmount());
  assert.equal(
    navigationListeners.size,
    0,
    "Next fixture subscriptions cleaned up",
  );
  assert.equal(media.listeners.size, 0, "display-mode listener cleaned up");
  root = null;
}
async function navigate(route) {
  const url = new URL(route, "https://fixture.test");
  await flush(() => {
    pathname = url.pathname;
    search = url.search;
    for (const notify of navigationListeners) notify();
  });
}
function nativePrompt({ outcome, fails = false } = {}) {
  const choice = deferred();
  const event = new Event("beforeinstallprompt", { cancelable: true });
  let calls = 0;
  Object.assign(event, {
    prompt: async () => {
      calls++;
      if (fails) throw new Error("Install blocked fixture");
    },
    userChoice: choice.promise,
  });
  if (outcome) choice.resolve({ outcome });
  return { event, choice, calls: () => calls };
}
async function dispatchPrompt(prompt) {
  await flush(() => window.dispatchEvent(prompt.event));
}
function verifyHead(route) {
  const url = new URL(route, "https://fixture.test");
  const app = pwaAppForPath(url.pathname, url.searchParams.get("next"));
  const manifests = document.head.querySelectorAll('link[rel="manifest"]');
  const apples = document.head.querySelectorAll('link[rel="apple-touch-icon"]');
  assert.equal(manifests.length, 1);
  assert.equal(apples.length, 1);
  assert.equal(manifests[0].getAttribute("href"), pwaManifestUrl(app.id));
  assert.equal(manifests[0].crossOrigin, "anonymous");
  assert.equal(apples[0].getAttribute("href"), pwaIconUrl(app.id, 180));
  assert.equal(apples[0].type, "image/png");
  assert.equal(apples[0].sizes, "180x180");
  assert.equal(
    document.head.querySelector('meta[name="apple-mobile-web-app-title"]')
      .content,
    app.shortName,
  );
  assert.equal(
    document.head.querySelector('meta[name="theme-color"]').content,
    app.color,
  );
  assert.equal(
    document.head.querySelector('meta[name="mobile-web-app-capable"]').content,
    "yes",
  );
  assert.equal(button().getAttribute("aria-label"), `Установить ${app.name}`);
  report.metadata_routes++;
}

try {
  await mount({ route: "/qtests/library", secure: false });
  verifyHead("/qtests/library");
  assert.equal(
    registered.length,
    0,
    "HTTP must not attempt service worker registration",
  );
  const insecure = nativePrompt();
  await dispatchPrompt(insecure);
  assert.equal(
    insecure.event.defaultPrevented,
    false,
    "HTTP cannot capture an install prompt",
  );
  await flush(() => {
    button().focus();
    button().click();
  });
  assert.ok(dialog());
  assert.ok(text().includes("HTTPS") && text().includes("обычному HTTP"));
  assert.equal(insecure.calls(), 0);
  assert.equal(document.body.style.overflow, "hidden");
  await flush(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(dialog(), null);
  assert.equal(document.body.style.overflow, "");
  assert.equal(
    document.activeElement,
    button(),
    "Escape restores opener focus",
  );
  report.scenarios++;

  for (const app of PWA_APPS) {
    await mount({ route: app.startUrl, duplicates: true });
    verifyHead(app.startUrl);
    assert.deepEqual(registered, [
      { url: "/sw.js", options: { scope: "/", updateViaCache: "none" } },
    ]);
    assert.equal(updates, 1);
  }
  for (const route of [
    "/qstudy",
    "/login?next=%2Fqcontrol",
    "/register?next=%2Fqmessage%2Fchats",
    "/forgot-password?next=%2Fqcareer%2Fworkspace",
    "/reset-password?next=https%3A%2F%2Fevil.test%2Fqcontrol",
  ]) {
    await mount({ route });
    verifyHead(route);
  }
  report.scenarios++;

  await mount({ route: "/qmessage/chats" });
  const accepted = nativePrompt();
  await dispatchPrompt(accepted);
  assert.equal(accepted.event.defaultPrevented, true);
  await flush(() => button().click());
  assert.equal(accepted.calls(), 1);
  assert.equal(
    button().disabled,
    true,
    "prevent double invocation while browser choice is pending",
  );
  await flush(() => button().click());
  assert.equal(accepted.calls(), 1);
  await flush(() => accepted.choice.resolve({ outcome: "accepted" }));
  assert.equal(button().disabled, false);
  assert.equal(dialog(), null);
  await flush(() => window.dispatchEvent(new Event("appinstalled")));
  assert.equal(button().textContent, "Приложение");
  await flush(() => button().click());
  assert.ok(text().includes("уже открыто в отдельном окне"));
  assert.equal(
    accepted.calls(),
    1,
    "appinstalled cannot reuse the consumed prompt",
  );
  report.scenarios++;

  await mount({ route: "/qball/play" });
  const dismissed = nativePrompt({ outcome: "dismissed" });
  await dispatchPrompt(dismissed);
  await flush(() => button().click());
  assert.equal(dismissed.calls(), 1);
  assert.equal(dialog(), null);
  await flush(() => button().click());
  assert.ok(text().includes("Откройте меню браузера"));
  assert.equal(dismissed.calls(), 1, "dismissed prompts are single use");
  const failed = nativePrompt({ fails: true });
  await dispatchPrompt(failed);
  const primary = [...dialog().querySelectorAll("button")].find((node) =>
    node.textContent.includes("Установить QBall"),
  );
  assert.ok(primary);
  await flush(() => primary.click());
  assert.ok(
    dialog()
      .querySelector('[role="alert"]')
      .textContent.includes("Браузер не завершил установку"),
  );
  assert.equal(failed.calls(), 1);
  assert.equal(button().disabled, false);
  assert.ok(
    text().includes("Откройте меню браузера"),
    "failed prompt clears and falls back to menu instructions",
  );
  const retry = nativePrompt({ outcome: "accepted" });
  await dispatchPrompt(retry);
  await flush(() =>
    [...dialog().querySelectorAll("button")]
      .find((node) => node.textContent.includes("Установить QBall"))
      .click(),
  );
  assert.equal(retry.calls(), 1);
  assert.equal(dialog(), null);
  report.scenarios++;

  await mount({ route: "/qmessage/chats" });
  const oldProduct = nativePrompt();
  await dispatchPrompt(oldProduct);
  await navigate("/qtests/library");
  verifyHead("/qtests/library");
  await flush(() => button().click());
  assert.equal(
    oldProduct.calls(),
    0,
    "cross-project soft navigation must not invoke old product's prompt",
  );
  assert.ok(text().includes("Подготовим отдельную установку QTests"));
  assert.ok(
    [...dialog().querySelectorAll("button")].some((node) =>
      node.textContent.includes("Подготовить установку"),
    ),
  );
  const wrongManifestEvent = nativePrompt();
  await dispatchPrompt(wrongManifestEvent);
  assert.equal(
    wrongManifestEvent.event.defaultPrevented,
    false,
    "cross-project browser events require a full page reload first",
  );
  await flush(() => closeButton().click());
  await flush(() => button().click());
  assert.equal(wrongManifestEvent.calls(), 0);
  assert.ok(text().includes("Подготовим отдельную установку QTests"));
  report.scenarios++;

  await mount({ route: "/login?next=%2Fqcontrol" });
  const sameProduct = nativePrompt({ outcome: "accepted" });
  await dispatchPrompt(sameProduct);
  await navigate("/qcontrol/accounts");
  verifyHead("/qcontrol/accounts");
  await flush(() => button().click());
  assert.equal(
    sameProduct.calls(),
    1,
    "login to the same product retains the matching prepared prompt",
  );
  assert.equal(dialog(), null);
  report.scenarios++;

  await mount({ route: "/dashboard", ios: true, serviceWorker: false });
  await flush(() => button().click());
  assert.ok(
    text().includes("Поделиться") &&
      text().includes("На экран „Домой“") &&
      text().includes("Открывать как веб-приложение"),
  );
  assert.equal(registered.length, 0);
  assert.ok(
    !dialog().querySelector(".primary"),
    "iOS instructions do not pretend the unsupported native prompt exists",
  );
  const focusable = [
    ...dialog().querySelectorAll("a[href],button:not([disabled])"),
  ];
  await flush(() => {
    focusable.at(-1).focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.equal(document.activeElement, focusable[0]);
  await flush(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(document.activeElement, focusable.at(-1));
  report.scenarios++;

  await mount({ route: "/qcareer/workspace", standalone: true });
  assert.equal(button().textContent, "Приложение");
  await flush(() => button().click());
  assert.ok(text().includes("уже открыто в отдельном окне"));
  await flush(() => closeButton().click());
  await flush(() => media.emit(false));
  assert.equal(button().textContent, "Установить");
  await flush(() => media.emit(true));
  assert.equal(button().textContent, "Приложение");
  report.scenarios++;

  await mount({ route: "/qball/play", workerFails: true });
  assert.equal(registered.length, 1);
  assert.equal(updates, 0);
  const offlineWorker = nativePrompt({ outcome: "accepted" });
  await dispatchPrompt(offlineWorker);
  await flush(() => button().click());
  assert.equal(
    offlineWorker.calls(),
    1,
    "SW registration failure does not break browser installation UI",
  );
  report.scenarios++;

  console.log(
    `PWA installation DOM PASS: ${report.scenarios} scenarios, ${report.metadata_routes} route metadata checks; HTTP gate, SW registration, install choices/errors/retry, same/cross app navigation, iOS, focus and standalone.`,
  );
} finally {
  if (root) await unmount();
  dom.window.close();
}
