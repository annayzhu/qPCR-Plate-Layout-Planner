import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPlannerDraft,
  loadPlannerDraft,
  savePlannerDraft,
  type PlannerDraftStorage,
} from "../lib/plannerDraftStorage";
import {
  createPlannerSession,
  dispatchPlannerSession,
} from "../lib/plannerSession";

function createMemoryStorage(): PlannerDraftStorage & {
  entries: Map<string, string>;
} {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

test("browser draft adapter owns save, restore, and clear", () => {
  const storage = createMemoryStorage();
  const session = dispatchPlannerSession(createPlannerSession(), {
    type: "set-language",
    language: "en",
  }).session;

  assert.equal(loadPlannerDraft(storage), null);
  savePlannerDraft(storage, session);
  assert.equal(loadPlannerDraft(storage)?.session.language, "en");

  clearPlannerDraft(storage);
  assert.equal(loadPlannerDraft(storage), null);
});

test("browser draft adapter delegates legacy migration to Planner Session", () => {
  const storage = createMemoryStorage();
  storage.setItem(
    "qpcr-plate-planner:v1",
    JSON.stringify({
      version: 1,
      plateType: 96,
      samples: ["S1"],
      genes: [{ id: "gene-1", name: "R1", role: "reference" }],
      replicates: 3,
    }),
  );

  const restored = loadPlannerDraft(storage, {
    createId: (prefix, index) => `${prefix}-${index + 1}`,
  });
  assert.equal(restored?.migratedFrom, 1);
  assert.equal(restored?.session.setup.samples[0]?.name, "S1");
});
