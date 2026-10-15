import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import ts from "typescript";
import { FootballEngine } from "./lumaball/engine.ts";

const source = readFileSync(
  new URL("./lumaball/render.ts", import.meta.url),
  "utf8",
);
const compiled = ts
  .transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  })
  .outputText.replace(
    'from "./engine"',
    `from "${new URL("./lumaball/engine.ts", import.meta.url).href}"`,
  );
const { FootballRenderer, FOOTBALL_PALETTE } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);
const frame = () => {
  const result = new FootballEngine([
    { id: "red", name: "Host", team: "red", connected: true },
    { id: "blue", name: "Friend", team: "blue", connected: true },
  ]).frame();
  result.kickoff = 0;
  return result;
};

function fixture() {
  const previousWindow = globalThis.window;
  const previousObserver = globalThis.ResizeObserver;
  const listeners = new Map();
  const observers = [];
  const offscreen = [];
  const createCanvas = (cssWidth = 600) => {
    const state = { calls: [], shadowValues: [] };
    const context = new Proxy(state, {
      get(target, name) {
        if (name in target) return target[name];
        return (...args) =>
          target.calls.push({
            name,
            args,
            fill: target.fillStyle,
            stroke: target.strokeStyle,
          });
      },
      set(target, name, value) {
        target[name] = value;
        if (name === "shadowBlur") target.shadowValues.push(value);
        return true;
      },
    });
    return {
      cssWidth,
      measurements: 0,
      width: 0,
      height: 0,
      context,
      ownerDocument: {
        createElement() {
          const canvas = createCanvas();
          offscreen.push(canvas);
          return canvas;
        },
      },
      get clientWidth() {
        this.measurements++;
        return this.cssWidth;
      },
      getContext() {
        return context;
      },
    };
  };
  globalThis.window = {
    devicePixelRatio: 1,
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
  };
  globalThis.ResizeObserver = class {
    disconnected = 0;
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(canvas) {
      this.canvas = canvas;
    }
    disconnect() {
      this.disconnected++;
    }
    emit(width) {
      this.callback([{ target: this.canvas, contentRect: { width } }]);
    }
  };
  return {
    canvas: createCanvas(),
    offscreen,
    observers,
    listeners,
    restore() {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousObserver === undefined) delete globalThis.ResizeObserver;
      else globalThis.ResizeObserver = previousObserver;
    },
  };
}

test("the static original-color pitch is cached and RAF draws never measure layout", () => {
  const f = fixture();
  const renderer = new FootballRenderer(f.canvas);
  try {
    const value = frame();
    for (let index = 0; index < 120; index++) renderer.draw(value, "red");
    assert.equal(f.canvas.measurements, 1);
    assert.equal(f.offscreen.length, 1);
    assert.equal(
      f.canvas.context.calls.filter((call) => call.name === "drawImage").length,
      120,
    );
    assert.equal(
      f.offscreen[0].context.calls.filter((call) => call.name === "fillRect")
        .length,
      3,
      "background and two goals are built once",
    );
    assert.ok(
      f.offscreen[0].context.calls.some(
        (call) => call.name === "fillRect" && call.fill === "#2d1a66",
      ),
    );
    assert.ok(
      f.offscreen[0].context.calls.some(
        (call) => call.name === "stroke" && call.stroke === "#4a2fb3",
      ),
    );
    for (const color of [
      FOOTBALL_PALETTE.red,
      FOOTBALL_PALETTE.blue,
      FOOTBALL_PALETTE.ball,
    ])
      assert.ok(
        f.canvas.context.calls.some(
          (call) => call.name === "fill" && call.fill === color,
        ),
      );
    assert.ok(
      f.canvas.context.shadowValues.every((value) => value === 0),
      "per-disc blur passes are absent",
    );
  } finally {
    renderer.destroy();
    f.restore();
  }
});

test("observer changes and DPR changes rebuild one cached pitch, then dispose completely", () => {
  const f = fixture();
  const renderer = new FootballRenderer(f.canvas);
  try {
    const value = frame();
    renderer.draw(value, "red");
    f.observers[0].emit(800);
    renderer.draw(value, "red");
    assert.equal(f.canvas.width, 800);
    assert.equal(
      f.canvas.measurements,
      1,
      "ResizeObserver width avoids a forced layout read",
    );
    globalThis.window.devicePixelRatio = 2;
    renderer.draw(value, "red");
    assert.equal(f.canvas.width, 1600);
    assert.equal(f.offscreen.length, 1, "resize reuses its offscreen canvas");
    assert.equal(
      f.offscreen[0].context.calls.filter((call) => call.name === "fillRect")
        .length,
      9,
    );
    renderer.draw(value, "red");
    const count = f.canvas.context.calls.length;
    renderer.destroy();
    renderer.destroy();
    renderer.draw(value, "red");
    assert.equal(f.canvas.context.calls.length, count);
    assert.equal(f.observers[0].disconnected, 1);
    assert.equal(f.offscreen[0].width, 0);
  } finally {
    renderer.destroy();
    f.restore();
  }
});

test("browsers without ResizeObserver measure only initial layout and window resize", () => {
  const f = fixture();
  delete globalThis.ResizeObserver;
  const renderer = new FootballRenderer(f.canvas);
  try {
    const value = frame();
    for (let index = 0; index < 60; index++) renderer.draw(value, "red");
    assert.equal(f.canvas.measurements, 1);
    f.canvas.cssWidth = 720;
    f.listeners.get("resize")();
    renderer.draw(value, "red");
    assert.equal(f.canvas.width, 720);
    assert.equal(f.canvas.measurements, 2);
    renderer.destroy();
    assert.equal(f.listeners.size, 0);
  } finally {
    renderer.destroy();
    f.restore();
  }
});
