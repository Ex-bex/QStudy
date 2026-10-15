import {
  FIELD,
  validFrame,
  type Disc,
  type GameFrame,
  type GamePlayer,
} from "./engine";

type Snapshot = { frame: GameFrame; at: number };
type Options = { delayMs?: number; maxExtrapolationMs?: number };
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const copy = (frame: GameFrame): GameFrame => ({
  ...frame,
  players: frame.players.map((player) => ({ ...player })),
  ball: { ...frame.ball },
  score: { ...frame.score },
});

function discontinuity(previous: Snapshot, current: Snapshot): boolean {
  const a = previous.frame;
  const b = current.frame;
  if (
    a.match_id !== b.match_id ||
    a.score.red !== b.score.red ||
    a.score.blue !== b.score.blue ||
    a.finished !== b.finished ||
    b.kickoff > a.kickoff + 0.05 ||
    b.elapsed < a.elapsed - 0.05 ||
    current.at - previous.at > 250 ||
    a.players.length !== b.players.length
  )
    return true;
  const seconds = Math.max(0, current.at - previous.at) / 1000;
  const previousPlayers = new Map(
    a.players.map((player) => [player.id, player]),
  );
  if (
    b.players.some((player) => {
      const before = previousPlayers.get(player.id);
      return (
        !before ||
        before.team !== player.team ||
        Math.hypot(player.x - before.x, player.y - before.y) >
          Math.max(80, 400 * seconds + 40)
      );
    })
  )
    return true;
  return (
    Math.hypot(b.ball.x - a.ball.x, b.ball.y - a.ball.y) >
    Math.max(180, 1000 * seconds + 70)
  );
}

function blend(a: Disc, b: Disc, amount: number): Disc {
  return {
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
    vx: a.vx + (b.vx - a.vx) * amount,
    vy: a.vy + (b.vy - a.vy) * amount,
  };
}

/** Visual snapshots only. Never use the sampled frame to report results or simulate physics. */
export class SnapshotInterpolator {
  private snapshots: Snapshot[] = [];
  private retiredMatches = new Set<string>();
  private readonly delayMs: number;
  private readonly maxExtrapolationMs: number;

  constructor(options: Options = {}) {
    this.delayMs = Number.isFinite(options.delayMs)
      ? clamp(options.delayMs!, 0, 200)
      : 75;
    this.maxExtrapolationMs = Number.isFinite(options.maxExtrapolationMs)
      ? clamp(options.maxExtrapolationMs!, 0, 100)
      : 80;
  }

  reset(): void {
    this.snapshots = [];
    this.retiredMatches.clear();
  }

  /** Arrival timestamps use performance.now(), independently of packet sequence gaps. */
  enqueue(frame: GameFrame, receivedAtMs: number): boolean {
    if (!validFrame(frame) || !Number.isFinite(receivedAtMs)) return false;
    const previous = this.snapshots.at(-1);
    if (previous) {
      if (frame.match_id === previous.frame.match_id) {
        // RTC and WS can deliver the same packet; the slower route must not
        // shift its timestamp or rewind a newer packet already on screen.
        if (frame.seq <= previous.frame.seq) return false;
      } else {
        if (this.retiredMatches.has(frame.match_id)) return false;
        this.retiredMatches.add(previous.frame.match_id);
        if (this.retiredMatches.size > 4)
          this.retiredMatches.delete(
            this.retiredMatches.values().next().value!,
          );
      }
    }
    const snapshot = {
      frame: copy(frame),
      at: previous ? Math.max(receivedAtMs, previous.at + 0.01) : receivedAtMs,
    };
    if (previous && discontinuity(previous, snapshot)) this.snapshots = [];
    this.snapshots.push(snapshot);
    // Twelve 20 Hz packets are ample for a short interpolation delay. Do not
    // retain a whole match, even when render sampling pauses in a hidden tab.
    if (this.snapshots.length > 12) this.snapshots.shift();
    return true;
  }

  /** Pass false for paused/lobby states: a retained velocity must not move a paused game. */
  sample(nowMs: number, playing = true): GameFrame | null {
    const latest = this.snapshots.at(-1);
    if (!latest) return null;
    const result = copy(latest.frame);
    if (
      !playing ||
      result.finished ||
      result.kickoff > 0 ||
      !Number.isFinite(nowMs)
    )
      return result;
    const at = nowMs - this.delayMs;
    const first = this.snapshots[0];
    if (at <= first.at) {
      result.ball = { ...first.frame.ball };
      const players = new Map(
        first.frame.players.map((player) => [player.id, player]),
      );
      result.players = result.players.map((player) => ({
        ...player,
        ...blend(players.get(player.id)!, players.get(player.id)!, 0),
      }));
      return result;
    }
    for (let index = 1; index < this.snapshots.length; index++) {
      const next = this.snapshots[index];
      if (at > next.at) continue;
      const before = this.snapshots[index - 1];
      const amount = clamp((at - before.at) / (next.at - before.at), 0, 1);
      const a = new Map(
        before.frame.players.map((player) => [player.id, player]),
      );
      const b = new Map(
        next.frame.players.map((player) => [player.id, player]),
      );
      result.players = result.players.map((player) => ({
        ...player,
        ...blend(a.get(player.id)!, b.get(player.id)!, amount),
      }));
      result.ball = blend(before.frame.ball, next.frame.ball, amount);
      return result;
    }
    const seconds = clamp(at - latest.at, 0, this.maxExtrapolationMs) / 1000;
    result.players = result.players.map((player): GamePlayer => ({
      ...player,
      x: clamp(
        player.x + player.vx * seconds,
        FIELD.left + FIELD.playerRadius,
        FIELD.right - FIELD.playerRadius,
      ),
      y: clamp(
        player.y + player.vy * seconds,
        FIELD.top + FIELD.playerRadius,
        FIELD.bottom - FIELD.playerRadius,
      ),
    }));
    result.ball.x = clamp(
      result.ball.x + result.ball.vx * seconds,
      FIELD.left - FIELD.goalDepth + FIELD.ballRadius,
      FIELD.right + FIELD.goalDepth - FIELD.ballRadius,
    );
    result.ball.y = clamp(
      result.ball.y + result.ball.vy * seconds,
      FIELD.top + FIELD.ballRadius,
      FIELD.bottom - FIELD.ballRadius,
    );
    return result;
  }
}
