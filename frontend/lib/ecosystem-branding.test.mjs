import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ECOSYSTEM_BRANDING,
  FORCE_LOGO,
  normalizeEcosystemBranding,
} from "./ecosystem-branding.ts";
import { DEFAULT_BRANDING, normalizeBranding } from "./branding.ts";

const digest = "a".repeat(64);
test("ecosystem logos accept only their independently addressed force, identity and control assets", () => {
  const value = normalizeEcosystemBranding({
    force_logo_url: `/api/branding/assets/qforce/${digest}.png`,
    identity_logo_url: `/api/branding/assets/qid/${digest}.png`,
    control_logo_url: `/api/branding/assets/qcontrol/${digest}.png`,
  });
  assert.equal(value.force_logo_custom, true);
  assert.equal(
    value.force_logo_url,
    `/api/branding/assets/qforce/${digest}.png`,
  );
  assert.equal(value.identity_logo_custom, true);
  assert.equal(value.control_logo_custom, true);
  assert.equal(
    value.identity_logo_url,
    `/api/branding/assets/qid/${digest}.png`,
  );
  assert.deepEqual(
    normalizeEcosystemBranding({
      force_logo_url: value.identity_logo_url,
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
        force_logo_url: url,
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
test("legacy ecosystem responses retain the force default without changing identity or control", () => {
  const value = normalizeEcosystemBranding({
    identity_logo_url: `/api/branding/assets/qid/${digest}.png`,
    control_logo_url: `/api/branding/assets/qcontrol/${digest}.png`,
  });
  assert.equal(value.force_logo_url, FORCE_LOGO);
  assert.equal(value.force_logo_custom, false);
  assert.equal(value.identity_logo_custom, true);
  assert.equal(value.control_logo_custom, true);
});

test("changing QForce does not change the independent QStudy, identity or control logos", () => {
  const force = `/api/branding/assets/qforce/${digest}.png`;
  assert.deepEqual(normalizeEcosystemBranding({ force_logo_url: force }), {
    ...DEFAULT_ECOSYSTEM_BRANDING,
    force_logo_url: force,
    force_logo_custom: true,
  });
  assert.deepEqual(
    normalizeBranding({ project_logo_url: force }),
    DEFAULT_BRANDING,
  );
  assert.deepEqual(
    normalizeEcosystemBranding({
      force_logo_url: `/api/branding/assets/project/${digest}.png`,
    }),
    DEFAULT_ECOSYSTEM_BRANDING,
  );
});

test("force asset paths reject other namespaces, query strings, traversal and false custom flags", () => {
  for (const value of [
    `/api/branding/assets/qforce/${digest}.png?x=1`,
    `/api/branding/assets/qforce/${digest}.png#fragment`,
    `/api/branding/assets/qforce/${digest}.png\n`,
    `/api/branding/assets/qforce/${digest}.jpg`,
    `/api/branding/assets/qforce/../project/${digest}.png`,
    `/api/branding/assets/qforce/${"A".repeat(64)}.png`,
    `/api/branding/assets/qforce/${"a".repeat(63)}.png`,
    `/api/branding/assets/qid/${digest}.png`,
    FORCE_LOGO,
    "",
    null,
  ]) {
    assert.deepEqual(
      normalizeEcosystemBranding({
        force_logo_url: value,
        force_logo_custom: true,
      }),
      DEFAULT_ECOSYSTEM_BRANDING,
    );
  }
});
