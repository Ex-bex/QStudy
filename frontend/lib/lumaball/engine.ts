import {
  World,
  Vec2,
  Circle,
  Edge,
  Settings,
  type Body,
  type Fixture,
  type FixtureOpt,
} from "planck";
import {
  MAPS,
  getField,
  isMapId,
  normalizeMapSettings,
  type Field,
  type MapOptions,
  type MapSettings,
} from "./maps.ts";
export { MAPS, getField, normalizeMapSettings } from "./maps.ts";
export type { Field, MapId, MapOptions, MapSettings } from "./maps.ts";

/** The original LumaBall Planck simulation, with QStudy's transport-safe frames. */
export type Team = "red" | "blue" | "spectator";
export type Input = { x: number; y: number; kick: boolean; kick_seq?: number };
export type Member = {
  id: string;
  name: string;
  team: Team;
  connected: boolean;
  is_host?: boolean;
  kind?: string;
};
export type Disc = { x: number; y: number; vx: number; vy: number };
export type GamePlayer = Disc & {
  id: string;
  name: string;
  team: "red" | "blue";
  kicking: boolean;
};
export type GameFrame = {
  seq: number;
  match_id: string;
  width: number;
  height: number;
  map_id?: MapSettings["map_id"];
  players: GamePlayer[];
  ball: Disc;
  score: { red: number; blue: number };
  elapsed: number;
  remaining: number;
  kickoff: number;
  goal_pause?: number;
  finished: boolean;
  winner: "red" | "blue" | "draw" | null;
};

// Metres remain inside Planck. Only the rendering/network boundary uses pixels.
export const PHYSICS = {
  hz: 60,
  pixelsPerMetre: 80,
  movementForce: 1.5,
  playerDamping: 1.5,
  playerDensity: 3,
  playerRestitution: 0.1,
  ballDamping: 1,
  ballDensity: 1,
  ballRestitution: 0.4,
  kickImpulse: 0.23,
  kickoffImpulse: 0.1,
  kickRadius: 0.37,
  kickoffSeconds: 3,
  goalPauseSeconds: 2.5,
};
export const FIELD = getField();
const CATEGORY = {
  player: 0b001,
  inner: 0b010,
  outer: 0b111,
  ball: 0b100,
  center: 0b011,
};
const EMPTY_INPUT: Input = { x: 0, y: 0, kick: false };
const FIXED_STEP = 1 / PHYSICS.hz;
const METRES = PHYSICS.pixelsPerMetre;
const MAX_COUNTER = 2 ** 31 - 1;
const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(high, n));

export function normalizeInput(value: unknown): Input {
  if (!value || typeof value !== "object") return { ...EMPTY_INPUT };
  const input = value as Partial<Input>;
  const result: Input = {
    // Original controls apply the full force on each pressed axis.
    x:
      typeof input.x === "number" && Number.isFinite(input.x)
        ? clamp(input.x, -1, 1)
        : 0,
    y:
      typeof input.y === "number" && Number.isFinite(input.y)
        ? clamp(input.y, -1, 1)
        : 0,
    kick: input.kick === true,
  };
  if (Number.isSafeInteger(input.kick_seq) && input.kick_seq! >= 0)
    result.kick_seq = input.kick_seq;
  return result;
}

