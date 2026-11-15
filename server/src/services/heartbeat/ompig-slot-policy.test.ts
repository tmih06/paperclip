import { describe, expect, it } from "vitest";
import { agents } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { parseHeartbeatPolicy, maxConcurrentRunsSql } from "./timer-policy.js";

const agent = (adapterType: string, maxConcurrentRuns = 1) => ({
  adapterType, adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns, maxDailyRuns: 12, maxDailyCostCents: 500 } },
}) as unknown as typeof agents.$inferSelect;

describe("image agent physical capacity", () => {
  it("does not serialize clones by agent identity, but retains budget and daily admission limits", () => {
    expect(parseHeartbeatPolicy(agent("ompig_factory"))).toMatchObject({
      maxConcurrentRuns: 2_147_483_647, maxDailyRuns: 12, maxDailyCostCents: 500,
    });
    expect(parseHeartbeatPolicy(agent("process"))).toMatchObject({ maxConcurrentRuns: 1 });
    expect(parseHeartbeatPolicy(agent("codex_local", 100))).toMatchObject({ maxConcurrentRuns: 50 });
  });

  it("applies the same slot-backed rule in atomic SQL admission", () => {
    const query = new PgDialect().sqlToQuery(maxConcurrentRunsSql());
    expect(query.params).toContain("ompig_factory");
    expect(query.params).toContain(2_147_483_647);
  });
});
