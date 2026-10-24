import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunOverview } from "../src/shared/run";
import { readOverviewCache, writeOverviewCache } from "../src/shared/overview-cache";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

test("round-trips the last overview", () => {
  const store = memory();
  const overview = { targets: [] } as unknown as RunOverview;
  writeOverviewCache(overview, store);
  assert.deepEqual(readOverviewCache(store), overview);
});

test("missing, corrupt or unavailable storage reads as null without throwing", () => {
  const store = memory();
  assert.equal(readOverviewCache(store), null);
  store.setItem("gitnrun.runOverview", "{not json");
  assert.equal(readOverviewCache(store), null);
  store.setItem("gitnrun.runOverview", '{"x":1}');
  assert.equal(readOverviewCache(store), null);
  assert.equal(readOverviewCache(null), null);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readOverviewCache(broken), null);
  assert.doesNotThrow(() => writeOverviewCache({ targets: [] } as unknown as RunOverview, broken));
});
