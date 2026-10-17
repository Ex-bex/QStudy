import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ECOSYSTEM_BRANDING,
  normalizeEcosystemBranding,
} from "./ecosystem-branding.ts";

const digest = "a".repeat(64);
test("ecosystem logos accept only the independently addressed identity and control assets", () => {
  const value = normalizeEcosystemBranding({
    identity_logo_url: `/api/branding/assets/qid/${digest}.png`,
    control_logo_url: `/api/branding/assets/qcontrol/${digest}.png`,
  });
  assert.equal(value.identity_logo_custom, true);
  assert.equal(value.control_logo_custom, true);
  assert.equal(
    value.identity_logo_url,
    `/api/branding/assets/qid/${digest}.png`,
  );
  assert.deepEqual(
    normalizeEcosystemBranding({
      identity_logo_url: value.control_logo_url,
      control_logo_url: value.identity_logo_url,
    }),
    DEFAULT_ECOSYSTEM_BRANDING,
  );
});
test("untrusted logo URLs cannot escape the same-origin branding assets", () => {
  for (const url of [
    "https://evil.example/logo.png",
    "//evil.example/logo.png",
    "javascript:alert(1)",
    `/api/branding/assets/qid/${digest}.png?extra=1`,
    "/api/branding/assets/qid/../../secret.png",
    "data:image/svg+xml,<svg/>",
  ])
    assert.deepEqual(
      normalizeEcosystemBranding({
        identity_logo_url: url,
        control_logo_url: url,
      }),
      DEFAULT_ECOSYSTEM_BRANDING,
    );
  assert.deepEqual(
    normalizeEcosystemBranding(null),
    DEFAULT_ECOSYSTEM_BRANDING,
  );
});
