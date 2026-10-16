import type { GameFrame, Input, Member } from "./engine";
import type { Room } from "./types";

/** Original rooms also support solo practice and a host watching the field. */
export function teamsReady(members: Member[]): boolean {
  return members.some((member) => member.connected);
}

export function frameMatchesRoom(frame: GameFrame, room: Room): boolean {
  return (
    (frame.map_id || "classic") === (room.map_id || "classic") &&
    frame.width === (room.map_width ?? 10) * 80 &&
    frame.height === (room.map_height ?? 5) * 80
  );
}

/** Immediate key edges, bounded pointer traffic, and refreshes before the input TTL. */
export class InputDelivery {
  private at = -Infinity;
  private last: Input | null = null;

  publish(
    input: Input,
    now: number,
    send: (input: Input) => boolean,
    immediate = false,
  ) {
    const same =
      this.last &&
      this.last.x === input.x &&
      this.last.y === input.y &&
      this.last.kick === input.kick &&
      this.last.kick_seq === input.kick_seq;
    if (
      !Number.isFinite(now) ||
      (same && now - this.at < 150) ||
      (!immediate && now - this.at < 1000 / 30)
    )
      return;
    if (send(input)) {
      this.at = now;
      this.last = { ...input };
    }
  }
}

/** Keep room passwords and session credentials out of invitations. */
export function roomInvitationUrl(
  publicBaseUrl: string | undefined,
  browserOrigin: string,
  roomId: string,
): string {
  if (!/^[a-f0-9]{32}$/.test(roomId)) return "";
  for (const base of [publicBaseUrl, browserOrigin]) {
    if (!base) continue;
    try {
      const origin = new URL(base);
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        !["", "/"].includes(origin.pathname) ||
        origin.search ||
        origin.hash
      )
        continue;
      return new URL(`/qball/room/${roomId}`, origin.origin).href;
    } catch {
      // A missing or invalid optional address can use this page's own origin.
    }
  }
  return "";
}

type Result = {
  type: "result";
  match_id: string;
  red: number;
  blue: number;
  duration_seconds: number;
};

/** Retry a terminal result until the server publishes the finished room. */
export class MatchResultDelivery {
  private match = "";
  private sentAt = -Infinity;

  report(
    room: Pick<Room, "status" | "match_id">,
    frame: GameFrame,
    now: number,
    send: (result: Result) => boolean,
  ): void {
    if (
      room.status !== "playing" ||
      !room.match_id ||
      room.match_id !== frame.match_id ||
      !frame.finished
    )
      return;
    if (this.match !== room.match_id) {
      this.match = room.match_id;
      this.sentAt = -Infinity;
    }
    if (now - this.sentAt < 2000) return;
    if (
      send({
        type: "result",
        match_id: room.match_id,
        red: frame.score.red,
        blue: frame.score.blue,
        duration_seconds: Math.round(frame.elapsed),
      })
    )
      this.sentAt = now;
  }
}
