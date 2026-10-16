import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import ts from "typescript";
import { Vec2 } from "planck";
import { FIELD, FootballEngine, getField } from "./lumaball/engine.ts";

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
const frame = (map) => {
  const result = new FootballEngine(
    [
      { id: "red", name: "Host", team: "red", connected: true },
      { id: "blue", name: "Friend", team: "blue", connected: true },
    ],
    0,
    0,
    map,
  ).frame();
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
        if (name === "createLinearGradient")
          return () => ({ addColorStop() {} });
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

test("the static football pitch is cached and RAF draws never measure layout", () => {
  const f = fixture();
  const renderer = new FootballRenderer(f.canvas);
  try {
    const value = frame();
    renderer.draw(value, "red");
    const paintedCalls = f.offscreen[0].context.calls.length;
    for (let index = 1; index < 120; index++) renderer.draw(value, "red");
    assert.equal(f.canvas.measurements, 1);
    assert.equal(f.offscreen.length, 1);
    assert.equal(
      f.canvas.context.calls.filter((call) => call.name === "drawImage").length,
      120,
    );
    assert.equal(
      f.offscreen[0].context.calls.length,
      paintedCalls,
      "the complete static scene is built once across 120 animation frames",
    );
    assert.ok(
      f.offscreen[0].context.calls.some(
        (call) =>
          call.name === "fillRect" && call.fill === FOOTBALL_PALETTE.background,
      ),
    );
    assert.ok(
      f.offscreen[0].context.calls.some(
        (call) =>
          call.name === "stroke" && call.stroke === FOOTBALL_PALETTE.line,
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
      f.offscreen[0].context.calls.filter(
        (call) =>
          call.name === "fillRect" &&
          call.fill === FOOTBALL_PALETTE.background &&
          call.args.join() === [0, 0, FIELD.width, FIELD.height].join(),
      ).length,
      3,
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

test("the ball stays white; the neutral own-player ring is yellow only until a kick is consumed or released", () => {
  const f = fixture();
  const renderer = new FootballRenderer(f.canvas);
  const engine = new FootballEngine([
    { id: "red", name: "Host", team: "red", connected: true },
    { id: "blue", name: "Friend", team: "blue", connected: true },
  ]);
  engine.kickoff = 0;
  const player = engine.players.find((item) => item.id === "red");
  const position = player.body.getPosition();
  engine.ball.setPosition(Vec2(position.x + 26 / 80, position.y));
  function drawAndInspect(expectedArmed) {
    const start = f.canvas.context.calls.length;
    const value = engine.frame();
    renderer.draw(value, "red");
    const calls = f.canvas.context.calls.slice(start);
    const yellowStrokes = calls.filter(
      (call) => call.name === "stroke" && call.stroke === "#f8d775",
    );
    assert.equal(yellowStrokes.length, expectedArmed ? 1 : 0);
    assert.ok(
      calls.some(
        (call) =>
          call.name === "stroke" &&
          call.stroke === (expectedArmed ? "#f8d775" : "rgba(245,247,255,.65)"),
      ),
    );
    const ballArc = calls.findIndex(
      (call) =>
        call.name === "arc" &&
        call.args[0] === value.ball.x &&
        call.args[1] === value.ball.y &&
        call.args[2] === FIELD.ballRadius,
    );
    assert.ok(ballArc >= 0);
    assert.equal(
      calls.slice(ballArc + 1).find((call) => call.name === "fill").fill,
      FOOTBALL_PALETTE.ball,
    );
    assert.ok(
      !calls.some((call) => call.name === "fill" && call.fill === "#f8d775"),
      "arming a kick never changes the ball's fill",
    );
  }
  try {
    drawAndInspect(false);
    engine.input("red", { x: 0, y: 0, kick: true, kick_seq: 1 });
    drawAndInspect(true);
    const statics = f.offscreen[0].context.calls.length;
    engine.advance(1 / 60);
    assert.equal(
      engine.frame().players[0].kicking,
      false,
      "a successful original kick consumes its armed state even while the key is held",
    );
    drawAndInspect(false);
    engine.input("red", { x: 0, y: 0, kick: true, kick_seq: 1 });
    drawAndInspect(false);
    engine.input("red", { x: 0, y: 0, kick: true, kick_seq: 2 });
    drawAndInspect(true);
    engine.input("red", { x: 0, y: 0, kick: false, kick_seq: 2 });
    drawAndInspect(false);
    assert.equal(
      f.offscreen[0].context.calls.length,
      statics,
      "kick highlighting and ball movement reuse the cached field",
    );
  } finally {
    renderer.destroy();
    f.restore();
  }
});

test("changing kick flags and impact velocities across 180 frames never rebuilds the static scene", () => {
  const f = fixture();
  const renderer = new FootballRenderer(f.canvas);
  try {
    const value = frame();
    renderer.draw(value, "red");
    const painted = f.offscreen[0].context.calls.length;
    for (let tick = 0; tick < 180; tick++) {
      value.seq++;
      value.ball.x = 300 + (tick % 80);
      value.ball.vx = tick % 3 === 0 ? -600 : 600;
      value.players[0].kicking = tick % 2 === 0;
      renderer.draw(value, "red");
    }
    assert.equal(f.offscreen[0].context.calls.length, painted);
    assert.equal(f.canvas.measurements, 1);
    assert.equal(f.offscreen.length, 1);
    assert.equal(
      f.canvas.context.calls.filter((call) => call.name === "drawImage").length,
      181,
    );
  } finally {
    renderer.destroy();
    f.restore();
  }
});

test("a map resize or preset change invalidates exactly one static scene and updates its aspect ratio", () => {
  const f = fixture();
  const renderer = new FootballRenderer(f.canvas);
  const paints = () =>
    f.offscreen[0].context.calls.filter(
      (call) =>
        call.name === "fillRect" && call.fill === FOOTBALL_PALETTE.background,
    ).length;
  try {
    let expected = 0;
    for (const map of [
      { map_id: "classic", map_width: 10, map_height: 5 },
      { map_id: "classic", map_width: 20, map_height: 8 },
      { map_id: "hockey", map_width: 20, map_height: 8 },
      { map_id: "arena", map_width: 14, map_height: 8 },
    ]) {
      const value = frame(map);
      renderer.draw(value, "red");
      expected++;
      assert.equal(paints(), expected);
      assert.equal(
        f.canvas.height,
        Math.round((f.canvas.width * value.height) / value.width),
      );
      for (let index = 0; index < 12; index++) renderer.draw(value, "red");
      assert.equal(paints(), expected);
    }
    assert.equal(f.offscreen.length, 1);
    assert.equal(f.canvas.measurements, 1);
  } finally {
    renderer.destroy();
    f.restore();
  }
});

test("hockey draws an ice surface and dark puck while the arena paints its actual collision bumpers", () => {
  for (const map of [
    { map_id: "hockey", map_width: 12, map_height: 6 },
    { map_id: "arena", map_width: 18, map_height: 9 },
  ]) {
    const f = fixture();
    const renderer = new FootballRenderer(f.canvas);
    try {
      const value = frame(map),
        field = getField(value);
      renderer.draw(value, "red");
      const statics = f.offscreen[0].context.calls;
      if (map.map_id === "hockey") {
        assert.ok(
          statics.some(
            (call) => call.name === "fillRect" && call.fill === "#dcebf3",
          ),
        );
        const arc = f.canvas.context.calls.findIndex(
          (call) =>
            call.name === "arc" &&
            call.args[0] === value.ball.x &&
            call.args[1] === value.ball.y &&
            call.args[2] === field.ballRadius,
        );
        assert.ok(arc >= 0);
        assert.equal(
          f.canvas.context.calls
            .slice(arc + 1)
            .find((call) => call.name === "fill").fill,
          "#17242f",
        );
        assert.ok(
          statics.some(
            (call) =>
              call.name === "arc" && call.stroke === "rgba(166,70,94,.65)",
          ),
          "ice faceoff circles are visible",
        );
      } else {
        assert.equal(field.obstacles.length, 4);
        for (const obstacle of field.obstacles)
          assert.ok(
            statics.some(
              (call) =>
                call.name === "arc" &&
                call.args[0] === obstacle.x &&
                call.args[1] === obstacle.y &&
                call.args[2] === obstacle.radius,
            ),
            "arena bumper is painted at its physical position and radius",
          );
        assert.ok(
          !statics.some(
            (call) =>
              call.name === "stroke" &&
              ["#bf7180", "#83a9c2"].includes(call.stroke),
          ),
          "closed arena has no decorative goal openings",
        );
      }
    } finally {
      renderer.destroy();
      f.restore();
    }
  }
});
