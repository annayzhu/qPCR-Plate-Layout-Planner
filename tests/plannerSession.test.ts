import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlannerSession,
  dispatchPlannerSession,
  plannerSessionAudit,
  plannerSessionIsStale,
  plannerSessionReactionCalculation,
  restorePlannerSession,
  serializePlannerSession,
} from "../lib/plannerSession";
import { planPlateLayout } from "../lib/platePlanner";

const samples = [{ id: "sample-1", name: "S1", kind: "sample" as const }];
const genes = [
  { id: "gene-1", name: "G1", role: "target" as const },
  { id: "gene-2", name: "R1", role: "reference" as const },
];

function legacyPlan(plateType: 96 | 384 = 96) {
  return planPlateLayout({
    plateType,
    samples: ["S1"],
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  });
}

test("restores v1 string samples into a Planner Session", () => {
  const plan = legacyPlan();
  const restored = restorePlannerSession(
    JSON.stringify({
      version: 1,
      plateType: 96,
      samples: ["S1"],
      genes,
      replicates: 3,
      layout: plan,
      automaticLayout: plan,
      layoutSignature: "",
      generatedAt: "legacy",
      confirmed: { "1": true },
    }),
    { createId: (prefix, index) => `${prefix}-${index + 1}` },
  );

  assert.equal(restored.ok, true);
  assert.equal(restored.migratedFrom, 1);
  assert.deepEqual(restored.session.setup.samples, [
    {
      ...samples[0],
      cellLine: "",
      comparisonGroup: "",
      isBridge: false,
    },
  ]);
  assert.equal(restored.session.setup.layoutPreset, "sample-major");
  assert.equal(restored.session.setup.loadingPattern, "sequential");
  assert.equal(restored.session.setup.fillDirection, "vertical");
  assert.equal(restored.session.plateEditing?.confirmedPlateNumbers.has(1), true);
});

test("migrates v2 and v3 signatures without creating a false stale plan", () => {
  const plan = legacyPlan();
  const v2Signature = JSON.stringify({
    plateType: 96,
    samples: ["S1"],
    genes: [
      { name: "G1", role: "target" },
      { name: "R1", role: "reference" },
    ],
    replicates: 3,
  });
  const v3Signature = JSON.stringify({
    plateType: 96,
    samples: ["S1"],
    genes: [
      { name: "G1", role: "target" },
      { name: "R1", role: "reference" },
    ],
    replicates: 3,
    layoutPreset: "gene-major",
  });
  for (const [version, signature] of [
    [2, v2Signature],
    [3, v3Signature],
  ] as const) {
    const restored = restorePlannerSession(
      JSON.stringify({
        version,
        plateType: 96,
        samples,
        genes,
        replicates: 3,
        layoutPreset: "gene-major",
        layout: plan,
        automaticLayout: plan,
        layoutSignature: signature,
        generatedAt: "legacy",
        confirmed: {},
        language: "en",
      }),
    );
    assert.equal(restored.ok, true);
    assert.equal(plannerSessionIsStale(restored.session), false);
    assert.equal(restored.session.language, "en");
  }
});

test("restores v4-v6 384-well defaults through one migration policy", () => {
  for (const version of [4, 5, 6]) {
    const plan = legacyPlan(384);
    const restored = restorePlannerSession(
      JSON.stringify({
        version,
        plateType: 384,
        samples,
        genes,
        replicates: 3,
        layoutPreset: "gene-major",
        layout: plan,
        automaticLayout: plan,
        layoutSignature: "",
        generatedAt: "legacy",
        confirmed: {},
        language: "zh",
      }),
    );
    assert.equal(restored.ok, true);
    assert.equal(restored.session.setup.loadingPattern, "interleaved-8-channel");
    assert.equal(restored.session.setup.fillDirection, "vertical");
  }
});

test("current payload round-trips plan, baseline, confirmations, and reaction setup", () => {
  let session = createPlannerSession({
    samples: samples.map((sample) => ({
      ...sample,
      cellLine: "A549",
      comparisonGroup: "FBN2 KD",
      isBridge: true,
    })),
    genes,
  });
  session = dispatchPlannerSession(session, {
    type: "generate-layout",
    generatedAt: "2026-08-23 10:00",
  }).session;
  session = dispatchPlannerSession(session, {
    type: "edit-plate",
    command: { type: "set-confirmed", plateNumber: 1, confirmed: true },
  }).session;

  const serialized = serializePlannerSession(session);
  const restored = restorePlannerSession(serialized);
  assert.equal(restored.ok, true);
  assert.equal(restored.migratedFrom, 9);
  assert.equal(restored.session.setup.samples[0]?.cellLine, "A549");
  assert.equal(restored.session.setup.samples[0]?.isBridge, true);
  assert.equal(restored.session.plateEditing?.confirmedPlateNumbers.has(1), true);
  assert.deepEqual(
    restored.session.plateEditing?.generatedBaseline,
    session.plateEditing?.generatedBaseline,
  );
  assert.deepEqual(restored.session.reactionSystem, session.reactionSystem);
  assert.deepEqual(
    JSON.parse(serializePlannerSession(restored.session)),
    JSON.parse(serialized),
  );
});

