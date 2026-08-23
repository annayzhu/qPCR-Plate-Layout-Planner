import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlateEditingSession,
  dispatchPlateEdit,
  dispatchPlateEdits,
} from "../lib/plateEditingSession";
import { planPlateLayout, type PlanInput } from "../lib/platePlanner";
import {
  calculateReactionRequirements,
  DEFAULT_REACTION_SYSTEM,
} from "../lib/reactionCalculator";

const input: PlanInput = {
  plateType: 96,
  samples: ["S1"],
  targetGenes: ["G1"],
  referenceGenes: ["R1"],
  replicates: 3,
};

function sessionFixture() {
  const plan = planPlateLayout(input);
  return createPlateEditingSession({
    plan,
    generatedBaseline: plan,
    planInput: input,
    confirmedPlateNumbers: [1],
  });
}

function occupiedWellId(
  session: ReturnType<typeof sessionFixture>,
  gene: string,
) {
  const well = session.plan.plates[0].wells.find(
    (candidate) => candidate.sample === "S1" && candidate.gene === gene,
  );
  assert.ok(well);
  return well.wellId;
}

test("copy and paste is one editing scenario with recalculation and undo", () => {
  let session = sessionFixture();
  const sourceWellId = occupiedWellId(session, "G1");

  session = dispatchPlateEdit(session, {
    type: "select",
    plateNumber: 1,
    wellIds: [sourceWellId],
    mode: "replace",
  }).session;
  session = dispatchPlateEdit(session, { type: "copy" }).session;
  session = dispatchPlateEdit(session, {
    type: "select",
    plateNumber: 1,
    wellIds: ["H12"],
    mode: "replace",
  }).session;
  const pasted = dispatchPlateEdit(session, {
    type: "paste",
    plateNumber: 1,
    destinationWellId: "H12",
  });

  assert.equal(pasted.outcome.status, "applied");
  session = pasted.session;
  assert.equal(session.confirmedPlateNumbers.has(1), false);
  assert.equal(
    session.plan.plates[0].wells.find((well) => well.wellId === "H12")
      ?.source,
    "manual",
  );
  const calculation = calculateReactionRequirements(
    session.plan,
    DEFAULT_REACTION_SYSTEM,
    ["S1"],
    [
      { name: "G1", role: "target" },
      { name: "R1", role: "reference" },
    ],
  );
  assert.equal(calculation.totalWells, 7);

  const undone = dispatchPlateEdit(session, { type: "undo" });
  assert.equal(undone.outcome.status, "undone");
  assert.equal(
    undone.session.plan.plates[0].wells.find(
      (well) => well.wellId === "H12",
    )?.sample,
    null,
  );
  assert.deepEqual(undone.session.selection.wellIds, ["H12"]);
  assert.ok(undone.session.clipboard);

  const redone = dispatchPlateEdit(undone.session, { type: "redo" });
  assert.equal(redone.outcome.status, "redone");
  assert.equal(
    redone.session.plan.plates[0].wells.find(
      (well) => well.wellId === "H12",
    )?.source,
    "manual",
  );
});

test("paste reports occupied destinations before an explicit overwrite", () => {
  let session = sessionFixture();
  const sourceWellId = occupiedWellId(session, "G1");
  const occupiedDestination = occupiedWellId(session, "R1");
  session = dispatchPlateEdit(session, {
    type: "select",
    plateNumber: 1,
    wellIds: [sourceWellId],
    mode: "replace",
  }).session;
  session = dispatchPlateEdit(session, { type: "copy" }).session;

  const conflict = dispatchPlateEdit(session, {
    type: "paste",
    plateNumber: 1,
    destinationWellId: occupiedDestination,
  });
  assert.equal(conflict.outcome.status, "conflict");
  assert.deepEqual(conflict.outcome.wellIds, [occupiedDestination]);
  assert.deepEqual(conflict.session.plan, session.plan);

  const overwritten = dispatchPlateEdit(session, {
    type: "paste",
    plateNumber: 1,
    destinationWellId: occupiedDestination,
    allowOverwrite: true,
  });
  assert.equal(overwritten.outcome.status, "applied");
});

