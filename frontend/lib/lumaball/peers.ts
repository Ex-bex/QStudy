import {
  normalizeInput,
  validFrame,
  type GameFrame,
  type Input,
} from "./engine";
import type { Room } from "./types";

type Signal = {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};
type Peer = {
  connection: RTCPeerConnection;
  channel?: RTCDataChannel;
  pending: RTCIceCandidateInit[];
  localPending: RTCIceCandidateInit[];
  descriptionSent: boolean;
  ready: boolean;
};

/** The signaling server binds every sender to a room member. Channel callbacks do the same. */
export class GamePeers {
  private peers = new Map<string, Peer>();
  private room: Room | null = null;
  constructor(
    private ownId: string,
    private iceServers: RTCIceServer[],
    private callbacks: {
      signal: (target: string, payload: Signal) => void;
      input: (from: string, input: Input) => void;
      frame: (frame: GameFrame) => void;
      state: () => void;
    },
  ) {}

  sync(room: Room) {
    if (this.room?.host_id && this.room.host_id !== room.host_id) this.close();
    this.room = room;
    const wanted =
      room.host_id === this.ownId
        ? room.members
            .filter((m) => m.connected && m.id !== this.ownId)
            .map((m) => m.id)
        : room.members.some((m) => m.id === room.host_id && m.connected)
          ? [room.host_id]
          : [];
    for (const id of this.peers.keys())
      if (!wanted.includes(id)) this.remove(id);
    if (room.host_id === this.ownId)
      for (const id of wanted) if (!this.peers.has(id)) void this.offer(id);
  }
  private create(id: string): Peer | null {
    if (typeof RTCPeerConnection === "undefined") return null;
    try {
      const peer: Peer = {
        connection: new RTCPeerConnection({ iceServers: this.iceServers }),
        pending: [],
        localPending: [],
        descriptionSent: false,
        ready: false,
      };
      this.peers.set(id, peer);
      peer.connection.onicecandidate = (event) => {
        if (event.candidate) {
          if (peer.descriptionSent)
            this.callbacks.signal(id, { candidate: event.candidate.toJSON() });
          else if (peer.localPending.length < 64)
            peer.localPending.push(event.candidate.toJSON());
        }
      };
      peer.connection.onconnectionstatechange = () => {
        peer.ready =
          peer.connection.connectionState === "connected" &&
          peer.channel?.readyState === "open";
        this.callbacks.state();
      };
      peer.connection.ondatachannel = (event) =>
        this.attach(id, peer, event.channel);
      return peer;
    } catch {
      return null;
    }
  }
  private description(id: string, peer: Peer) {
    this.callbacks.signal(id, {
      description: peer.connection.localDescription!,
    });
    peer.descriptionSent = true;
    for (const candidate of peer.localPending.splice(0))
      this.callbacks.signal(id, { candidate });
  }
  private attach(id: string, peer: Peer, channel: RTCDataChannel) {
    if (channel.label !== "lumaball-game" || peer.channel) {
      channel.close();
      return;
    }
    peer.channel = channel;
    channel.onopen = () => {
      peer.ready = true;
      this.callbacks.state();
    };
    channel.onclose = () => {
      peer.ready = false;
      this.callbacks.state();
    };
    channel.onerror = () => {
      peer.ready = false;
      this.callbacks.state();
    };
    channel.onmessage = (event) => {
      if (
        typeof event.data !== "string" ||
        event.data.length > 24 * 1024 ||
        !this.room
      )
        return;
      try {
        const data = JSON.parse(event.data);
        if (this.room.host_id === this.ownId && data.type === "input")
          this.callbacks.input(id, normalizeInput(data.input));
        else if (
          id === this.room.host_id &&
          data.type === "frame" &&
          validFrame(data.frame) &&
          data.frame.match_id === this.room.match_id
        ) {
          const frame = data.frame as GameFrame;
          if (
            frame.players.some(
              (p) =>
                !this.room!.members.some(
                  (m) => m.id === p.id && m.team === p.team,
                ),
            )
          )
            return;
          this.callbacks.frame({
            ...frame,
            players: frame.players.map((p) => ({
              ...p,
              name: this.room!.members.find((m) => m.id === p.id)!.name,
            })),
          });
        }
      } catch {
        /* Drop malformed peer packets; relay remains usable. */
      }
    };
  }
  private async offer(id: string) {
    const peer = this.create(id);
    if (!peer) return;
    try {
      this.attach(
        id,
        peer,
        peer.connection.createDataChannel("lumaball-game", {
          ordered: false,
          maxRetransmits: 0,
        }),
      );
      await peer.connection.setLocalDescription(
        await peer.connection.createOffer(),
      );
      if (this.peers.get(id) === peer) this.description(id, peer);
    } catch {
      this.remove(id);
    }
  }
  async signal(from: string, payload: Signal) {
    const room = this.room;
    if (
      !room ||
      from === this.ownId ||
      !room.members.some((m) => m.id === from && m.connected)
    )
      return;
    if (room.host_id !== this.ownId && from !== room.host_id) return;
    let peer = this.peers.get(from);
    if (!peer && payload.description?.type === "offer" && room.host_id === from)
      peer = this.create(from) || undefined;
    if (!peer) return;
    try {
      if (payload.description) {
        if (
          (room.host_id === this.ownId &&
            payload.description.type !== "answer") ||
          (room.host_id !== this.ownId && payload.description.type !== "offer")
        )
          return;
        await peer.connection.setRemoteDescription(payload.description);
        for (const candidate of peer.pending.splice(0))
          await peer.connection.addIceCandidate(candidate);
        if (payload.description.type === "offer") {
          await peer.connection.setLocalDescription(
            await peer.connection.createAnswer(),
          );
          this.description(from, peer);
        }
      }
      if (payload.candidate) {
        if (peer.connection.remoteDescription)
          await peer.connection.addIceCandidate(payload.candidate);
        else if (peer.pending.length < 64) peer.pending.push(payload.candidate);
      }
    } catch {
      this.remove(from);
    }
  }
  private send(peer: Peer, value: unknown) {
    if (
      peer.channel?.readyState !== "open" ||
      peer.channel.bufferedAmount > 48 * 1024
    )
      return;
    try {
      peer.channel.send(JSON.stringify(value));
    } catch {
      peer.ready = false;
    }
  }
  frame(frame: GameFrame) {
    for (const peer of this.peers.values())
      this.send(peer, { type: "frame", frame });
  }
  input(input: Input) {
    const peer = this.room && this.peers.get(this.room.host_id);
    if (peer) this.send(peer, { type: "input", input });
  }
  connected() {
    return [...this.peers.values()].filter((p) => p.ready).length;
  }
  private remove(id: string) {
    const peer = this.peers.get(id);
    this.peers.delete(id);
    if (peer) {
      peer.connection.onconnectionstatechange = null;
      peer.channel?.close();
      peer.connection.close();
    }
    this.callbacks.state();
  }
  close() {
    for (const id of this.peers.keys()) this.remove(id);
  }
}
