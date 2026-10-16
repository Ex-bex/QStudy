import assert from "node:assert/strict";
import { test } from "node:test";
import { Vec2 } from "planck";
import { FootballEngine, validFrame } from "./lumaball/engine.ts";
import { getField, MAPS, normalizeMapSettings } from "./lumaball/maps.ts";

const members = [
  { id: "red", name: "Alice", team: "red", connected: true },
  { id: "blue", name: "Bob", team: "blue", connected: true },
];
function advance(engine, seconds) {
  for (let tick = 0; tick < Math.ceil(seconds * 60); tick++)
    engine.advance(1 / 60);
}
function putBall(engine, x, y, vx = 0, vy = 0) {
  engine.ball.setPosition(Vec2(x / 80, y / 80));
  engine.ball.setLinearVelocity(Vec2(vx / 80, vy / 80));
}

test("map catalog has three distinct modes and bounded original metre dimensions", () => {
  assert.deepEqual(
    MAPS.map((map) => map.id),
    ["classic", "hockey", "arena"],
  );
  assert.deepEqual(normalizeMapSettings(), {
    map_id: "classic",
    map_width: 10,
    map_height: 5,
  });
  assert.deepEqual(
    normalizeMapSettings({ map_id: "unknown", map_width: 100, map_height: -1 }),
    { map_id: "classic", map_width: 30, map_height: 5 },
  );
  assert.deepEqual(
    normalizeMapSettings({ map_width: NaN, map_height: Infinity }),
    { map_id: "classic", map_width: 10, map_height: 5 },
  );
  for (const map of MAPS) {
    const room = {
      map_id: map.id,
      map_width: map.width,
      map_height: map.height,
    };
    const frame = new FootballEngine(members, 0, 0, room).frame();
    assert.equal(frame.map_id, map.id);
    assert.equal(frame.width, map.width * 80);
    assert.equal(frame.height, map.height * 80);
    assert.deepEqual(getField(room), getField(frame));
    assert.ok(validFrame(frame));
  }
});

test("expanded football goals, ball walls and original player outskirts follow the selected dimensions", () => {
  for (const size of [
    [11, 6],
    [20, 10],
    [30, 15],
  ]) {
    const engine = new FootballEngine(members, 1, 0, {
      map_id: "classic",
      map_width: size[0],
      map_height: size[1],
    });
    const field = engine.field;
    advance(engine, 3.1);
    assert.equal(engine.frame().players[0].x, field.width / 4);
    assert.equal(engine.frame().players[0].y, field.height / 2);
    putBall(engine, field.right - 12, field.top + 20, 600);
    advance(engine, 0.2);
    assert.ok(
      engine.frame().ball.vx < 0,
      "dynamic side board bounces the ball",
    );
    assert.deepEqual(engine.frame().score, { red: 0, blue: 0 });
    putBall(engine, field.right - 2, field.height / 2, 600);
    advance(engine, 0.15);
    assert.deepEqual(engine.frame().score, { red: 1, blue: 0 });
    assert.equal(engine.frame().finished, true);
  }
});

test("hockey keeps goal rules and original mass/shot strength while the ice changes damping", () => {
  const football = new FootballEngine(members);
  const hockey = new FootballEngine(members, 1, 0, { map_id: "hockey" });
  assert.equal(hockey.ball.getMass(), football.ball.getMass());
  assert.equal(
    hockey.players[0].body.getMass(),
    football.players[0].body.getMass(),
  );
  advance(football, 3.1);
  advance(hockey, 3.1);
  for (const engine of [football, hockey]) putBall(engine, 400, 110, 100);
  advance(football, 0.25);
  advance(hockey, 0.25);
  assert.ok(hockey.frame().ball.vx > football.frame().ball.vx);
  assert.equal(hockey.ball.getLinearDamping(), 0.2);
  assert.equal(hockey.players[0].body.getLinearDamping(), 0.45);
  putBall(hockey, hockey.field.right - 2, hockey.field.height / 2, 600);
  advance(hockey, 0.15);
  assert.deepEqual(hockey.frame().score, { red: 1, blue: 0 });
});

test("arena has closed ball and player boards, collidable symmetric obstacles and no automatic goals", () => {
  const engine = new FootballEngine(members, 1, 0, {
    map_id: "arena",
    map_width: 14,
    map_height: 8,
  });
  const field = engine.field;
  assert.equal(engine.frame().kickoff, 0);
  assert.equal(field.hasGoals, false);
  assert.equal(field.obstacles.length, 4);
  for (const obstacle of field.obstacles)
    assert.ok(
      field.obstacles.some(
        (other) =>
          Math.abs(other.x - (field.width - obstacle.x)) < 1e-8 &&
          Math.abs(other.y - (field.height - obstacle.y)) < 1e-8,
      ),
    );
  putBall(engine, field.right - 12, field.height / 2, 600);
  advance(engine, 0.2);
  assert.ok(engine.frame().ball.vx < 0);
  assert.deepEqual(engine.frame().score, { red: 0, blue: 0 });
  assert.equal(engine.frame().finished, false);
  const obstacle = field.obstacles[0];
  putBall(
    engine,
    obstacle.x - obstacle.radius - field.ballRadius - 5,
    obstacle.y,
    300,
  );
  advance(engine, 0.1);
  assert.ok(
    engine.frame().ball.vx < 0,
    "bumper rebounds match its drawn circle",
  );
  for (let index = 0; index < 480; index++) {
    engine.input("red", { x: -1, y: 0, kick: false });
    engine.advance(1 / 60);
  }
  assert.ok(
    engine.frame().players[0].x >= field.left + field.playerRadius - 0.5,
  );
  engine.syncMembers([
    ...members,
    { id: "late", name: "Late", team: "red", connected: true },
  ]);
  const joined = engine.frame().players.find((player) => player.id === "late");
  assert.ok(
    joined.x > field.left && joined.x < field.right,
    "late arena players join inside its board",
  );
  const limited = new FootballEngine(members, 1, 1, { map_id: "arena" });
  advance(limited, 60.1);
  assert.equal(limited.frame().finished, true);
  assert.equal(limited.frame().winner, "draw");
});