test("assign, clear, restore, and move stay behind one interface", () => {
  let session = sessionFixture();
  const targetWellId = occupiedWellId(session, "G1");
  const referenceWellId = occupiedWellId(session, "R1");
  session = dispatchPlateEdit(session, {
    type: "select",
    plateNumber: 1,
    wellIds: [targetWellId],
    mode: "replace",
  }).session;

  session = dispatchPlateEdit(session, {
    type: "assign",
    sample: "S1",
    gene: "R1",
    geneType: "reference",
  }).session;
  assert.equal(
    session.plan.plates[0].wells.find((well) => well.wellId === targetWellId)
      ?.source,
    "manual",
  );
  session = dispatchPlateEdit(session, { type: "restore-selected" }).session;
  assert.deepEqual(
    session.plan.plates[0].wells.find((well) => well.wellId === targetWellId),
    session.generatedBaseline.plates[0].wells.find(
      (well) => well.wellId === targetWellId,
    ),
  );

  session = dispatchPlateEdit(session, {
    type: "select",
    plateNumber: 1,
    wellIds: [referenceWellId],
    mode: "replace",
  }).session;
  session = dispatchPlateEdit(session, { type: "clear" }).session;
  assert.equal(
    session.plan.plates[0].wells.find(
      (well) => well.wellId === referenceWellId,
    )?.sample,
    null,
  );
  session = dispatchPlateEdit(session, { type: "restore-selected" }).session;

  const moved = dispatchPlateEdit(session, {
    type: "move",
    plateNumber: 1,
    destinationWellId: "H12",
  });
  assert.equal(moved.outcome.status, "applied");
  assert.deepEqual(moved.session.selection.wellIds, ["H12"]);
});

test("range and additive box selection are session commands", () => {
  let session = sessionFixture();
  session = dispatchPlateEdit(session, {
    type: "select-range",
    plateNumber: 1,
    anchorWellId: "A1",
    endWellId: "B2",
    mode: "replace",
  }).session;
  assert.deepEqual(session.selection.wellIds, ["A1", "A2", "B1", "B2"]);

  session = dispatchPlateEdit(session, {
    type: "select-range",
    plateNumber: 1,
    anchorWellId: "C1",
    endWellId: "C2",
    mode: "add",
  }).session;
  assert.deepEqual(session.selection.wellIds, [
    "A1",
    "A2",
    "B1",
    "B2",
    "C1",
    "C2",
  ]);
});

test("sparse clipboard preserves gaps and selected empty wells clear destinations", () => {
  let session = sessionFixture();
  session = dispatchPlateEdit(session, {
    type: "select",
    plateNumber: 1,
    wellIds: ["A1", "A3", "A4"],
    mode: "replace",
  }).session;
  session = dispatchPlateEdit(session, { type: "copy" }).session;
  const copiedGene = session.plan.plates[0].wells.find(
    (well) => well.wellId === "A1",
  )?.gene;
  const originalGap = session.plan.plates[0].wells.find(
    (well) => well.wellId === "B2",
  );
  const pasted = dispatchPlateEdit(session, {
    type: "paste",
    plateNumber: 1,
    destinationWellId: "B1",
    allowOverwrite: true,
  });
  assert.equal(pasted.outcome.status, "applied");
  const plate = pasted.session.plan.plates[0];
  assert.equal(plate.wells.find((well) => well.wellId === "B1")?.gene, copiedGene);
  assert.deepEqual(
    plate.wells.find((well) => well.wellId === "B2"),
    originalGap,
  );
  assert.equal(plate.wells.find((well) => well.wellId === "B3")?.gene, copiedGene);
  assert.equal(plate.wells.find((well) => well.wellId === "B4")?.gene, null);

  session = dispatchPlateEdit(pasted.session, {
    type: "select",
    plateNumber: 1,
    wellIds: ["A4"],
    mode: "replace",
  }).session;
  session = dispatchPlateEdit(session, { type: "copy" }).session;
  session = dispatchPlateEdit(session, {
    type: "paste",
    plateNumber: 1,
    destinationWellId: "B2",
    allowOverwrite: true,
  }).session;
  assert.equal(
    session.plan.plates[0].wells.find((well) => well.wellId === "B2")?.gene,
    null,
  );
});

