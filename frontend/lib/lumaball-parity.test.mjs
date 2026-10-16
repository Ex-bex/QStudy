import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { Vec2 } from "planck";
import { FIELD, FootballEngine } from "./lumaball/engine.ts";

const require = createRequire(import.meta.url);
const directory = new URL("./fixtures/lumaball-original/", import.meta.url);
const provenance = JSON.parse(
  readFileSync(new URL("provenance.json", directory), "utf8"),
);
const members = [
  { id: "red", name: "Alice", team: "red", connected: true },
  { id: "blue", name: "Bob", team: "blue", connected: true },
];

/** Run the actual unmodified Nuxt-era classes, replacing only their browser I/O. */
function original(roster = members) {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const schedule = (callback, milliseconds, interval = false) => {
    const id = nextTimer++;
    timers.set(id, {
      callback,
      at: now + milliseconds,
      interval: interval ? milliseconds : 0,
    });
    return id;
  };
  const cache = new Map();
  const load = (name) => {
    if (name === "planck") return require("planck");
    assert.ok(name.startsWith("~/"), name);
    if (cache.has(name)) return cache.get(name).exports;
    const path = name.slice(2) + ".ts";
    const entry = provenance.files.find((file) => file.source === path);
    assert.ok(entry, "unlisted original module: " + path);
    const source = readFileSync(new URL(entry.fixture, directory), "utf8");
    const javascript = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText;
    const module = { exports: {} };
    cache.set(name, module);
    runInNewContext(
      javascript,
      {
        module,
        exports: module.exports,
        require: load,
        useFlashEffect: () => ({ goal_flash() {} }),
        useNuxtApp: () => ({ $owebrtc: { send_data_for_host_peers() {} } }),
        window: {
          setTimeout: (fn, ms) => schedule(fn, ms),
          clearTimeout: (id) => timers.delete(id),
          setInterval: (fn, ms) => schedule(fn, ms, true),
        },
        clearInterval: (id) => timers.delete(id),
        performance: { now: () => now },
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
      },
      { filename: entry.source },
    );
    return module.exports;
  };
  const Game = load("~/utils/game").default;
  const Player = load("~/utils/player").default;
  const { State } = load("~/types/player");
  const { get_centralized_pos } = load("~/utils/utils");
  const players = roster
    .filter((member) => member.team !== "spectator")
    .map(
      (member) =>
        new Player({
          id: member.id,
          name: member.name,
          team: member.team === "red" ? 1 : 2,
          connection_id: member.id,
        }),
    );
  const room = {
    get_players: () => players,
    spawn_players() {
      for (const team of [1, 2]) {
        const side = players.filter((player) => player.team === team);
        side.forEach((player, index) => {
          if (player.body) game.alem.destroyBody(player.body);
          player.destroy_body();
          player.init_body(game.create_player());
          player.body.setPosition(
            get_centralized_pos(
              team === 1
                ? game.map.spawn_player_red
                : game.map.spawn_player_blue,
              index,
              side.length,
            ),
          );
        });
      }
    },
  };
  const game = new Game(room);
  game.start();
  let tick = 0;
  return {
    game,
    players,
    State,
    input(id, x, y, kick) {
      const player = players.find((p) => p.connection_id === id);
      player.active_state(State.Up, y < 0);
      player.active_state(State.Down, y > 0);
      player.active_state(State.Left, x < 0);
      player.active_state(State.Right, x > 0);
      if (kick !== undefined) player.active_state(State.Kick, kick);
    },
    step() {
      now = (++tick * 1000) / 60;
      // Browser timeout callbacks execute independently of the physics RAF.
      for (const [id, timer] of [...timers]) {
        if (timer.at > now + 1e-8) continue;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.callback();
      }
      // Call the original loop's exact inner step, avoiding RAF clock rounding.
      game.alem.step(1 / 60, 6, 2);
      game.handle_input();
      game.check_goal();
    },
  };
}