test("frame validation rejects forged maps, fractional sizes and objects outside their own map", () => {
  const frame = new FootballEngine(members, 0, 0, {
    map_id: "hockey",
    map_width: 30,
    map_height: 15,
  }).frame();
  assert.ok(validFrame(frame));
  for (const patch of [
    { map_id: "unknown" },
    { width: "2400" },
    { height: "1200" },
    { map_id: undefined },
    { width: 2401 },
    { width: 801 },
    { height: 399 },
    { height: 1201 },
    { width: NaN },
    { ball: { ...frame.ball, x: frame.width + 151 } },
    { ball: { ...frame.ball, y: -151 } },
  ])
    assert.equal(validFrame({ ...frame, ...patch }), false);
  const legacy = new FootballEngine(members).frame();
  delete legacy.map_id;
  assert.ok(
    validFrame(legacy),
    "only original classic frames may omit map identity",
  );
});

test("full arena teams spawn inside the closed board without overlapping each other or bumpers", () => {
  for (const team of ["red", "blue"]) {
    const roster = Array.from({ length: 32 }, (_, index) => ({
      id: String(index),
      name: String(index),
      team,
      connected: true,
    }));
    const engine = new FootballEngine(roster, 0, 0, { map_id: "arena" });
    const field = engine.field;
    const frame = engine.frame();
    for (const player of frame.players) {
      assert.ok(player.x >= field.left + field.playerRadius);
      assert.ok(player.x <= field.right - field.playerRadius);
      assert.ok(player.y >= field.top + field.playerRadius);
      assert.ok(player.y <= field.bottom - field.playerRadius);
      for (const other of frame.players)
        if (player !== other)
          assert.ok(
            Math.hypot(player.x - other.x, player.y - other.y) >=
              field.playerRadius * 2,
          );
      for (const obstacle of field.obstacles)
        assert.ok(
          Math.hypot(player.x - obstacle.x, player.y - obstacle.y) >
            field.playerRadius + obstacle.radius,
        );
    }
  }
});

test("host rendering moves continuously between fixed physics ticks at 60/120/144 Hz after a shot", () => {
  for (const rate of [60, 120, 144]) {
    const engine = new FootballEngine(members);
    advance(engine, 3.1);
    engine.players[0].body.setPosition(Vec2(2.5, 2.5));
    engine.players[0].body.setLinearVelocity(Vec2(0, 0));
    putBall(engine, 228, 200);
    engine.previousPoses = null;
    engine.input("red", { x: 0, y: 0, kick: true, kick_seq: 1 });
    const positions = [];
    for (let index = 0; index < Math.ceil(rate * 0.35); index++) {
      engine.advance(1 / rate);
      const frame = engine.frame();
      const before = JSON.stringify(frame);
      const seq = engine.seq;
      const displayed = engine.renderFrame(frame);
      engine.renderFrame();
      assert.equal(
        engine.seq,
        seq,
        "rendering never increments the network sequence",
      );
      assert.equal(
        JSON.stringify(frame),
        before,
        "rendering leaves authoritative state untouched",
      );
      assert.equal(displayed.ball.vx, frame.ball.vx);
      positions.push(displayed.ball.x);
    }
    for (let index = 5; index < positions.length; index++)
      assert.ok(
        positions[index] > positions[index - 1],
        `${rate} Hz display frame ${index} moves between physics ticks`,
      );
    assert.equal(engine.frame().players[0].kicking, false);
    const beforePause = engine.frame();
    engine.advance(1 / rate, false);
    assert.deepEqual(
      engine.renderFrame(beforePause),
      beforePause,
      "pause displays the exact authoritative pose",
    );
  }
});

test("visual interpolation snaps across goals, roster changes, resets and finished matches", () => {
  const engine = new FootballEngine(members);
  advance(engine, 3.1);
  putBall(engine, 718, 200, 600);
  engine.advance(1 / 60);
  let frame = engine.frame();
  assert.equal(frame.goal_pause > 0, true);
  assert.equal(
    engine.renderFrame(frame),
    frame,
    "new goal invalidates pre-goal poses",
  );
  advance(engine, 2.5);
  engine.syncMembers([members[0]]);
  frame = engine.frame();
  assert.equal(
    engine.renderFrame(frame),
    frame,
    "roster changes invalidate stale player poses",
  );
  engine.resetPositions();
  frame = engine.frame();
  assert.equal(
    engine.renderFrame(frame),
    frame,
    "kickoff reset cannot draw the previous goal position",
  );
  engine.finished = true;
  frame = engine.frame();
  assert.equal(engine.renderFrame(frame), frame);
});
