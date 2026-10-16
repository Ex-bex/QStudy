import type { Member, Team } from "./engine";
import type { MapId } from "./maps";
export type Identity = {
  id: string;
  name: string;
  kind: "guest" | "user";
  is_admin: boolean;
};
export type Room = {
  id: string;
  name: string;
  host_id: string;
  status: "lobby" | "playing" | "paused" | "finished" | "closed";
  max_players: number;
  score_limit: number;
  time_limit: number;
  map_id?: MapId;
  map_width?: number;
  map_height?: number;
  locked: boolean;
  members: Member[];
  score: { red: number; blue: number };
  match_id?: string;
  chat?: ChatMessage[];
};
export type Session = {
  identity: Identity;
  ws_ticket: string;
  config: {
    chat_enabled: boolean;
    enabled: boolean;
    announcement?: string;
    public_base_url?: string;
  };
  ice_servers: RTCIceServer[];
};
export type ChatMessage = {
  id: string | number;
  name: string;
  text: string;
  created_at: string;
};
export type Command = {
  type: "command";
  action: "start" | "pause" | "resume" | "stop" | "reset" | "team" | "kick";
  target?: string;
  team?: Team;
};

export async function gameRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api/lumaball" + path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof value.detail === "string"
        ? value.detail
        : "Не удалось выполнить действие. Повторите попытку.",
    );
  return value;
}
