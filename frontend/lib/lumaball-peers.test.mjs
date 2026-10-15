import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import ts from "typescript";
import { FootballEngine } from "./lumaball/engine.ts";

// Test the production TypeScript client in Node without a browser, generated
// files or an extra test framework. Only RTC networking is replaced by a fixture.
const engineUrl = new URL("./lumaball/engine.ts", import.meta.url).href;
const source = readFileSync(
  new URL("./lumaball/peers.ts", import.meta.url),
  "utf8",
);
const compiled = ts
  .transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  })
  .outputText.replace('from "./engine"', `from "${engineUrl}"`);
const { GamePeers } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);

class Channel {
  constructor(label) {
    this.label = label;
    this.readyState = "open";
    this.bufferedAmount = 0;
    this.sent = [];
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
  send(value) {
    this.sent.push(JSON.parse(value));
  }
  receive(value) {
    this.onmessage?.({
      data: typeof value === "string" ? value : JSON.stringify(value),
    });
  }
}
class Peer {
  static all = [];
  constructor() {
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = "new";
    this.candidates = [];
    Peer.all.push(this);
  }
  createDataChannel(label) {
    this.channel = new Channel(label);
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "fixture-offer" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "fixture-answer" };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
    // Chrome may gather an ICE candidate before this promise resolves.
    this.onicecandidate?.({
      candidate: {
        toJSON: () => ({
          candidate: "fixture-ice",
          sdpMid: "0",
          sdpMLineIndex: 0,
        }),
      },
    });
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }
  async addIceCandidate(value) {
    this.candidates.push(value);
  }
  close() {
    this.connectionState = "closed";
  }
}
const room = () => ({
  id: "room",
  host_id: "host",
  match_id: "current-match",
  status: "playing",
  members: [
    { id: "host", name: "Actual Host", team: "red", connected: true },
    { id: "peer", name: "Actual Peer", team: "blue", connected: true },
  ],
});

test("RTC sends the SDP before ICE and binds input to the channel's real member", async () => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = Peer;
  Peer.all = [];
  const signals = [],
    inputs = [];
  const game = new GamePeers("host", [], {
    signal: (target, payload) => signals.push({ target, payload }),
    input: (from, input) => inputs.push({ from, input }),
    frame: () => {},
    state: () => {},
  });
  try {
    game.sync(room());
    await delay(0);
    assert.equal(Peer.all.length, 1);
    assert.equal(signals[0].payload.description.type, "offer");
    assert.ok(signals[1].payload.candidate);
    const channel = Peer.all[0].channel;
    channel.receive({
      type: "input",
      from: "host",
      input: { x: 1000, y: 0, kick: true },
    });
    assert.deepEqual(inputs, [
      { from: "peer", input: { x: 1, y: 0, kick: true } },
    ]);
    channel.receive("{");
    channel.receive({
      type: "frame",
      frame: new FootballEngine(room().members).frame(),
    });
    assert.equal(inputs.length, 1);
    game.sync({ ...room(), members: [room().members[0]] });
    assert.equal(
      channel.readyState,
      "closed",
      "removed players cannot keep a direct channel",
    );
  } finally {
    game.close();
    globalThis.RTCPeerConnection = previous;
  }
});

test("clients accept frames only from the current host and current match with server names", async () => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = Peer;
  Peer.all = [];
  const frames = [],
    signals = [];
  const game = new GamePeers("peer", [], {
    signal: (target, payload) => signals.push({ target, payload }),
    input: () => {},
    frame: (frame) => frames.push(frame),
    state: () => {},
  });
  try {
    game.sync(room());
    await game.signal("outsider", {
      description: { type: "offer", sdp: "private" },
    });
    assert.equal(
      Peer.all.length,
      0,
      "an unknown room member cannot open a channel",
    );
    await game.signal("host", {
      description: { type: "offer", sdp: "fixture" },
    });
    assert.equal(signals[0].payload.description.type, "answer");
    const peer = Peer.all[0],
      channel = new Channel("lumaball-game");
    peer.ondatachannel({ channel });
    const frame = new FootballEngine(room().members).frame();
    frame.match_id = "old-match";
    channel.receive({ type: "frame", frame });
    assert.equal(
      frames.length,
      0,
      "late unordered packets from a finished match are dropped",
    );
    frame.match_id = "current-match";
    frame.players[0].name = "Impersonated administrator";
    channel.receive({ type: "frame", frame });
    assert.equal(frames[0].players[0].name, "Actual Host");
    frame.players[0].id = "outsider";
    channel.receive({ type: "frame", frame });
    assert.equal(
      frames.length,
      1,
      "forged roster entries never reach the renderer",
    );
    channel.bufferedAmount = 100000;
    game.input({ x: 1, y: 0, kick: false });
    assert.equal(
      channel.sent.length,
      0,
      "an overloaded direct channel does not buffer an unbounded queue",
    );
  } finally {
    game.close();
    globalThis.RTCPeerConnection = previous;
  }
});
