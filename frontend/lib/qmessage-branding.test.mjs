import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_QMESSAGE_BRANDING,
  normalizeQMessageBranding,
} from "./qmessage-branding.ts";

test("QMessage accepts only its own same-origin immutable PNG", () => {
  const url = `/api/branding/assets/qmessage/${"a".repeat(64)}.png`;
  assert.deepEqual(
    normalizeQMessageBranding({ logo_url: url, logo_custom: false }),
    { logo_url: url, logo_custom: true },
  );
  for (const value of [
    null,
    {},
    { logo_url: url + "?x=1" },
    { logo_url: url.replace("qmessage/", "qforce/") },
    { logo_url: "https://example.test/logo.png" },
    { logo_url: "//example.test/logo.png" },
    { logo_url: "/api/branding/assets/qmessage/../qforce/logo.png" },
  ]) {
    assert.deepEqual(
      normalizeQMessageBranding(value),
      DEFAULT_QMESSAGE_BRANDING,
    );
  }
});
