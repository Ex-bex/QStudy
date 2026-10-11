import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BRANDING,
  DEFAULT_PROJECT_LOGO,
  departmentLogoUrl,
  normalizeBranding,
  safeBrandingAsset,
} from "./branding.ts";

const hash = "a".repeat(64);
const project = `/api/branding/assets/project/${hash}.png`;
const department = {
  id: 7,
  logo: "coding",
  logo_url: `/api/branding/assets/department-7/${hash}.png`,
};

test("uploaded logos only accept exact local PNG assets for the matching owner", () => {
  assert.equal(safeBrandingAsset(project, "project"), true);
  assert.equal(safeBrandingAsset(department.logo_url, "department-7"), true);
  for (const path of [
    `https://external.example${project}`,
    `//external.example${project}`,
    `${project}?key=secret`,
    `${project}#fragment`,
    `${project}\n`,
    `/api/branding/assets/project/${hash}.svg`,
    `/api/branding/assets/project/${hash.slice(1)}.png`,
    `/api/branding/assets/department-7/${hash}.png`,
    `/api/branding/assets/project/../${hash}.png`,
    `/api/branding/assets/project/${hash.toUpperCase()}.png`,
    null,
  ])
    assert.equal(safeBrandingAsset(path, "project"), false, String(path));
  for (const key of [
    "project\n",
    "department-0",
    "../project",
    "project|department-7",
  ])
    assert.equal(safeBrandingAsset(project, key), false);
});

test("invalid project metadata safely falls back to the bundled transparent PNG", () => {
  assert.deepEqual(normalizeBranding({ project_logo_url: project }), {
    project_logo_url: project,
    project_logo_custom: true,
  });
  for (const value of [
    null,
    {},
    { project_logo_url: "javascript:alert(1)" },
    {
      project_logo_url: "https://external.example/logo.png",
      project_logo_custom: true,
    },
  ])
    assert.deepEqual(normalizeBranding(value), DEFAULT_BRANDING);
});

test("department PNGs cannot reuse another department asset and QForce fallback follows project", () => {
  assert.equal(departmentLogoUrl(department, project), department.logo_url);
  assert.equal(
    departmentLogoUrl({ ...department, id: 8 }, project),
    "/brand/qforce_logo_coding.jpeg",
  );
  assert.equal(
    departmentLogoUrl({ ...department, logo: "main", logo_url: "" }, project),
    project,
  );
  assert.equal(
    departmentLogoUrl(
      { ...department, logo: "main", logo_url: "" },
      "https://external.example/logo.png",
    ),
    DEFAULT_PROJECT_LOGO,
  );
  assert.equal(
    departmentLogoUrl({ ...department, logo: "__proto__", logo_url: "" }),
    DEFAULT_PROJECT_LOGO,
  );
});