test("clipboard is rejected after its sample is removed from the experiment", () => {
  let session = sessionFixture();
  const sourceWellId = occupiedWellId(session, "G1");
  session = dispatchPlateEdit(session, {
    type: "select",
    plateNumber: 1,
    wellIds: [sourceWellId],
    mode: "replace",
  }).session;
  session = dispatchPlateEdit(session, { type: "copy" }).session;
  const incompatibleSession = {
    ...session,
    planInput: { ...session.planInput, samples: ["S2"] },
  };
  const result = dispatchPlateEdit(incompatibleSession, {
    type: "paste",
    plateNumber: 1,
    destinationWellId: "H12",
  });
  assert.equal(result.outcome.status, "rejected");
  assert.equal(result.outcome.reason, "clipboard-incompatible");
});

test("a rejected setup command prevents a later edit from using stale selection", () => {
  let session = sessionFixture();
  const sourceWellId = occupiedWellId(session, "G1");
  session = dispatchPlateEdit(session, {
    type: "select",
    plateNumber: 1,
    wellIds: [sourceWellId],
    mode: "replace",
  }).session;
  const before = session.plan;
  const result = dispatchPlateEdits(session, [
    {
      type: "select",
      plateNumber: 999,
      wellIds: ["A1"],
      mode: "replace",
    },
    { type: "clear" },
  ]);
  assert.equal(result.outcome.status, "rejected");
  assert.equal(result.outcome.reason, "plate-not-found");
  assert.deepEqual(result.session.plan, before);
});

test("confirmation stays invalidated across undo and redo after an edit", () => {
  let session = sessionFixture();
  const sourceWellId = occupiedWellId(session, "G1");
  session = dispatchPlateEdit(session, {
    type: "select",
    plateNumber: 1,
    wellIds: [sourceWellId],
    mode: "replace",
  }).session;
  session = dispatchPlateEdit(session, { type: "clear" }).session;
  session = dispatchPlateEdit(session, {
    type: "set-confirmed",
    plateNumber: 1,
    confirmed: true,
  }).session;
  assert.equal(session.confirmedPlateNumbers.has(1), true);

  session = dispatchPlateEdit(session, { type: "undo" }).session;
  assert.equal(session.confirmedPlateNumbers.has(1), false);
  session = dispatchPlateEdit(session, { type: "redo" }).session;
  assert.equal(session.confirmedPlateNumbers.has(1), false);
});

test("plate rename and restore remain atomic session commands", () => {
  let session = sessionFixture();
  session = dispatchPlateEdit(session, {
    type: "rename-plate",
    plateNumber: 1,
    name: "Validation plate",
  }).session;
  assert.equal(session.plan.plates[0].name, "Validation plate");

  const sourceWellId = occupiedWellId(session, "G1");
  session = dispatchPlateEdit(session, {
    type: "select",
    plateNumber: 1,
    wellIds: [sourceWellId],
    mode: "replace",
  }).session;
  session = dispatchPlateEdit(session, { type: "clear" }).session;
  session = dispatchPlateEdit(session, {
    type: "set-move-mode",
    enabled: true,
  }).session;
  session = dispatchPlateEdit(session, {
    type: "restore-plate",
    plateNumber: 1,
  }).session;
  assert.equal(session.plan.plates[0].name, "Validation plate");
  assert.deepEqual(session.plan.plates[0].wells, session.generatedBaseline.plates[0].wells);
  assert.deepEqual(session.selection.wellIds, []);
  assert.equal(session.moveMode, false);
});