function equivalent(engine, source, label) {
  const actual = engine.frame();
  const compare = (disc, body, name) => {
    for (const [field, expected] of [
      ["x", body.getPosition().x * 80],
      ["y", body.getPosition().y * 80],
      ["vx", body.getLinearVelocity().x * 80],
      ["vy", body.getLinearVelocity().y * 80],
    ])
      assert.ok(
        Math.abs(disc[field] - expected) < 1e-7,
        `${label} ${name}.${field}: ${disc[field]} vs ${expected}`,
      );
  };
  compare(actual.ball, source.game.ball, "ball");
  for (const player of source.players) {
    const current = actual.players.find((p) => p.id === player.connection_id);
    compare(current, player.body, player.connection_id);
    assert.equal(
      current.kicking,
      player.get_state(source.State.Kick),
      label + " armed kick",
    );
  }
  assert.equal(
    actual.score.red,
    source.game.get_score().red,
    label + " red score",
  );
  assert.equal(
    actual.score.blue,
    source.game.get_score().blue,
    label + " blue score",
  );
}

function pair(roster = members) {
  const source = original(roster);
  const engine = new FootballEngine(roster);
  return {
    source,
    engine,
    step(label) {
      source.step();
      engine.advance(1 / 60);
      equivalent(engine, source, label);
    },
  };
}

test("the parity oracle is unmodified original LumaBall with the exact original Planck release", () => {
  assert.equal(
    JSON.parse(
      readFileSync(
        new URL("../node_modules/planck/package.json", import.meta.url),
        "utf8",
      ),
    ).version,
    "1.4.2",
  );
  for (const entry of provenance.files) {
    const bytes = readFileSync(new URL(entry.fixture, directory));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256,
      entry.source,
    );
  }
});

test("original world fixtures, masses, filters, damping and spawn geometry are retained", () => {
  const { source, engine } = pair();
  equivalent(engine, source, "initial spawn");
  const fixtures = (world) => {
    const result = [];
    for (let body = world.getBodyList(); body; body = body.getNext()) {
      for (
        let fixture = body.getFixtureList();
        fixture;
        fixture = fixture.getNext()
      ) {
        const shape = fixture.getShape();
        result.push({
          type: shape.getType(),
          radius: shape.m_radius,
          vertex1: shape.m_vertex1 && {
            x: shape.m_vertex1.x,
            y: shape.m_vertex1.y,
          },
          vertex2: shape.m_vertex2 && {
            x: shape.m_vertex2.x,
            y: shape.m_vertex2.y,
          },
          center: shape.m_p && { x: shape.m_p.x, y: shape.m_p.y },
          density: fixture.getDensity(),
          friction: fixture.getFriction(),
          restitution: fixture.getRestitution(),
          category: fixture.getFilterCategoryBits(),
          mask: fixture.getFilterMaskBits(),
        });
      }
    }
    return result;
  };
  const actual = fixtures(engine.world);
  const expected = fixtures(source.game.alem);
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) {
    for (const key of Object.keys(actual[index])) {
      if (typeof actual[index][key] === "number")
        assert.ok(
          Math.abs(actual[index][key] - expected[index][key]) < 1e-12,
          `fixture ${index} ${key}`,
        );
      else
        assert.deepEqual(
          actual[index][key],
          expected[index][key],
          `fixture ${index} ${key}`,
        );
    }
  }
  assert.equal(FIELD.width, source.game.map.width * 80);
  assert.equal(FIELD.height, source.game.map.height * 80);
  assert.equal(
    engine.players[0].body.getMass(),
    source.players[0].body.getMass(),
  );
  assert.equal(engine.ball.getMass(), source.game.ball.getMass());
});

test("movement, diagonal acceleration, stopping, centre kickoff barriers and kickoff impulse match original", () => {
  const match = pair();
  for (let tick = 0; tick < 660; tick++) {
    const x = tick < 250 ? 1 : tick < 400 ? -1 : 0;
    const y = tick < 100 ? -1 : tick < 250 ? 1 : 0;
    match.source.input("red", x, y);
    match.engine.input("red", { x, y, kick: false });
    match.step("movement tick " + tick);
  }
});