test("restores v7 and upgrades it to a stable v9 payload", () => {
  const plan = legacyPlan();
  plan.plates[0].name = "Legacy validation plate";
  const restoredV7 = restorePlannerSession(
    JSON.stringify({
      version: 7,
      plateType: 96,
      samples,
      genes,
      replicates: 3,
      layoutPreset: "gene-major",
      loadingPattern: "sequential",
      fillDirection: "horizontal",
      layout: plan,
      automaticLayout: plan,
      layoutSignature: "legacy-custom-signature",
      generatedAt: "legacy",
      confirmed: { "1": true },
      reactionSystem: { totalUl: 20, masterMixUl: 10 },
      language: "en",
    }),
  );
  assert.equal(restoredV7.ok, true);
  assert.equal(restoredV7.session.setup.fillDirection, "horizontal");
  assert.equal(
    restoredV7.session.plateEditing?.plan.plates[0].name,
    "Legacy validation plate",
  );
  assert.equal(restoredV7.session.plateEditing?.confirmedPlateNumbers.has(1), true);
  assert.equal(restoredV7.session.reactionSystem.totalUl, 20);

  const upgraded = serializePlannerSession(restoredV7.session);
  assert.equal(JSON.parse(upgraded).version, 9);
  const restoredV8 = restorePlannerSession(upgraded);
  assert.deepEqual(
    JSON.parse(serializePlannerSession(restoredV8.session)),
    JSON.parse(upgraded),
  );
});

test("migrates a v8 draft with empty comparison metadata", () => {
  const v8 = {
    version: 8,
    setup: {
      plateType: 96,
      samples,
      genes,
      replicates: 3,
      layoutPreset: "gene-major",
      loadingPattern: "sequential",
      fillDirection: "vertical",
    },
    plateEditing: null,
    generation: { layoutSignature: "", generatedAt: "" },
    reactionSystem: createPlannerSession().reactionSystem,
    language: "zh",
  };
  const restored = restorePlannerSession(JSON.stringify(v8));
  assert.equal(restored.ok, true);
  assert.equal(restored.migratedFrom, 8);
  assert.deepEqual(restored.session.setup.samples[0], {
    ...samples[0],
    cellLine: "",
    comparisonGroup: "",
    isBridge: false,
  });
  assert.equal(JSON.parse(serializePlannerSession(restored.session)).version, 9);
});

test("a restored session still invalidates confirmation after a manual edit", () => {
  let session = createPlannerSession({ samples, genes });
  session = dispatchPlannerSession(session, {
    type: "generate-layout",
    generatedAt: "now",
  }).session;
  session = dispatchPlannerSession(session, {
    type: "edit-plate",
    command: { type: "set-confirmed", plateNumber: 1, confirmed: true },
  }).session;
  session = restorePlannerSession(serializePlannerSession(session)).session;
  const wellId = session.plateEditing?.plan.plates[0].wells.find(
    (well) => well.sample && well.gene,
  )?.wellId;
  assert.ok(wellId);
  session = dispatchPlannerSession(session, {
    type: "edit-plate-many",
    commands: [
      { type: "select", plateNumber: 1, wellIds: [wellId], mode: "replace" },
      { type: "clear" },
    ],
  }).session;
  assert.equal(session.plateEditing?.confirmedPlateNumbers.has(1), false);
});

test("malformed storage degrades to a usable new draft", () => {
  const restored = restorePlannerSession("{not-json");
  assert.equal(restored.ok, false);
  assert.deepEqual(restored.session.setup.samples, []);
  assert.deepEqual(restored.session.setup.genes, []);
  assert.equal(restored.session.plateEditing, null);
});

test("reset clears the experiment but preserves the interface language", () => {
  const session = createPlannerSession({ samples, genes, language: "en" });
  const reset = dispatchPlannerSession(session, { type: "reset" }).session;
  assert.deepEqual(reset.setup.samples, []);
  assert.deepEqual(reset.setup.genes, []);
  assert.equal(reset.plateEditing, null);
  assert.equal(reset.language, "en");
});

