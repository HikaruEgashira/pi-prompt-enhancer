import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOWS = [".github/workflows/test.yml", ".github/workflows/publish.yml"];

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("CI actions target the Node 24 runtime, not the deprecated Node 20", () => {
  for (const path of WORKFLOWS) {
    const workflow = read(path);
    for (const action of ["actions/checkout", "actions/setup-node", "pnpm/action-setup"]) {
      assert.ok(
        !new RegExp(`${action}@v[1-4]\\b`).test(workflow),
        `${path} still pins ${action} to a Node 20 runtime`,
      );
    }
  }
});

test("CI runs on Node 24", () => {
  for (const path of WORKFLOWS) {
    assert.match(read(path), /node-version:\s*24\b/, `${path} should set up Node 24`);
  }
});
