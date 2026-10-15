/** QBall's fixed-step disc football simulation. No browser or network state. */
export type Team = "red" | "blue" | "spectator";
export type Input = { x: number; y: number; kick: boolean };
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
  players: GamePlayer[];
  ball: Disc;
  score: { red: number; blue: number };
  elapsed: number;
  remaining: number;
  kickoff: number;
  finished: boolean;
  winner: "red" | "blue" | "draw" | null;
};
export const FIELD = {
  width: 1200,
  height: 700,
  left: 72,
  right: 1128,
  top: 60,
  bottom: 640,
  goalTop: 244,
  goalBottom: 456,
  goalDepth: 34,
  playerRadius: 20,
  ballRadius: 11,
};
const EMPTY_INPUT: Input = { x: 0, y: 0, kick: false };
const FIXED_STEP = 1 / 60;
const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(high, n));

function spawn(team: "red" | "blue", index: number, count: number) {
  const columns = Math.ceil(count / 8);
  const rows = Math.ceil(count / columns);
  const column = Math.floor(index / rows);
  const row = index % rows;
  const columnRows = Math.min(rows, count - column * rows);
  return {
    x: team === "red" ? 350 - column * 62 : 850 + column * 62,
    y: 350 + (row - (columnRows - 1) / 2) * 62,
  };
}

export function normalizeInput(value: unknown): Input {
  if (!value || typeof value !== "object") return { ...EMPTY_INPUT };
  const input = value as Partial<Input>;
  let x =
    typeof input.x === "number" && Number.isFinite(input.x)
      ? clamp(input.x, -1, 1)
      : 0;
  let y =
    typeof input.y === "number" && Number.isFinite(input.y)
      ? clamp(input.y, -1, 1)
      : 0;
  const length = Math.hypot(x, y);
  if (length > 1) {
    x /= length;
    y /= length;
  }
  return { x, y, kick: input.kick === true };
}

export function validFrame(value: unknown): value is GameFrame {
  if (!value || typeof value !== "object") return false;
  const f = value as GameFrame;
  const disc = (d: Disc) =>
    !!d &&
    [d.x, d.y, d.vx, d.vy].every(
      (v) =>
        typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 100000,
    );
  return (
    Number.isSafeInteger(f.seq) &&
    f.seq >= 0 &&
    typeof f.match_id === "string" &&
    f.match_id.length <= 64 &&
    f.width === FIELD.width &&
    f.height === FIELD.height &&
    Array.isArray(f.players) &&
    f.players.length <= 32 &&
    f.players.every(
      (p) =>
        disc(p) &&
        typeof p.id === "string" &&
        p.id.length <= 64 &&
        typeof p.name === "string" &&
        p.name.length <= 120 &&
        ["red", "blue"].includes(p.team),
    ) &&
    disc(f.ball) &&
    !!f.score &&
    [f.score.red, f.score.blue].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= 999,
    ) &&
    [f.elapsed, f.remaining, f.kickoff].every(
      (n) =>
        typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 86400,
    ) &&
    typeof f.finished === "boolean" &&
    [null, "red", "blue", "draw"].includes(f.winner)
  );
}

function collide(
  a: Disc,
  b: Disc,
  ra: number,
  rb: number,
  ma: number,
  mb: number,
) {
  let dx = b.x - a.x,
    dy = b.y - a.y;
  let distance = Math.hypot(dx, dy);
  if (distance >= ra + rb) return;
  if (distance < 0.00001) {
    dx = 1;
    dy = 0;
    distance = 1;
  }
  const nx = dx / distance,
    ny = dy / distance;
  const overlap = ra + rb - distance;
  const invA = 1 / ma,
    invB = 1 / mb,
    inverse = invA + invB;
  a.x -= (nx * overlap * invA) / inverse;
  a.y -= (ny * overlap * invA) / inverse;
  b.x += (nx * overlap * invB) / inverse;
  b.y += (ny * overlap * invB) / inverse;
  const speed = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (speed >= 0) return;
  const impulse = (-(1.0 + 0.7) * speed) / inverse;
  a.vx -= impulse * invA * nx;
  a.vy -= impulse * invA * ny;
  b.vx += impulse * invB * nx;
  b.vy += impulse * invB * ny;
}