test("original crowded two-team player collisions retain their trajectories", () => {
  const roster = Array.from({ length: 6 }, (_, index) => ({
    id: String(index),
    name: `Player ${index}`,
    connected: true,
    team: index % 2 === 0 ? "red" : "blue",
  }));
  const match = pair(roster);
  for (let tick = 0; tick < 600; tick++) {
    for (const member of roster) {
      const x = member.team === "red" ? 1 : -1;
      const y = Number(member.id) < 2 ? 1 : -1;
      match.source.input(member.id, x, y);
      match.engine.input(member.id, { x, y, kick: false });
    }
    match.step("crowded tick " + tick);
  }
});

test("original continuous ball/player collisions, wall rebounds, posts and free ball damping match", () => {
  for (const scenario of [
    { name: "inner horizontal wall", ball: [5, 1, 1, -7] },
    { name: "side wall outside goal", ball: [8.5, 1.25, 7, 1] },
    { name: "round goal post", ball: [8.3, 1.65, 9, 1.25] },
    { name: "player and ball", ball: [3.5, 2.5, -7, 0] },
    { name: "ball free damped diagonal", ball: [4.6, 1.5, 0.5, 0.7] },
  ]) {
    const match = pair();
    for (let tick = 0; tick < 181; tick++)
      match.step(scenario.name + " kickoff " + tick);
    const [x, y, vx, vy] = scenario.ball;
    for (const ball of [match.engine.ball, match.source.game.ball]) {
      ball.setPosition(Vec2(x, y));
      ball.setLinearVelocity(Vec2(vx, vy));
    }
    for (let tick = 0; tick < 180; tick++)
      match.step(scenario.name + " tick " + tick);
  }
});

test("the original armed kick waits for contact, consumes once and re-arms on a fresh press", () => {
  const match = pair();
  for (let tick = 0; tick < 181; tick++) match.step("kickoff " + tick);
  const setContact = () => {
    for (const player of [
      match.engine.players[0].body,
      match.source.players[0].body,
    ]) {
      player.setPosition(Vec2(2.5, 2.5));
      player.setLinearVelocity(Vec2(0, 0));
    }
    for (const ball of [match.engine.ball, match.source.game.ball]) {
      ball.setPosition(Vec2(2.85, 2.5));
      ball.setLinearVelocity(Vec2(0, 0));
    }
  };
  match.source.input("red", 0, 0, true);
  match.engine.input("red", { x: 0, y: 0, kick: true, kick_seq: 1 });
  match.step("armed while distant");
  setContact();
  match.step("first successful contact");
  setContact();
  for (let tick = 0; tick < 20; tick++) {
    match.engine.input("red", { x: 0, y: 0, kick: true, kick_seq: 1 });
    match.step("held press " + tick);
  }
  match.source.input("red", 0, 0, true);
  match.engine.input("red", { x: 0, y: 0, kick: true, kick_seq: 2 });
  match.step("new keydown repeat");
});

test("a goal, the 2.5-second post-goal play and three-second next kickoff match original", () => {
  for (const direction of [-1, 1]) {
    const match = pair();
    for (let tick = 0; tick < 181; tick++) match.step("goal kickoff " + tick);
    for (const ball of [match.engine.ball, match.source.game.ball]) {
      ball.setPosition(Vec2(direction > 0 ? 8.9 : 1.1, 2.5));
      ball.setLinearVelocity(Vec2(direction * 6, 0));
    }
    for (let tick = 0; tick < 350; tick++)
      match.step("goal direction " + direction + " tick " + tick);
    assert.equal(match.engine.frame().score[direction > 0 ? "red" : "blue"], 1);
    assert.equal(match.engine.frame().kickoff, 0);
  }
});