test("setup entry history is owned by the Planner Session", () => {
  let session = createPlannerSession({ samples, genes });
  const nextSamples = [
    ...samples,
    { id: "sample-2", name: "S2", kind: "sample" as const },
  ];
  session = dispatchPlannerSession(session, {
    type: "commit-entries",
    samples: nextSamples,
    genes,
  }).session;
  assert.deepEqual(session.setup.samples, nextSamples);
  assert.equal(session.entryHistory.canUndo, true);

  session = dispatchPlannerSession(session, { type: "undo-entries" }).session;
  assert.deepEqual(session.setup.samples, samples);
  assert.equal(session.entryHistory.canRedo, true);
  session = dispatchPlannerSession(session, { type: "redo-entries" }).session;
  assert.deepEqual(session.setup.samples, nextSamples);
});

test("metadata text edits can record their pre-focus state for undo and stale detection", () => {
  let session = createPlannerSession({ samples, genes });
  session = dispatchPlannerSession(session, {
    type: "generate-layout",
    generatedAt: "now",
  }).session;
  const previous = {
    samples: session.setup.samples.map((sample) => ({ ...sample })),
    genes: session.setup.genes.map((gene) => ({ ...gene })),
  };
  const editedSamples = session.setup.samples.map((sample) => ({
    ...sample,
    cellLine: "A549",
    comparisonGroup: "FBN2 KD",
  }));
  session = dispatchPlannerSession(session, {
    type: "patch-setup",
    patch: { samples: editedSamples },
  }).session;
  session = dispatchPlannerSession(session, {
    type: "commit-entries",
    samples: editedSamples,
    genes,
    previous,
  }).session;
  assert.equal(plannerSessionIsStale(session), true);
  session = dispatchPlannerSession(session, { type: "undo-entries" }).session;
  assert.deepEqual(session.setup.samples, samples);
  session = dispatchPlannerSession(session, { type: "redo-entries" }).session;
  assert.deepEqual(session.setup.samples, editedSamples);
});

test("Saved Planner Draft excludes transient editing controls and history", () => {
  let session = createPlannerSession({ samples, genes });
  session = dispatchPlannerSession(session, {
    type: "generate-layout",
    generatedAt: "now",
  }).session;
  const wellId = session.plateEditing?.plan.plates[0].wells.find(
    (well) => well.sample && well.gene,
  )?.wellId;
  assert.ok(wellId);
  session = dispatchPlannerSession(session, {
    type: "edit-plate-many",
    commands: [
      { type: "select", plateNumber: 1, wellIds: [wellId], mode: "replace" },
      { type: "copy" },
      { type: "set-move-mode", enabled: true },
      { type: "clear" },
    ],
  }).session;
  assert.ok(session.plateEditing?.clipboard);
  assert.equal(session.plateEditing?.undoStack.length, 1);

  const restored = restorePlannerSession(serializePlannerSession(session)).session;
  assert.deepEqual(restored.plateEditing?.selection.wellIds, []);
  assert.equal(restored.plateEditing?.clipboard, null);
  assert.equal(restored.plateEditing?.moveMode, false);
  assert.deepEqual(restored.plateEditing?.undoStack, []);
  assert.deepEqual(restored.plateEditing?.redoStack, []);
  assert.equal(
    restored.plateEditing?.plan.plates[0].wells.find(
      (well) => well.wellId === wellId,
    )?.sample,
    null,
  );
});

test("Planner Session queries expose current audit and reaction requirements", () => {
  let session = createPlannerSession({ samples, genes });
  session = dispatchPlannerSession(session, {
    type: "generate-layout",
    generatedAt: "now",
  }).session;
  assert.equal(plannerSessionAudit(session).valid, true);
  assert.equal(plannerSessionReactionCalculation(session).totalWells, 6);

  const wellId = session.plateEditing?.plan.plates[0].wells.find(
    (well) => well.sample && well.gene === "G1",
  )?.wellId;
  assert.ok(wellId);
  session = dispatchPlannerSession(session, {
    type: "edit-plate-many",
    commands: [
      { type: "select", plateNumber: 1, wellIds: [wellId], mode: "replace" },
      { type: "clear" },
    ],
  }).session;
  assert.equal(plannerSessionReactionCalculation(session).totalWells, 5);
  assert.equal(plannerSessionAudit(session).valid, false);
});