export class FootballEngine {
  private players: GamePlayer[] = [];
  private inputs = new Map<string, { input: Input; at: number }>();
  private cooldown = new Map<string, number>();
  private ball: Disc = { x: 600, y: 350, vx: 0, vy: 0 };
  private score = { red: 0, blue: 0 };
  private elapsed = 0;
  private kickoff = 1.2;
  private finished = false;
  private accumulator = 0;
  private seq = 0;
  private clock = 0;
  readonly scoreLimit: number;
  readonly duration: number;
  constructor(members: Member[], scoreLimit = 5, minutes = 5) {
    this.scoreLimit = clamp(
      Number.isFinite(scoreLimit) ? Math.round(scoreLimit) : 5,
      1,
      99,
    );
    this.duration = clamp(
      Number.isFinite(minutes) ? minutes * 60 : 300,
      60,
      3600,
    );
    this.syncMembers(members);
  }
  syncMembers(members: Member[]) {
    const active = members.filter(
      (m) => m.connected && (m.team === "red" || m.team === "blue"),
    );
    const previous = new Map(this.players.map((p) => [p.id, p]));
    this.players = active.map((m) => {
      const before = previous.get(m.id);
      if (before && before.team === m.team) return { ...before, name: m.name };
      const team = m.team as "red" | "blue";
      const teammates = active.filter((p) => p.team === team);
      return {
        id: m.id,
        name: m.name,
        team,
        ...spawn(team, teammates.indexOf(m), teammates.length),
        vx: 0,
        vy: 0,
        kicking: false,
      };
    });
    for (const id of this.inputs.keys())
      if (!active.some((m) => m.id === id)) this.inputs.delete(id);
  }
  input(id: string, input: unknown) {
    if (this.players.some((p) => p.id === id))
      this.inputs.set(id, { input: normalizeInput(input), at: this.clock });
  }
  /** Bounds tab-resume catch-up to keep both the timer and collision loop sane. */
  advance(seconds: number, playing = true) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const bounded = Math.min(seconds, 0.2);
    this.clock += bounded;
    if (!playing || this.finished) {
      this.accumulator = 0;
      return;
    }
    this.accumulator += bounded;
    while (this.accumulator >= FIXED_STEP) {
      this.step(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
    }
  }
  private resetPositions() {
    this.ball = { x: 600, y: 350, vx: 0, vy: 0 };
    for (const team of ["red", "blue"] as const) {
      const players = this.players.filter((p) => p.team === team);
      players.forEach((p, i) =>
        Object.assign(p, {
          ...spawn(team, i, players.length),
          vx: 0,
          vy: 0,
          kicking: false,
        }),
      );
    }
    this.kickoff = 1.2;
  }
  private step(dt: number) {
    if (this.finished) return;
    if (this.kickoff > 0) {
      this.kickoff = Math.max(0, this.kickoff - dt);
      return;
    }
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    if (this.elapsed >= this.duration) {
      this.finished = true;
      return;
    }
    for (const p of this.players) {
      const record = this.inputs.get(p.id);
      const input =
        record && this.clock - record.at < 0.6 ? record.input : EMPTY_INPUT;
      p.vx = (p.vx + input.x * 1550 * dt) * Math.exp(-5 * dt);
      p.vy = (p.vy + input.y * 1550 * dt) * Math.exp(-5 * dt);
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > 300) {
        p.vx *= 300 / speed;
        p.vy *= 300 / speed;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.x = clamp(
        p.x,
        FIELD.left + FIELD.playerRadius,
        FIELD.right - FIELD.playerRadius,
      );
      p.y = clamp(
        p.y,
        FIELD.top + FIELD.playerRadius,
        FIELD.bottom - FIELD.playerRadius,
      );
      p.kicking = input.kick;
      const dx = this.ball.x - p.x,
        dy = this.ball.y - p.y,
        distance = Math.hypot(dx, dy);
      if (
        input.kick &&
        distance < 51 &&
        this.clock >= (this.cooldown.get(p.id) || 0)
      ) {
        const nx = distance > 0.01 ? dx / distance : p.team === "red" ? 1 : -1;
        const ny = distance > 0.01 ? dy / distance : 0;
        this.ball.vx += nx * 470;
        this.ball.vy += ny * 470;
        this.cooldown.set(p.id, this.clock + 0.22);
      }
    }
    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++)
        collide(this.players[i], this.players[j], 20, 20, 3, 3);
      collide(this.players[i], this.ball, 20, 11, 3, 0.7);
    }
    const maxBallSpeed = Math.hypot(this.ball.vx, this.ball.vy);
    if (maxBallSpeed > 900) {
      this.ball.vx *= 900 / maxBallSpeed;
      this.ball.vy *= 900 / maxBallSpeed;
    }
    this.ball.x += this.ball.vx * dt;
    this.ball.y += this.ball.vy * dt;
    this.ball.vx *= Math.exp(-0.72 * dt);
    this.ball.vy *= Math.exp(-0.72 * dt);
    const r = FIELD.ballRadius;
    if (this.ball.y < FIELD.top + r) {
      this.ball.y = FIELD.top + r;
      this.ball.vy = Math.abs(this.ball.vy) * 0.82;
    }
    if (this.ball.y > FIELD.bottom - r) {
      this.ball.y = FIELD.bottom - r;
      this.ball.vy = -Math.abs(this.ball.vy) * 0.82;
    }
    const inGoal =
      this.ball.y > FIELD.goalTop + r && this.ball.y < FIELD.goalBottom - r;
    if (!inGoal) {
      if (this.ball.x < FIELD.left + r) {
        this.ball.x = FIELD.left + r;
        this.ball.vx = Math.abs(this.ball.vx) * 0.82;
      }
      if (this.ball.x > FIELD.right - r) {
        this.ball.x = FIELD.right - r;
        this.ball.vx = -Math.abs(this.ball.vx) * 0.82;
      }
    } else if (this.ball.x < FIELD.left - r || this.ball.x > FIELD.right + r) {
      this.score[this.ball.x < FIELD.left ? "blue" : "red"] += 1;
      if (Math.max(this.score.red, this.score.blue) >= this.scoreLimit)
        this.finished = true;
      else this.resetPositions();
    }
  }
  frame(): GameFrame {
    return {
      seq: ++this.seq,
      match_id: "",
      width: FIELD.width,
      height: FIELD.height,
      players: this.players.map((p) => ({ ...p })),
      ball: { ...this.ball },
      score: { ...this.score },
      elapsed: this.elapsed,
      remaining: Math.max(0, this.duration - this.elapsed),
      kickoff: this.kickoff,
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
