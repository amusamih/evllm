import { describe, expect, it, vi } from "vitest";

import { assertSourceCommitReachableFromPublicRef } from "../../scripts/lib/evaluation-source.js";

describe("public evaluation source reachability", () => {
  it("accepts a source commit reachable from the configured remote-tracking branch", () => {
    const check = vi.fn(() => true);
    expect(() =>
      assertSourceCommitReachableFromPublicRef("a".repeat(40), "origin/main", check),
    ).not.toThrow();
    expect(check).toHaveBeenCalledWith("a".repeat(40), "origin/main");
  });

  it("rejects an unpublished source commit without contacting the network", () => {
    expect(() =>
      assertSourceCommitReachableFromPublicRef("a".repeat(40), "origin/main", () => false),
    ).toThrow("publish the exact source commit");
  });

  it("rejects malformed commit and remote-tracking references", () => {
    expect(() =>
      assertSourceCommitReachableFromPublicRef("HEAD", "origin/main", () => true),
    ).toThrow("full Git commit hash");
    expect(() =>
      assertSourceCommitReachableFromPublicRef("a".repeat(40), "main", () => true),
    ).toThrow("remote-tracking reference is invalid");
  });
});
