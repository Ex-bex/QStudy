import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import ts from "typescript";
import { FootballEngine, FIELD, validFrame } from "./lumaball/engine.ts";

const source = readFileSync(
  new URL("./lumaball/snapshot-interpolator.ts", import.meta.url),
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
const { SnapshotInterpolator } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);

function frame(seq, x = 350) {
  const value = new FootballEngine([
    { id: "red", name: "Host", team: "red", connected: true },
    { id: "blue", name: "Friend", team: "blue", connected: true },
  ]).frame();
  value.match_id = "a".repeat(32);
  value.seq = seq;
  value.kickoff = 0;
  value.elapsed = seq / 20;
  value.players[0].x = x;
  value.players[0].vx = 100;
  value.ball.x = x + 150;
  value.ball.vx = 200;
  return value;
}

test("20 Hz packets produce continuously moving frames on 60 and 120 Hz displays", () => {
  for (const rate of [60, 120]) {
    const snapshots = new SnapshotInterpolator();
    const positions = [];
    let received = 0;
    for (let render = 0; render < rate * 2; render++) {
      const now = (render * 1000) / rate;
      while (received * 50 <= now) {
        snapshots.enqueue(
          frame(received + 1, 350 + received * 5),
          received * 50,
        );
        received++;
      }
      const sampled = snapshots.sample(now);
      assert.ok(validFrame(sampled));
      if (now >= 200) positions.push(sampled.players[0].x);
    }
    const distinct = new Set(positions.map((x) => x.toFixed(4))).size;
    assert.ok(
      distinct > rate * 1.5,
      `${rate} Hz must show distinct intermediate positions, got ${distinct}`,
    );
    for (let i = 1; i < positions.length; i++) {
      assert.ok(
        positions[i] > positions[i - 1],
        "normal movement does not repeat or rewind at each network packet",
      );
      assert.ok(
        positions[i] - positions[i - 1] < 3,
        "network snapshots do not create 50 ms position jumps",
      );
    }
  }
});

test("RTC/WS duplicates and late sequences do not postpone or rewind a snapshot", () => {
  const snapshots = new SnapshotInterpolator();
  assert.equal(snapshots.enqueue(frame(3, 360), 100), true);
  assert.equal(snapshots.enqueue(frame(4, 365), 150), true);
  assert.equal(snapshots.enqueue(frame(4, 900), 200), false);
  assert.equal(snapshots.enqueue(frame(2, 200), 210), false);
  assert.equal(snapshots.sample(200).players[0].x, 362.5);
  assert.equal(
    snapshots.enqueue({ ...frame(5), ball: { x: NaN } }, 220),
    false,
  );
});

test("short packet gaps extrapolate by velocity, then freeze within safe field bounds", () => {
  const snapshots = new SnapshotInterpolator({
    delayMs: 0,
    maxExtrapolationMs: 80,
  });
  snapshots.enqueue(frame(1), 100);
  assert.equal(snapshots.sample(140).players[0].x, 354);
  assert.equal(snapshots.sample(180).players[0].x, 358);
  assert.equal(snapshots.sample(10000).players[0].x, 358);
  const wall = frame(2, FIELD.width - FIELD.playerRadius - 1);
  wall.ball.x = FIELD.right + FIELD.goalDepth - FIELD.ballRadius - 1;
  snapshots.enqueue(wall, 150);
  assert.equal(
    snapshots.sample(250).players[0].x,
    FIELD.width - FIELD.playerRadius,
  );
  assert.equal(
    snapshots.sample(250).ball.x,
    FIELD.right + FIELD.goalDepth - FIELD.ballRadius,
  );
});

test("players can move through the touchline runoff instead of snapping to the ball walls", () => {
  const snapshots = new SnapshotInterpolator({ delayMs: 0 });
  const value = frame(1);
  Object.assign(value.players[0], {
    x: FIELD.left - FIELD.playerRadius - 5,
    y: FIELD.top - FIELD.playerRadius - 5,
    vx: -100,
    vy: -100,
  });
  Object.assign(value.players[1], {
    x: FIELD.right + FIELD.playerRadius + 5,
    y: FIELD.bottom + FIELD.playerRadius + 5,
    vx: 100,
    vy: 100,
  });
  snapshots.enqueue(value, 100);
  const display = snapshots.sample(180);
  assert.equal(display.players[0].x, value.players[0].x - 8);
  assert.equal(display.players[0].y, value.players[0].y - 8);
  assert.equal(display.players[1].x, value.players[1].x + 8);
  assert.equal(display.players[1].y, value.players[1].y + 8);
  assert.ok(display.players[0].x < FIELD.left);
  assert.ok(display.players[0].y < FIELD.top);
  assert.ok(display.players[1].x > FIELD.right);
  assert.ok(display.players[1].y > FIELD.bottom);
});

