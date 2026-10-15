export type LumaConfig = {
  enabled: boolean;
  title: string;
  description: string;
  announcement: string;
  rules: string;
  logo_url: string | null;
  public_base_url?: string;
  guests_enabled: boolean;
  guest_create_rooms: boolean;
  max_rooms: number;
  max_players: number;
  default_players: number;
  score_limit: number;
  time_limit: number;
  chat_enabled: boolean;
};

export type LumaIdentity = {
  id: string;
  name: string;
  kind: "user" | "guest";
  is_admin: boolean;
  user_id?: number;
};

export type LumaSession = {
  identity: LumaIdentity;
  config: LumaConfig;
  ws_ticket: string;
  ice_servers: RTCIceServer[];
};

export type LumaRoom = {
  id: string;
  name: string;
  host_id: string;
  host_name: string;
  status: "lobby" | "playing" | "paused" | "finished";
  players: number;
  max_players: number;
  locked: boolean;
  score_limit: number;
  time_limit: number;
};

export type LumaPlayer = {
  id: string;
  name: string;
  kind: "user" | "guest";
  user_id?: number | null;
  is_admin?: boolean;
  banned: boolean;
  ban_reason?: string | null;
  created_at?: string;
  updated_at?: string;
  last_seen_at?: string;
};

export type LumaMatch = {
  id: number | string;
  room_name: string;
  red_score: number;
  blue_score: number;
  started_at?: string;
  finished_at?: string;
};

export type LumaList<T> = {
  items: T[];
  total: number;
  offset?: number;
  limit?: number;
};