export function validFrame(value: unknown): value is GameFrame {
  if (!value || typeof value !== "object") return false;
  const f = value as GameFrame;
  if (
    typeof f.width !== "number" ||
    typeof f.height !== "number" ||
    (f.map_id === undefined && (f.width !== 800 || f.height !== 400)) ||
    (f.map_id !== undefined && !isMapId(f.map_id)) ||
    !Number.isInteger(f.width / METRES) ||
    f.width < 800 ||
    f.width > 2400 ||
    !Number.isInteger(f.height / METRES) ||
    f.height < 400 ||
    f.height > 1200
  )
    return false;
  const disc = (d: Disc) =>
    !!d &&
    [d.x, d.y, d.vx, d.vy].every(
      (v) =>
        typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 100000,
    ) &&
    d.x >= -150 &&
    d.x <= f.width + 150 &&
    d.y >= -150 &&
    d.y <= f.height + 150;
  return (
    Number.isSafeInteger(f.seq) &&
    f.seq >= 0 &&
    typeof f.match_id === "string" &&
    f.match_id.length <= 64 &&
    Array.isArray(f.players) &&
    f.players.length <= 32 &&
    f.players.every(
      (p) =>
        disc(p) &&
        typeof p.id === "string" &&
        p.id.length <= 64 &&
        typeof p.name === "string" &&
        p.name.length <= 120 &&
        ["red", "blue"].includes(p.team) &&
        typeof p.kicking === "boolean",
    ) &&
    disc(f.ball) &&
    !!f.score &&
    [f.score.red, f.score.blue].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= MAX_COUNTER,
    ) &&
    [f.elapsed, f.remaining, f.kickoff].every(
      (n) =>
        typeof n === "number" &&
        Number.isFinite(n) &&
        n >= 0 &&
        n <= MAX_COUNTER,
    ) &&
    (f.goal_pause === undefined ||
      (Number.isFinite(f.goal_pause) &&
        f.goal_pause >= 0 &&
        f.goal_pause <= PHYSICS.goalPauseSeconds)) &&
    typeof f.finished === "boolean" &&
    [null, "red", "blue", "draw"].includes(f.winner)
  );
}

type SimPlayer = {
  id: string;
  name: string;
  team: "red" | "blue";
  body: Body;
  kicking: boolean;
  lastKickSequence: number;
};

