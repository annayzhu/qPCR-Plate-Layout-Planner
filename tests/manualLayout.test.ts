import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBoxSelection,
  assignSelectedWells,
  clipboardMatchesExperiment,
  copySelectedWells,
  pasteCopiedWells,
  rectangularWellIds,
  restoreSelectedWells,
  translateSelectedWells,
} from "../lib/manualLayout";
import { planPlateLayout } from "../lib/platePlanner";
import {
  calculateReactionRequirements,
  DEFAULT_REACTION_SYSTEM,
} from "../lib/reactionCalculator";

function examplePlate() {
  return planPlateLayout({
    plateType: 96,
    samples: ["S1"],
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  }).plates[0];
}

test("Shift-style rectangular selection returns a complete well range", () => {
  const plate = examplePlate();
  assert.deepEqual(rectangularWellIds(plate, "A1", "B2"), [
    "A1",
    "A2",
    "B1",
    "B2",
  ]);
});

test("plain box selection replaces the previous well selection", () => {
  assert.deepEqual(
    applyBoxSelection(["A1", "A2"], ["B1", "B2"], "replace"),
    ["B1", "B2"],
  );
});

test("Command or Ctrl box selection adds boxed wells without deselecting", () => {
  assert.deepEqual(
    applyBoxSelection(["A1", "A2"], ["A2", "B1"], "add"),
    ["A1", "A2", "B1"],
  );
});

test("editing one selected well does not update its replicate neighbours", () => {
  const plate = examplePlate();
  const originalGene =
    plate.wells.find((well) => well.wellId === "A2")?.gene ?? "R1";
  const replacementGene = originalGene === "G1" ? "R1" : "G1";
  const edited = assignSelectedWells(plate, ["A2"], {
    sample: "S1",
    gene: replacementGene,
    geneType: replacementGene === "R1" ? "reference" : "target",
  });

  assert.equal(
    edited.wells.find((well) => well.wellId === "A1")?.gene,
    originalGene,
  );
  assert.equal(
    edited.wells.find((well) => well.wellId === "A2")?.gene,
    replacementGene,
  );
  assert.equal(
    edited.wells.find((well) => well.wellId === "A3")?.gene,
    originalGene,
  );
  assert.equal(
    edited.wells.find((well) => well.wellId === "A2")?.source,
    "manual",
  );
});

test("selected wells move together and preserve their relative positions", () => {
  const plate = examplePlate();
  const moved = translateSelectedWells(plate, ["A1", "A2", "A3"], "C1");
  assert.equal(moved.ok, true);
  if (!moved.ok) return;

  assert.deepEqual(moved.movedWellIds, ["C1", "C2", "C3"]);
  for (const wellId of ["A1", "A2", "A3"]) {
    assert.equal(
      moved.plate.wells.find((well) => well.wellId === wellId)?.sample,
      null,
    );
  }
  assert.deepEqual(
    ["C1", "C2", "C3"].map(
      (wellId) =>
        moved.plate.wells.find((well) => well.wellId === wellId)
          ?.replicateIndex,
    ),
    [1, 2, 3],
  );
});

test("non-contiguous selections keep their gaps and collisions are reported", () => {
  const plate = examplePlate();
  const moved = translateSelectedWells(plate, ["A1", "A3"], "C1");
  assert.equal(moved.ok, true);
  if (moved.ok) {
    assert.deepEqual(moved.movedWellIds, ["C1", "C3"]);
    assert.equal(
      moved.plate.wells.find((well) => well.wellId === "C2")?.sample,
      null,
    );
  }

  const collision = translateSelectedWells(plate, ["A1", "A2", "A3"], "B1");
  assert.deepEqual(collision, {
    ok: false,
    reason: "collision",
    collisionWellIds: ["B1", "B2", "B3"],
  });
});

test("copied wells paste as a duplicate block at the destination anchor", () => {
  const plate = examplePlate();
  const copied = copySelectedWells(plate, ["A1", "A3"]);
  const pasted = pasteCopiedWells(plate, copied, "C1");

  assert.equal(pasted.ok, true);
  if (!pasted.ok) return;
  assert.deepEqual(pasted.pastedWellIds, ["C1", "C3"]);
  assert.equal(
    pasted.plate.wells.find((well) => well.wellId === "A1")?.source,
    "auto",
  );
  assert.equal(
    pasted.plate.wells.find((well) => well.wellId === "C1")?.source,
    "manual",
  );
  assert.equal(
    pasted.plate.wells.find((well) => well.wellId === "C3")?.gene,
    plate.wells.find((well) => well.wellId === "A3")?.gene,
  );
});

test("pasted occupied wells increase reaction and reagent requirements", () => {
  const layout = planPlateLayout({
    plateType: 96,
    samples: ["S1"],
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  });
  const source = layout.plates[0].wells.find(
    (well) => well.sample === "S1" && well.gene === "G1",
  );
  assert.ok(source);
  const copied = copySelectedWells(layout.plates[0], [source.wellId]);
  const pasted = pasteCopiedWells(layout.plates[0], copied, "H12");
  assert.equal(pasted.ok, true);
  if (!pasted.ok) return;

  const calculation = calculateReactionRequirements(
    { ...layout, plates: [pasted.plate] },
    DEFAULT_REACTION_SYSTEM,
    ["S1"],
    [
      { name: "G1", role: "target" },
      { name: "R1", role: "reference" },
    ],
  );
  assert.equal(calculation.totalWells, 7);
  assert.equal(
    calculation.geneRequirements.find((item) => item.gene === "G1")
      ?.wellCount,
    4,
  );
  assert.equal(calculation.sampleRequirements[0].wellCount, 7);
  assert.equal(calculation.totals.theoreticalReactionUl, 70);
});

test("selected manual wells restore from the matching generated plate only", () => {
  const automatic = examplePlate();
  const edited = assignSelectedWells(automatic, ["A2", "B1"], {
    sample: "S1",
    gene: "R1",
    geneType: "reference",
  });
  const restored = restoreSelectedWells(edited, automatic, ["A2"]);

  assert.deepEqual(
    restored.wells.find((well) => well.wellId === "A2"),
    automatic.wells.find((well) => well.wellId === "A2"),
  );
  assert.equal(
    restored.wells.find((well) => well.wellId === "B1")?.source,
    "manual",
  );
});

test("clipboard from removed samples or assays cannot enter a new experiment", () => {
  const plate = examplePlate();
  const targetWell = plate.wells.find((well) => well.gene === "G1");
  assert.ok(targetWell);
  const copied = copySelectedWells(plate, [targetWell.wellId]);
  assert.equal(
    clipboardMatchesExperiment(copied, ["S1"], ["G1", "R1"]),
    true,
  );
  assert.equal(
    clipboardMatchesExperiment(copied, ["S2"], ["G1", "R1"]),
    false,
  );
  assert.equal(
    clipboardMatchesExperiment(copied, ["S1"], ["G2", "R1"]),
    false,
  );
});
