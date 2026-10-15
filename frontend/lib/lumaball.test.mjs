import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FootballEngine,
  FIELD,
  normalizeInput,
  validFrame,
} from "./lumaball/engine.ts";

const members = [
  { id: "red", name: "Alice", team: "red", connected: true },
  { id: "blue", name: "Bob", team: "blue", connected: true },
  { id: "watch", name: "Observer", team: "spectator", connected: true },
];
const advance = (engine, seconds, input = null) => {
  for (let i = 0; i < Math.ceil(seconds * 60); i++) {
    if (input) engine.input("red", input);
    engine.advance(1 / 60);
  }
};

test("diagonal input has no speed advantage and hostile input cannot enter physics", () => {
  const diagonal = normalizeInput({ x: 1000, y: 1000, kick: true });
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 1) < 1e-10);
  assert.deepEqual(normalizeInput({ x: NaN, y: Infinity, kick: "true" }), {
    x: 0,
    y: 0,
    kick: false,
  });
  assert.deepEqual(normalizeInput(null), { x: 0, y: 0, kick: false });
});

test("spectators never get a body, movement stays inside pitch and stale input releases", () => {
  const engine = new FootballEngine(members);
  engine.input("watch", { x: 1, y: 1, kick: true });
  advance(engine, 8, { x: 1, y: -1, kick: true });
  const frame = engine.frame();
  assert.equal(frame.players.length, 2);
  assert.ok(!frame.players.some((p) => p.id === "watch"));
  const player = frame.players.find((p) => p.id === "red");
  assert.ok(player.x <= FIELD.right - FIELD.playerRadius);
  assert.ok(player.y >= FIELD.top + FIELD.playerRadius);
  advance(engine, 3);
  assert.ok(
    Math.hypot(
      ...[engine.frame().players[0].vx, engine.frame().players[0].vy],
    ) < 0.1,
  );
  assert.ok(validFrame(engine.frame()));
});

test("pause and tab catch-up do not advance a match by arbitrary wall time", () => {
  const engine = new FootballEngine(members, 5, 1);
  advance(engine, 3);
  const before = engine.frame().elapsed;
  engine.advance(10000, false);
  assert.equal(engine.frame().elapsed, before);
  engine.advance(10000, true);
  assert.ok(engine.frame().elapsed - before < 0.21);
});

test("a ball crossing the goal mouth scores once and reaches the score limit", () => {
  const engine = new FootballEngine(members, 1, 5);
  advance(engine, 1.5);
  // Controlled collision setup: place a moving ball immediately before the line.
  engine.ball = { x: FIELD.right - 2, y: 350, vx: 600, vy: 0 };
  advance(engine, 0.15);
  const frame = engine.frame();
  assert.deepEqual(frame.score, { red: 1, blue: 0 });
  assert.equal(frame.finished, true);
  assert.equal(frame.winner, "red");
  advance(engine, 2);
  assert.deepEqual(engine.frame().score, frame.score);
});

test("side walls outside the mouth bounce the ball rather than award a goal", () => {
  const engine = new FootballEngine(members);
  advance(engine, 1.5);
  engine.ball = { x: FIELD.right - 12, y: 120, vx: 600, vy: 0 };
  advance(engine, 0.2);
  assert.deepEqual(engine.frame().score, { red: 0, blue: 0 });
  assert.ok(engine.frame().ball.vx < 0);
});

test("a timed match finishes as a draw and disconnected members leave the simulation", () => {
  const engine = new FootballEngine(members, 5, 1);
  advance(engine, 63);
  const frame = engine.frame();
  assert.equal(frame.finished, true);
  assert.equal(frame.winner, "draw");
  engine.syncMembers([{ ...members[0], connected: false }, members[1]]);
  assert.deepEqual(
    engine.frame().players.map((p) => p.id),
    ["blue"],
  );
});

test("network frames reject unbounded, malformed or non-finite game objects", () => {
  const frame = new FootballEngine(members).frame();
  assert.ok(validFrame(frame));
  assert.equal(
    validFrame({ ...frame, ball: { ...frame.ball, x: NaN } }),
    false,
  );
  assert.equal(validFrame({ ...frame, score: { red: 1e9, blue: 0 } }), false);
  assert.equal(
    validFrame({ ...frame, players: new Array(100).fill(frame.players[0]) }),
    false,
  );
  assert.equal(
    validFrame({
      ...frame,
      players: [{ ...frame.players[0], id: "a".repeat(1000) }],
    }),
    false,
  );
});

test("large uneven teams spawn on the pitch without overlapping, including after a goal", () => {
  const roster = Array.from({ length: 16 }, (_, index) => ({
    id: String(index),
    name: `Player ${index}`,
    connected: true,
    team: index === 15 ? "blue" : "red",
  }));
  const engine = new FootballEngine(roster);
  const check = (frame) => {
    assert.equal(frame.players.length, 16);
    for (const player of frame.players) {
      assert.ok(player.y >= FIELD.top + FIELD.playerRadius);
      assert.ok(player.y <= FIELD.bottom - FIELD.playerRadius);
      assert.ok(player.x >= FIELD.left + FIELD.playerRadius);
      assert.ok(player.x <= FIELD.right - FIELD.playerRadius);
      for (const other of frame.players)
        if (other.id !== player.id)
          assert.ok(Math.hypot(other.x - player.x, other.y - player.y) >= 40);
    }
  };
  check(engine.frame());
  advance(engine, 1.5);
  engine.ball = { x: FIELD.right - 2, y: 350, vx: 600, vy: 0 };
  advance(engine, 0.15);
  assert.equal(engine.frame().score.red, 1);
  check(engine.frame());
});