function spawn(
  team: "red" | "blue",
  index: number,
  count: number,
  map: MapSettings,
) {
  if (map.map_id === "arena") {
    const field = getField(map);
    const origin = Vec2(map.map_width / 4, map.map_height / 2);
    const candidates: { x: number; y: number; distance: number }[] = [];
    // Dense teams stay inside the arena board and clear its solid bumpers.
    for (let row = -map.map_height; row <= map.map_height; row++) {
      for (let column = -map.map_width; column <= map.map_width; column++) {
        const x = origin.x + column * 0.5;
        const y = origin.y + row * 0.5;
        if (
          x < 1.23 ||
          x > map.map_width / 2 - 0.23 ||
          y < 0.98 ||
          y > map.map_height - 0.98
        )
          continue;
        if (
          field.obstacles.some(
            (obstacle) =>
              obstacle.kind === "circle" &&
              Math.hypot(x - obstacle.x / METRES, y - obstacle.y / METRES) <
                0.23 + obstacle.radius / METRES,
          )
        )
          continue;
        candidates.push({
          x,
          y,
          distance: (x - origin.x) ** 2 + (y - origin.y) ** 2,
        });
      }
    }
    candidates.sort(
      (a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x,
    );
    const position = candidates[index % candidates.length];
    return Vec2(
      team === "red" ? position.x : map.map_width - position.x,
      position.y,
    );
  }
  // Original centred, one-metre spacing for normal sides. Large QStudy rooms
  // use more columns so extra players do not start beyond the outer wall.
  const columns = Math.ceil(count / 5);
  const rows = Math.ceil(count / columns);
  const column = Math.floor(index / rows);
  const columnRows = Math.min(rows, count - column * rows);
  const halfSpread = (columns - 1) * 0.25;
  const center =
    team === "red"
      ? Math.min(map.map_width / 4, map.map_width / 2 - 1.5 - halfSpread)
      : Math.max(map.map_width * 0.75, map.map_width / 2 + 1.5 + halfSpread);
  return Vec2(
    center + (column - (columns - 1) / 2) * 0.5,
    map.map_height / 2 + ((index % rows) - (columnRows - 1) / 2),
  );
}

export class FootballEngine {
  private world: World;
  private players: SimPlayer[] = [];
  private inputs = new Map<string, { input: Input; at: number }>();
  private ball: Body;
  private center: Fixture[] = [];
  private score = { red: 0, blue: 0 };
  private elapsed = 0;
  private kickoff: number = PHYSICS.kickoffSeconds;
  private goalPause = 0;
  private goalStart: "red" | "blue" = "red";
  private finished = false;
  private accumulator = 0;
  private seq = 0;
  private clock = 0;
  private previousPoses: { ball: Disc; players: Map<string, Disc> } | null =
    null;
  private visualEpoch = 0;
  readonly map: MapSettings;
  readonly field: Field;
  readonly scoreLimit: number;
  readonly duration: number;

  constructor(
    members: Member[],
    scoreLimit = 0,
    minutes = 0,
    map?: MapOptions,
  ) {
    this.map = normalizeMapSettings(map);
    this.field = getField(this.map);
    this.scoreLimit = clamp(
      Number.isFinite(scoreLimit) ? Math.round(scoreLimit) : 0,
      0,
      99,
    );
    this.duration = clamp(Number.isFinite(minutes) ? minutes * 60 : 0, 0, 3600);
    Settings.velocityThreshold = 0.5;
    this.world = new World({ gravity: Vec2(0, 0) });
    this.world.setContinuousPhysics(true);
    this.createMap();
    this.ball = this.world.createBody({
      type: "dynamic",
      linearDamping: MAPS.find((map) => map.id === this.map.map_id)!
        .ballDamping,
      angularDamping: 1,
      bullet: true,
      allowSleep: false,
    });
    this.ball.createFixture({
      shape: Circle(0.1),
      density: 1,
      friction: 0.1,
      restitution: 0.4,
      filterCategoryBits: CATEGORY.ball,
      filterMaskBits: CATEGORY.inner | CATEGORY.player,
    });
    this.ball.setUserData({ type: "ball" });
    this.ball.setPosition(
      Vec2(this.map.map_width / 2, this.map.map_height / 2),
    );
    if (!this.field.hasGoals) this.kickoff = 0;
    this.syncMembers(members);
  }

  private createPlayerBody(team: "red" | "blue") {
    const body = this.world.createBody({
      type: "dynamic",
      linearDamping: MAPS.find((map) => map.id === this.map.map_id)!
        .playerDamping,
      fixedRotation: true,
      allowSleep: false,
    });
    body.createFixture({
      shape: Circle(0.22),
      density: 3,
      restitution: 0.1,
      friction: 0.3,
      filterCategoryBits: CATEGORY.player,
      filterMaskBits: CATEGORY.ball | CATEGORY.outer,
    });
    body.setUserData({ type: "player", team: team === "red" ? 1 : 2 });
    return body;
  }

  syncMembers(members: Member[]) {
    const active = members.filter(
      (m) => m.connected && (m.team === "red" || m.team === "blue"),
    );
    const previous = new Map(this.players.map((p) => [p.id, p]));
    const continuing = new Set(
      active
        .filter((m) => previous.get(m.id)?.team === m.team)
        .map((m) => m.id),
    );
    if (
      continuing.size !== this.players.length ||
      continuing.size !== active.length
    ) {
      this.previousPoses = null;
      this.visualEpoch++;
    }
    for (const player of this.players)
      if (!continuing.has(player.id)) this.world.destroyBody(player.body);
    this.players = active.map((member) => {
      const before = previous.get(member.id);
      if (continuing.has(member.id)) return { ...before!, name: member.name };
      const team = member.team as "red" | "blue";
      const teammates = active.filter((p) => p.team === team);
      const body = this.createPlayerBody(team);
      const joining = this.elapsed > 0 || this.kickoff === 0;
      body.setPosition(
        joining && this.field.hasGoals
          ? Vec2(
              team === "red" ? 0.1 : this.map.map_width - 0.1,
              this.map.map_height / 2,
            )
          : spawn(team, teammates.indexOf(member), teammates.length, this.map),
      );
      this.inputs.delete(member.id);
      return {
        id: member.id,
        name: member.name,
        team,
        body,
        kicking: false,
        lastKickSequence: -1,
      };
    });
    for (const id of this.inputs.keys())
      if (!active.some((m) => m.id === id)) this.inputs.delete(id);
  }

  input(id: string, value: unknown) {
    const player = this.players.find((p) => p.id === id);
    if (!player) return;
    const input = normalizeInput(value);
    // RTC and WebSocket delivery can cross: an old release must not cancel a
    // newer armed press or replace its movement/freshness record.
    if (
      input.kick_seq !== undefined &&
      input.kick_seq < player.lastKickSequence
    )
      return;
    const newPress =
      input.kick_seq !== undefined && input.kick_seq > player.lastKickSequence;
    if (input.kick_seq !== undefined) player.lastKickSequence = input.kick_seq;
    const before = this.inputs.get(id)?.input;
    if (!input.kick) player.kicking = false;
    else if (input.kick_seq === undefined) {
      if (!before?.kick) player.kicking = true;
    } else if (newPress) {
      player.kicking = true;
    }
    this.inputs.set(id, { input, at: this.clock });
  }

  /** Pauses simulation cleanly and bounds catch-up after a hidden tab resumes. */
  advance(seconds: number, playing = true) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const bounded = Math.min(seconds, 0.25);
    this.clock += bounded;
    if (!playing || this.finished) {
      this.accumulator = 0;
      this.previousPoses = null;
      return;
    }
    this.accumulator += bounded;
    while (this.accumulator + 1e-12 >= FIXED_STEP) {
      this.step(FIXED_STEP);
      this.accumulator = Math.max(0, this.accumulator - FIXED_STEP);
    }
  }

  private resetPositions() {
    this.previousPoses = null;
    this.visualEpoch++;
    this.ball.setLinearVelocity(Vec2(0, 0));
    this.ball.setAngularVelocity(0);
    this.ball.setPosition(
      Vec2(this.map.map_width / 2, this.map.map_height / 2),
    );
    for (const team of ["red", "blue"] as const) {
      const players = this.players.filter((p) => p.team === team);
      players.forEach((player, index) => {
        this.world.destroyBody(player.body);
        player.body = this.createPlayerBody(team);
        player.body.setPosition(spawn(team, index, players.length, this.map));
        player.kicking = false;
      });
    }
    this.goalPause = 0;
    this.kickoff = PHYSICS.kickoffSeconds;
    for (const fixture of this.center) fixture.setSensor(false);
  }

  private step(dt: number) {
    if (this.finished) return;
    const beforeReset = this.visualEpoch;
    if (this.goalPause > 0) {
      this.goalPause = Math.max(0, this.goalPause - dt);
      if (this.goalPause < 1e-10) this.resetPositions();
      else this.elapsed = Math.min(MAX_COUNTER, this.elapsed + dt);
    } else if (this.kickoff > 0) {
      this.kickoff = Math.max(0, this.kickoff - dt);
      if (this.kickoff < 1e-10) {
        this.kickoff = 0;
        this.ball.applyLinearImpulse(
          Vec2(this.goalStart === "red" ? -0.1 : 0.1, 0),
          this.ball.getWorldCenter(),
        );
        for (const fixture of this.center) fixture.setSensor(true);
      }
    } else this.elapsed = Math.min(MAX_COUNTER, this.elapsed + dt);

    // Original order matters: Planck integrates forces from the preceding tick,
    // then each player's current controls apply force/impulse for the next one.
    this.previousPoses =
      beforeReset !== this.visualEpoch
        ? null
        : {
            ball: this.disc(this.ball),
            players: new Map(
              this.players.map((player) => [player.id, this.disc(player.body)]),
            ),
          };
    this.world.step(dt, 6, 2);
    for (const player of this.players) {
      const record = this.inputs.get(player.id);
      const fresh = record && this.clock - record.at < 0.6;
      const input = fresh ? record.input : EMPTY_INPUT;
      if (!fresh) player.kicking = false;
      const center = player.body.getWorldCenter();
      if (input.y < 0) player.body.applyForce(Vec2(0, 1.5 * input.y), center);
      if (input.y > 0) player.body.applyForce(Vec2(0, 1.5 * input.y), center);
      if (input.x < 0) player.body.applyForce(Vec2(1.5 * input.x, 0), center);
      if (input.x > 0) player.body.applyForce(Vec2(1.5 * input.x, 0), center);
      if (
        player.kicking &&
        Vec2.distance(player.body.getPosition(), this.ball.getPosition()) <
          PHYSICS.kickRadius
      ) {
        const direction = this.ball
          .getPosition()
          .clone()
          .sub(player.body.getPosition());
        direction.normalize();
        this.ball.applyLinearImpulse(
          direction.mul(PHYSICS.kickImpulse),
          this.ball.getWorldCenter(),
        );
        player.kicking = false;
      }
    }
    this.checkGoal();
    if (this.duration > 0 && this.elapsed >= this.duration)
      this.finished = true;
  }

  private checkGoal() {
    if (this.goalPause > 0 || !this.field.hasGoals) return;
    const position = this.ball.getPosition();
    if (
      position.y <= this.field.goalTop / METRES ||
      position.y >= this.field.goalBottom / METRES
    )
      return;
    const left = position.x > 0.5 && position.x < 1;
    const right =
      position.x > this.map.map_width - 1 &&
      position.x < this.map.map_width - 0.5;
    if (!left && !right) return;
    const team = left ? "blue" : "red";
    this.score[team] = Math.min(MAX_COUNTER, this.score[team] + 1);
    this.goalStart = left ? "red" : "blue";
    this.goalPause = PHYSICS.goalPauseSeconds;
    this.previousPoses = null;
    if (this.scoreLimit > 0 && this.score[team] >= this.scoreLimit)
      this.finished = true;
  }

  private createMap() {
    const inner: FixtureOpt = {
      filterCategoryBits: CATEGORY.inner,
      filterMaskBits: CATEGORY.ball,
      restitution: 0.1,
    };
    const outer: FixtureOpt = {
      filterCategoryBits: CATEGORY.outer,
      filterMaskBits: CATEGORY.player | CATEGORY.ball,
    };
    const middle: FixtureOpt = {
      filterCategoryBits: CATEGORY.center,
      filterMaskBits: CATEGORY.player,
    };
    const width = this.map.map_width;
    const height = this.map.map_height;
    const halfWidth = (width - 2) / 2;
    const halfHeight = (height - 1.5) / 2;
    const ground = this.world.createBody({
      type: "static",
      position: Vec2(width / 2, height / 2),
    });
    ground.setUserData({ type: "wall" });
    if (this.field.hasGoals) {
      this.center.push(
        ground.createFixture(
          Edge(Vec2(0, -height / 2), Vec2(0, height / 2)),
          middle,
        ),
      );
      this.center.push(ground.createFixture(Circle(Vec2(0, 0), 1), middle));
      ground.createFixture(
        Edge(Vec2(-halfWidth, -halfHeight), Vec2(halfWidth, -halfHeight)),
        inner,
      );
      ground.createFixture(
        Edge(Vec2(-halfWidth, halfHeight), Vec2(halfWidth, halfHeight)),
        inner,
      );
      const goalOffset = (height - 1.5 - (height - 1.5) * 0.4) / 2;
      const upperPost = -halfHeight + goalOffset;
      const lowerPost = halfHeight - goalOffset;
      for (const x of [-halfWidth, halfWidth]) {
        const back = x < 0 ? x - 0.5 : x + 0.5;
        ground.createFixture(Circle(Vec2(x, upperPost), 0.085), outer);
        ground.createFixture(Circle(Vec2(x, lowerPost), 0.085), outer);
        ground.createFixture(
          Edge(Vec2(x, -halfHeight), Vec2(x, upperPost)),
          inner,
        );
        ground.createFixture(
          Edge(Vec2(x, lowerPost), Vec2(x, halfHeight)),
          inner,
        );
        ground.createFixture(
          Edge(Vec2(x, upperPost), Vec2(back, upperPost)),
          inner,
        );
        ground.createFixture(
          Edge(Vec2(x, lowerPost), Vec2(back, lowerPost)),
          inner,
        );
        ground.createFixture(
          Edge(Vec2(back, upperPost), Vec2(back, lowerPost)),
          inner,
        );
      }
    } else {
      // The practice arena closes the inner board for both players and the ball.
      ground.createFixture(
        Edge(Vec2(-halfWidth, -halfHeight), Vec2(halfWidth, -halfHeight)),
        outer,
      );
      ground.createFixture(
        Edge(Vec2(-halfWidth, halfHeight), Vec2(halfWidth, halfHeight)),
        outer,
      );
      ground.createFixture(
        Edge(Vec2(-halfWidth, -halfHeight), Vec2(-halfWidth, halfHeight)),
        outer,
      );
      ground.createFixture(
        Edge(Vec2(halfWidth, -halfHeight), Vec2(halfWidth, halfHeight)),
        outer,
      );
      for (const obstacle of this.field.obstacles) {
        if (obstacle.kind !== "circle") continue;
        ground.createFixture(
          Circle(
            Vec2(
              obstacle.x / METRES - width / 2,
              obstacle.y / METRES - height / 2,
            ),
            obstacle.radius / METRES,
          ),
          outer,
        );
      }
    }
    const boundary = this.world.createBody({
      type: "static",
      position: Vec2(width / 2, height / 2),
    });
    boundary.setUserData({ type: "wall" });
    boundary.createFixture(
      Edge(Vec2(-width / 2, -height / 2), Vec2(width / 2, -height / 2)),
      outer,
    );
    boundary.createFixture(
      Edge(Vec2(-width / 2, height / 2), Vec2(width / 2, height / 2)),
      outer,
    );
    boundary.createFixture(
      Edge(Vec2(-width / 2, -height / 2), Vec2(-width / 2, height / 2)),
      outer,
    );
    boundary.createFixture(
      Edge(Vec2(width / 2, -height / 2), Vec2(width / 2, height / 2)),
      outer,
    );
  }

  private disc(body: Body): Disc {
    const position = body.getPosition();
    const velocity = body.getLinearVelocity();
    return {
      x: position.x * METRES,
      y: position.y * METRES,
      vx: velocity.x * METRES,
      vy: velocity.y * METRES,
    };
  }

  /** Visual interpolation never feeds back into Planck or published frames. */
  renderFrame(frame: GameFrame = this.snapshot()): GameFrame {
    const previous = this.previousPoses;
    if (!previous || frame.finished) return frame;
    const alpha = Math.min(1, Math.max(0, this.accumulator / FIXED_STEP));
    const interpolate = (current: Disc, before: Disc): Disc => ({
      ...current,
      x: before.x + (current.x - before.x) * alpha,
      y: before.y + (current.y - before.y) * alpha,
    });
    return {
      ...frame,
      ball: interpolate(frame.ball, previous.ball),
      players: frame.players.map((player) => {
        const before = previous.players.get(player.id);
        return before ? { ...player, ...interpolate(player, before) } : player;
      }),
    };
  }

  frame(): GameFrame {
    this.seq++;
    return this.snapshot();
  }

  private snapshot(): GameFrame {
    return {
      seq: this.seq,
      match_id: "",
      width: this.field.width,
      height: this.field.height,
      map_id: this.map.map_id,
      players: this.players.map((player) => ({
        id: player.id,
        name: player.name,
        team: player.team,
        kicking: player.kicking,
        ...this.disc(player.body),
      })),
      ball: this.disc(this.ball),
      score: { ...this.score },
      elapsed: this.elapsed,
      remaining:
        this.duration > 0 ? Math.max(0, this.duration - this.elapsed) : 0,
      kickoff: this.kickoff,
      goal_pause: this.goalPause,
      finished: this.finished,
      winner: !this.finished
        ? null
        : this.score.red === this.score.blue
          ? "draw"
          : this.score.red > this.score.blue
            ? "red"
            : "blue",
    };
  }
}
