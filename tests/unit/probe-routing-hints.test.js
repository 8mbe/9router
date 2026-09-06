import { describe, it, expect } from "vitest";
import {
  partitionByProbe,
  orderConnectionsByProbe,
  isDurableModelFailure,
  DEFAULT_STALE_AFTER_MS,
} from "@/lib/modelProbe/routingHints.js";

const conns = [
  { id: "c1", name: "key-1" },
  { id: "c2", name: "key-2" },
  { id: "c3", name: "key-3" },
];

const now = Date.now();
function hints(entries) {
  return new Map(entries.map(([connectionId, ok, testedAt = now]) => [
    `${connectionId}::gpt-4o`,
    { ok, testedAt },
  ]));
}

describe("partitionByProbe", () => {
  it("splits by verdict for the requested model", () => {
    const { working, unknown, broken } = partitionByProbe(
      conns, "gpt-4o", hints([["c1", true], ["c2", false]])
    );
    expect(working.map((c) => c.id)).toEqual(["c1"]);
    expect(broken.map((c) => c.id)).toEqual(["c2"]);
    expect(unknown.map((c) => c.id)).toEqual(["c3"]); // never probed
  });

  it("treats an old failure as unknown so a key is not stranded forever", () => {
    const stale = now - DEFAULT_STALE_AFTER_MS - 1000;
    const { unknown, broken } = partitionByProbe(conns, "gpt-4o", hints([["c2", false, stale]]));
    expect(broken).toHaveLength(0);
    expect(unknown.map((c) => c.id)).toContain("c2");
  });

  it("keeps a passing verdict regardless of age", () => {
    const ancient = now - DEFAULT_STALE_AFTER_MS * 10;
    const { working } = partitionByProbe(conns, "gpt-4o", hints([["c1", true, ancient]]));
    expect(working.map((c) => c.id)).toEqual(["c1"]);
  });

  it("ignores verdicts recorded for a different model", () => {
    const other = new Map([["c1::claude-opus-5", { ok: false, testedAt: now }]]);
    const { unknown, broken } = partitionByProbe(conns, "gpt-4o", other);
    expect(broken).toHaveLength(0);
    expect(unknown).toHaveLength(3);
  });

  it("has no opinion without a model or without hints", () => {
    expect(partitionByProbe(conns, null, hints([["c1", true]])).unknown).toHaveLength(3);
    expect(partitionByProbe(conns, "gpt-4o", new Map()).unknown).toHaveLength(3);
  });
});

describe("orderConnectionsByProbe", () => {
  it("drops recently-failing keys from the pool and leads with working ones", () => {
    const { pool, demoted } = orderConnectionsByProbe(
      conns, "gpt-4o", hints([["c1", false], ["c3", true]])
    );
    expect(pool.map((c) => c.id)).toEqual(["c3", "c2"]); // working first, then untested
    expect(pool.map((c) => c.id)).not.toContain("c1");
    expect(demoted).toBe(1);
  });

  it("keeps untested keys in the pool rather than collapsing onto the one probed key", () => {
    // Only c1 is known good; c2/c3 must stay eligible or rotation dies.
    const { pool } = orderConnectionsByProbe(conns, "gpt-4o", hints([["c1", true]]));
    expect(pool.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("falls back to the failing keys rather than leaving nothing to try", () => {
    const all = hints([["c1", false], ["c2", false], ["c3", false]]);
    const { pool, demoted } = orderConnectionsByProbe(conns, "gpt-4o", all);
    expect(pool.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(demoted).toBe(0);
  });

  it("preserves the caller's ordering within each tier", () => {
    // c2 and c3 are both untested; their relative priority order must survive.
    const { pool } = orderConnectionsByProbe(conns, "gpt-4o", hints([["c1", false]]));
    expect(pool.map((c) => c.id)).toEqual(["c2", "c3"]);
  });
});

describe("isDurableModelFailure", () => {
  it("records auth/availability rejections", () => {
    expect(isDurableModelFailure(401, "unauthorized")).toBe(true);
    expect(isDurableModelFailure(403, "forbidden")).toBe(true);
    expect(isDurableModelFailure(404, "not found")).toBe(true);
  });

  it("ignores transient failures already covered by cooldowns", () => {
    // A rate-limited or briefly-broken key is not a key that cannot serve the model.
    expect(isDurableModelFailure(429, "rate limit exceeded")).toBe(false);
    expect(isDurableModelFailure(500, "internal error")).toBe(false);
    expect(isDurableModelFailure(502, "bad gateway")).toBe(false);
    expect(isDurableModelFailure(503, "overloaded")).toBe(false);
    expect(isDurableModelFailure(null, "socket hang up")).toBe(false);
  });

  it("only accepts a 400 when the message is about the model", () => {
    expect(isDurableModelFailure(400, "The model `foo` does not exist")).toBe(true);
    expect(isDurableModelFailure(400, "model not found")).toBe(true);
    expect(isDurableModelFailure(400, "unsupported model")).toBe(true);
    // A malformed user request must not poison the key for this model.
    expect(isDurableModelFailure(400, "messages: invalid role")).toBe(false);
    expect(isDurableModelFailure(400, "")).toBe(false);
    expect(isDurableModelFailure(400, null)).toBe(false);
  });
});