test("runoff prediction still stops at every outer board edge", () => {
  const snapshots = new SnapshotInterpolator({ delayMs: 0 });
  const value = frame(1);
  Object.assign(value.players[0], {
    x: FIELD.playerRadius + 1,
    y: FIELD.playerRadius + 1,
    vx: -100,
    vy: -100,
  });
  Object.assign(value.players[1], {
    x: FIELD.width - FIELD.playerRadius - 1,
    y: FIELD.height - FIELD.playerRadius - 1,
    vx: 100,
    vy: 100,
  });
  snapshots.enqueue(value, 100);
  const display = snapshots.sample(10000);
  assert.equal(display.players[0].x, FIELD.playerRadius);
  assert.equal(display.players[0].y, FIELD.playerRadius);
  assert.equal(display.players[1].x, FIELD.width - FIELD.playerRadius);
  assert.equal(display.players[1].y, FIELD.height - FIELD.playerRadius);
});

test("kickoff and the goal delay retain smooth movement while the original world runs", () => {
  for (const phase of ["kickoff", "goal_pause"]) {
    const snapshots = new SnapshotInterpolator({ delayMs: 0 });
    const a = frame(1, 300),
      b = frame(2, 305);
    a[phase] = phase === "kickoff" ? 3 : 2.5;
    b[phase] = a[phase] - 0.05;
    snapshots.enqueue(a, 100);
    snapshots.enqueue(b, 150);
    const between = snapshots.sample(125);
    assert.equal(between.players[0].x, 302.5);
    assert.equal(between.ball.x, 452.5);
    assert.equal(between[phase], b[phase]);
    assert.equal(snapshots.sample(180).players[0].x, 308);
  }
});

test("goal/reset/roster/teleport boundaries snap instead of sliding through the field", () => {
  const changes = [
    (f) => {
      f.score.red++;
      f.players[0].x = 350;
    },
    (f) => {
      f.kickoff = 3;
      f.players[0].x = 350;
    },
    (f) => {
      f.goal_pause = 2.5;
      f.players[0].x = 350;
    },
    (f) => {
      f.players[0].x = 900;
    },
    (f) => {
      f.ball.x = 1050;
    },
    (f) => {
      f.players[0].team = "blue";
    },
    (f) => {
      f.players.pop();
    },
    (f) => {
      f.elapsed = 0;
    },
  ];
  for (const change of changes) {
    const snapshots = new SnapshotInterpolator();
    const previous = frame(1, 600);
    previous.elapsed = 3;
    snapshots.enqueue(previous, 0);
    const update = frame(2, 605);
    update.elapsed = 3.05;
    change(update);
    snapshots.enqueue(update, 50);
    const sampled = snapshots.sample(60);
    assert.equal(sampled.players[0].x, update.players[0].x);
    assert.equal(sampled.ball.x, update.ball.x);
    assert.deepEqual(sampled.score, update.score);
  }
});

test("finished and paused frames keep exact authoritative values and never extrapolate", () => {
  const snapshots = new SnapshotInterpolator({ delayMs: 0 });
  snapshots.enqueue(frame(1), 100);
  const paused = snapshots.sample(1000, false);
  assert.equal(paused.players[0].x, 350);
  const finished = frame(2, 355);
  finished.finished = true;
  finished.winner = "red";
  finished.score.red = 5;
  snapshots.enqueue(finished, 150);
  assert.deepEqual(snapshots.sample(10000), finished);
  assert.equal(snapshots.sample(10000).winner, "red");
});

test("new matches reject stale packets from retired matches and reset allows a clean room", () => {
  const snapshots = new SnapshotInterpolator();
  snapshots.enqueue(frame(99, 600), 0);
  const rematch = frame(1, 350);
  rematch.match_id = "b".repeat(32);
  assert.equal(snapshots.enqueue(rematch, 50), true);
  assert.equal(snapshots.sample(60).players[0].x, 350);
  assert.equal(snapshots.enqueue(frame(100, 605), 70), false);
  snapshots.reset();
  assert.equal(snapshots.sample(100), null);
  assert.equal(snapshots.enqueue(frame(1), 100), true);
});

test("visual sampling preserves authoritative metadata and never mutates stored inputs", () => {
  const snapshots = new SnapshotInterpolator();
  const a = frame(1, 350),
    b = frame(2, 355);
  b.players[0].name = "New name";
  const beforeA = JSON.stringify(a),
    beforeB = JSON.stringify(b);
  snapshots.enqueue(a, 0);
  snapshots.enqueue(b, 50);
  const visual = snapshots.sample(100);
  assert.equal(visual.players[0].x, 352.5);
  assert.equal(visual.players[0].name, "New name");
  assert.equal(visual.seq, b.seq);
  assert.equal(visual.elapsed, b.elapsed);
  assert.equal(visual.remaining, b.remaining);
  visual.players[0].x = 10000;
  visual.score.red = 900;
  assert.equal(snapshots.sample(100).players[0].x, 352.5);
  assert.equal(JSON.stringify(a), beforeA);
  assert.equal(JSON.stringify(b), beforeB);
});
