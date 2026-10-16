import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InputDelivery,
  MatchResultDelivery,
  frameMatchesRoom,
  roomInvitationUrl,
  teamsReady,
} from "./lumaball/room-state.ts";
import { FootballEngine } from "./lumaball/engine.ts";

const roomId = "a".repeat(32);
const roster = [
  { id: "host", name: "Host", team: "red", connected: true },
  { id: "friend", name: "Friend", team: "blue", connected: true },
];

test("input delivery preserves kick edges while bounding pointer traffic and refreshing held movement", () => {
  const delivery = new InputDelivery();
  const sent = [];
  const send = (input) => (sent.push({ ...input }), true);
  const input = { x: 1, y: 0, kick: false, kick_seq: 1 };
  delivery.publish(input, 0, send);
  for (let now = 1; now < 150; now++) delivery.publish(input, now, send);
  assert.equal(
    sent.length,
    1,
    "held keys must not produce duplicate 30 Hz packets",
  );
  delivery.publish(input, 150, send);
  assert.equal(
    sent.length,
    2,
    "held movement is refreshed before the 600 ms expiry",
  );
  delivery.publish({ ...input, kick: true, kick_seq: 2 }, 151, send, true);
  delivery.publish({ ...input, kick_seq: 2 }, 152, send, true);
  assert.deepEqual(
    sent.slice(-2).map((item) => item.kick),
    [true, false],
    "press and release edges cannot wait behind pointer throttling",
  );
  const pointer = new InputDelivery();
  let pointerPackets = 0;
  for (let now = 0; now < 1000; now++)
    pointer.publish(
      { ...input, x: now / 1000 },
      now,
      () => (++pointerPackets, true),
    );
  assert.ok(
    pointerPackets >= 28 && pointerPackets <= 30,
    "high-frequency pointer events stay within the network budget",
  );
});

test("a congested input socket retries without dropping the latest release", () => {
  const delivery = new InputDelivery();
  const input = { x: 0, y: 0, kick: false, kick_seq: 7 };
  let attempts = 0;
  delivery.publish(input, 0, () => (++attempts, false), true);
  delivery.publish(input, 1, () => (++attempts, true), true);
  delivery.publish(input, NaN, () => (++attempts, true), true);
  assert.equal(
    attempts,
    2,
    "failed writes cannot acknowledge the input and invalid clocks cannot send",
  );
});

test("room map changes reject delayed RTC frames from the old pitch", () => {
  const frame = new FootballEngine(roster).frame();
  assert.equal(
    frameMatchesRoom(frame, {}),
    true,
    "pre-map classic rooms remain compatible",
  );
  assert.equal(
    frameMatchesRoom(frame, { map_id: "hockey", map_width: 10, map_height: 5 }),
    false,
  );
  assert.equal(
    frameMatchesRoom(frame, {
      map_id: "classic",
      map_width: 20,
      map_height: 10,
    }),
    false,
  );
  assert.equal(
    frameMatchesRoom(
      { ...frame, map_id: "arena", width: 1120, height: 640 },
      { map_id: "arena", map_width: 14, map_height: 8 },
    ),
    true,
  );
});

test("invitations use the configured public origin instead of the host's localhost", () => {
  assert.equal(
    roomInvitationUrl(
      "http://94.125.99.135:8080",
      "http://127.0.0.1:3000",
      roomId,
    ),
    `http://94.125.99.135:8080/qball/room/${roomId}`,
  );
  assert.equal(
    roomInvitationUrl(undefined, "https://play.example", roomId),
    `https://play.example/qball/room/${roomId}`,
  );
  for (const address of [
    "javascript:alert(1)",
    "https://user:secret@play.example",
    "https://play.example?ticket=secret",
    "https://play.example/nested",
  ])
    assert.equal(
      roomInvitationUrl(address, "http://localhost:3000", roomId),
      `http://localhost:3000/qball/room/${roomId}`,
    );
  assert.equal(
    roomInvitationUrl(undefined, "http://localhost", "../../admin"),
    "",
  );
});

test("original kickoff supports solo practice and a connected spectator host", () => {
  assert.equal(teamsReady(roster), true);
  assert.equal(
    teamsReady([roster[0], { ...roster[1], connected: false }]),
    true,
  );
  assert.equal(
    teamsReady([roster[0], { ...roster[1], team: "spectator" }]),
    true,
  );
  assert.equal(
    teamsReady([{ ...roster[0], is_host: true, team: "spectator" }]),
    true,
  );
  assert.equal(
    teamsReady(roster.map((member) => ({ ...member, connected: false }))),
    false,
  );
  assert.equal(teamsReady([]), false);
});

test("finished results survive congestion, retry before acknowledgement and reset for rematches", () => {
  const delivery = new MatchResultDelivery();
  const room = { status: "playing", match_id: roomId };
  const frame = new FootballEngine(roster).frame();
  Object.assign(frame, {
    match_id: roomId,
    finished: true,
    score: { red: 5, blue: 2 },
    elapsed: 67.4,
    winner: "red",
  });
  const sent = [];
  const send = (packet) => (sent.push(packet), true);
  delivery.report(room, frame, 0, () => false);
  delivery.report(room, frame, 50, send);
  assert.equal(
    sent.length,
    1,
    "a congested socket must not mark the result delivered",
  );
  assert.deepEqual(sent[0], {
    type: "result",
    match_id: roomId,
    red: 5,
    blue: 2,
    duration_seconds: 67,
  });
  delivery.report(room, frame, 1000, send);
  assert.equal(sent.length, 1, "retries cannot flood the server");
  delivery.report(room, frame, 2050, send);
  assert.equal(sent.length, 2, "unacknowledged terminal results are retried");
  delivery.report({ ...room, status: "finished" }, frame, 5000, send);
  assert.equal(
    sent.length,
    2,
    "the published finished room acknowledges the result",
  );
  const rematch = "b".repeat(32);
  delivery.report({ ...room, match_id: rematch }, frame, 5100, send);
  assert.equal(sent.length, 2, "old finished frames cannot end a rematch");
  delivery.report(
    { ...room, match_id: rematch },
    { ...frame, match_id: rematch },
    5101,
    send,
  );
  assert.equal(sent.length, 3, "a new match has its own delivery lifecycle");
});
