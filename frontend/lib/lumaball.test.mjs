import assert from "node:assert/strict";
import { test } from "node:test";
import { Vec2 } from "planck";
import {
  FootballEngine,
  FIELD,
  PHYSICS,
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
const putBall = (engine, x, y, vx = 0, vy = 0) => {
  engine.ball.setPosition(Vec2(x / 80, y / 80));
  engine.ball.setLinearVelocity(Vec2(vx / 80, vy / 80));
};

test("original per-axis forces are restored while hostile input stays outside physics", () => {
  assert.deepEqual(normalizeInput({ x: 1000, y: 1000, kick: true }), {
    x: 1,
    y: 1,
    kick: true,
  });
  assert.deepEqual(
    normalizeInput({ x: NaN, y: Infinity, kick: "true", kick_seq: -1 }),
    { x: 0, y: 0, kick: false },
  );
  assert.deepEqual(normalizeInput(null), { x: 0, y: 0, kick: false });
  assert.equal(
    normalizeInput({ kick: true, kick_seq: Number.MAX_SAFE_INTEGER }).kick_seq,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    normalizeInput({ kick: true, kick_seq: Infinity }).kick_seq,
    undefined,
  );
});

test("spectators have no body; players can leave the inner pitch but remain inside the outer board", () => {
  const engine = new FootballEngine(members);
  engine.input("watch", { x: 1, y: 1, kick: true });
  advance(engine, 8, { x: 1, y: -1, kick: true });
  const frame = engine.frame();
  assert.equal(frame.players.length, 2);
  assert.ok(!frame.players.some((p) => p.id === "watch"));
  const player = frame.players.find((p) => p.id === "red");
  assert.ok(
    player.y < FIELD.top,
    "players cross the ball's inner boundary as in LumaBall",
  );
  assert.ok(player.x <= FIELD.width - FIELD.playerRadius + 0.5);
  assert.ok(player.y >= FIELD.playerRadius - 0.5);
  advance(engine, 8);
  const stopped = engine.frame().players[0];
  assert.ok(Math.hypot(stopped.vx, stopped.vy) < 0.1);
  assert.ok(validFrame(engine.frame()));
});

test("pause and tab catch-up do not advance a match by arbitrary wall time", () => {
  const engine = new FootballEngine(members, 5, 1);
  advance(engine, 4);
  const before = engine.frame().elapsed;
  engine.advance(10000, false);
  assert.equal(engine.frame().elapsed, before);
  engine.advance(10000, true);
  assert.ok(engine.frame().elapsed - before <= 0.251);
});

test("a ball crossing the goal mouth scores once and honors an explicitly selected score limit", () => {
  const engine = new FootballEngine(members, 1, 5);
  advance(engine, 3.1);
  putBall(engine, FIELD.right - 2, FIELD.height / 2, 600);
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
  advance(engine, 3.1);
  putBall(engine, FIELD.right - 12, 100, 600);
  advance(engine, 0.2);
  assert.deepEqual(engine.frame().score, { red: 0, blue: 0 });
  assert.ok(engine.frame().ball.vx < 0);
});

test("configured time limits still finish a match; original default matches have no automatic limit", () => {
  const limited = new FootballEngine(members, 0, 1);
  advance(limited, 63.1);
  assert.equal(limited.frame().finished, true);
  assert.equal(limited.frame().winner, "draw");
  const original = new FootballEngine(members);
  advance(original, 305);
  assert.equal(original.frame().finished, false);
  assert.equal(original.duration, 0);
  assert.equal(original.scoreLimit, 0);
  assert.ok(original.frame().elapsed > 300);
  original.syncMembers([{ ...members[0], connected: false }, members[1]]);
  assert.deepEqual(
    original.frame().players.map((p) => p.id),
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
  assert.equal(
    validFrame({ ...frame, score: { red: 2 ** 31, blue: 0 } }),
    false,
  );
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
  assert.equal(
    validFrame({
      ...frame,
      players: [{ ...frame.players[0], kicking: "true" }],
    }),
    false,
  );
  assert.equal(validFrame({ ...frame, goal_pause: NaN }), false);
  assert.equal(validFrame({ ...frame, goal_pause: 99 }), false);
});

test("large QStudy teams spawn safely without changing original small-team positions", () => {
  const original = new FootballEngine(members).frame();
  assert.equal(original.players[0].x, 200);
  assert.equal(original.players[0].y, 200);
  assert.equal(original.players[1].x, 600);
  const roster = Array.from({ length: 32 }, (_, index) => ({
    id: String(index),
    name: `Player ${index}`,
    connected: true,
    team: "red",
  }));
  const engine = new FootballEngine(roster);
  const check = (frame) => {
    assert.equal(frame.players.length, 32);
    for (const player of frame.players) {
      assert.ok(player.y >= FIELD.playerRadius);
      assert.ok(player.y <= FIELD.height - FIELD.playerRadius);
      assert.ok(player.x >= FIELD.playerRadius);
      assert.ok(player.x <= FIELD.width - FIELD.playerRadius);
      for (const other of frame.players)
        if (other.id !== player.id)
          assert.ok(
            Math.hypot(other.x - player.x, other.y - player.y) >=
              2 * FIELD.playerRadius,
          );
    }
  };
  check(engine.frame());
  putBall(engine, FIELD.right - 2, FIELD.height / 2, 600);
  engine.checkGoal();
  advance(engine, 2.6);
  check(engine.frame());
});

test("the original three-second kickoff permits movement behind the centre barrier", () => {
  const engine = new FootballEngine(members);
  advance(engine, 2.9, { x: 1, y: 0, kick: false });
  const preparing = engine.frame();
  assert.ok(preparing.players[0].x > 200, "players move before kickoff");
  assert.ok(preparing.players[0].x < FIELD.width / 2 - FIELD.centerRadius);
  assert.ok(preparing.kickoff > 0);
  assert.equal(preparing.elapsed, 0);
  advance(engine, 1.5, { x: 1, y: 0, kick: false });
  assert.equal(engine.frame().kickoff, 0);
  assert.ok(engine.frame().players[0].x > FIELD.width / 2);
});

test("a successful kick consumes its press and duplicate RTC/WS packets cannot re-arm it", () => {
  const engine = new FootballEngine(members);
  advance(engine, 3.1);
  const red = engine.players.find((player) => player.id === "red");
  const setup = () => {
    red.body.setPosition(Vec2(2.5, 2.5));
    red.body.setLinearVelocity(Vec2(0, 0));
    engine.ball.setPosition(Vec2(2.85, 2.5));
    engine.ball.setLinearVelocity(Vec2(0, 0));
  };
  setup();
  engine.input("red", { x: 0, y: 0, kick: true, kick_seq: 100 });
  engine.advance(1 / 60);
  assert.ok(engine.frame().ball.vx > 580);
  assert.equal(engine.frame().players[0].kicking, false);
  setup();
  for (const sequence of [100, 99, 100]) {
    engine.input("red", { x: 0, y: 0, kick: true, kick_seq: sequence });
    engine.advance(1 / 60);
    assert.equal(engine.frame().ball.vx, 0);
  }
  engine.input("red", { x: 0, y: 0, kick: true, kick_seq: 101 });
  engine.advance(1 / 60);
  assert.ok(
    engine.frame().ball.vx > 580,
    "a repeated real keydown permits the next shot",
  );
});

test("an armed distant kick waits for contact and is cancelled on release", () => {
  const engine = new FootballEngine(members);
  advance(engine, 3.1);
  putBall(engine, 400, 100);
  engine.input("red", { x: 0, y: 0, kick: true, kick_seq: 1 });
  engine.advance(1 / 60);
  assert.equal(engine.frame().players[0].kicking, true);
  engine.input("red", { x: 0, y: 0, kick: false, kick_seq: 1 });
  engine.advance(1 / 60);
  assert.equal(engine.frame().players[0].kicking, false);
  assert.equal(PHYSICS.kickImpulse, 0.23);
});
