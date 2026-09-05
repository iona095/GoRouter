/**
 * R3-006 contract: the README must not promise that `account test` is
 * non-billing. The Go leg performs a real completion that may consume
 * Go usage/quota; only the Zen leg uses the designated free probe model.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

describe("R3-006 probe cost wording", () => {
  test("README never calls the account probe non-billing", () => {
    const readme = readFileSync(join(resolve(import.meta.dir, ".."), "README.md"), "utf8");
    for (const line of readme.split("\n")) {
      if (/account test/i.test(line)) expect(line).not.toMatch(/non-billing/i);
    }
    expect(readme).toMatch(/may consume Go usage\/quota/);
  });
});
