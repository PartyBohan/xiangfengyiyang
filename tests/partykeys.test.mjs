import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRgbFrames,
  layerForVelocity,
  nearestSampleIndex,
  parseMidiPacket,
} from "../lib/partykeys.ts";
import { rootPositionVoicing } from "../lib/music.ts";

test("preserves packets, running status, velocity and CC64", () => {
  const events = [];
  parseMidiPacket([
    0x90, 60, 1,
    61, 96,
    0xf8,
    62, 0,
    0xb0, 64, 127,
    0x80, 60, 0,
  ], 12, "partykeys", (event) => events.push(event));

  assert.deepEqual(events.map((event) => [event.type, event.note, event.velocity, event.on]), [
    ["on", 60, 1, undefined],
    ["on", 61, 96, undefined],
    ["off", 62, 0, undefined],
    ["pedal", undefined, undefined, true],
    ["off", 60, 0, undefined],
  ]);
});

test("uses all four Foundation velocity layers at their boundaries", () => {
  assert.deepEqual(
    [1, 45, 46, 78, 79, 106, 107, 127].map((value) => layerForVelocity(value).index),
    [0, 0, 1, 1, 2, 2, 3, 3],
  );
  assert.equal(nearestSampleIndex(62), 5);
});

test("keeps RGB SysEx frames inside the MidiBrowser limit", () => {
  const groups = Array.from({ length: 36 }, (_, key) => ({
    rgb: [(key * 37) % 256, (key * 71) % 256, (key * 109) % 256],
    keys: [key],
  }));
  const frames = buildRgbFrames(groups);
  assert(frames.length > 1);
  assert(frames.every((frame) => frame.length <= 256));
});

test("keeps every teaching chord in root position when changing register", () => {
  const target = [48, 83];
  assert.deepEqual(rootPositionVoicing([48, 52, 55], target, 54), [48, 52, 55]);
  assert.deepEqual(rootPositionVoicing([57, 60, 64], target, 66), [69, 72, 76]);
  assert.deepEqual(rootPositionVoicing([53, 57, 60], target, 66), [65, 69, 72]);
  assert.deepEqual(rootPositionVoicing([55, 59, 62], target, 66), [67, 71, 74]);
  assert.deepEqual(rootPositionVoicing([50, 53, 57], target, 54), [50, 53, 57]);
});
