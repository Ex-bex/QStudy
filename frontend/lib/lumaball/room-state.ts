import type { GameFrame, Member } from "./engine";
import type { Room } from "./types";

/** Reserved seats are not yet players: both teams must actually be connected. */
export function teamsReady(members: Member[]): boolean {
  return ["red", "blue"].every((team) =>
    members.some((member) => member.connected && member.team === team),
  );
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
