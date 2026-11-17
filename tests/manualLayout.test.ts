import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBoxSelection,
  applyManualLayoutPatch,
  assignSelectedWells,
  clipboardMatchesExperiment,
  copySelectedWells,
  createManualLayoutPatch,
  invertManualLayoutPatch,
  pasteCopiedWells,
  rectangularWellIds,
  restoreSelectedWells,
  planPaste,
  planSwap,
  swapSelectedWells,
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

const at = (plate: ReturnType<typeof examplePlate>, wellId: string) =>
  plate.wells.find((well) => well.wellId === wellId);
const reaction = (plate: ReturnType<typeof examplePlate>, wellId: string) => {
  const well = at(plate, wellId);
  return well ? `${well.sample ?? "-"}/${well.gene ?? "-"}/${well.replicateIndex ?? "-"}` : "missing";
};

test("dragging a block onto empty wells moves it and leaves the old wells empty", () => {
  const plate = examplePlate();
  const before = ["A1", "A2", "A3"].map((wellId) => reaction(plate, wellId));
  const moved = swapSelectedWells(plate, ["A1", "A2", "A3"], "A1", "C1");
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.deepEqual(moved.landingWellIds, ["C1", "C2", "C3"]);
  assert.deepEqual(["C1", "C2", "C3"].map((wellId) => reaction(moved.plate, wellId)), before);
  for (const wellId of ["A1", "A2", "A3"]) assert.equal(at(moved.plate, wellId)?.sample, null);
  assert.equal(at(moved.plate, "C1")?.source, "manual");
});

test("dragging onto occupied wells swaps the two blocks in the same shape", () => {
  const plate = examplePlate();
  const rowA = ["A1", "A2", "A3"].map((wellId) => reaction(plate, wellId));
  const rowB = ["B1", "B2", "B3"].map((wellId) => reaction(plate, wellId));
  const moved = swapSelectedWells(plate, ["A1", "A2", "A3"], "A2", "B2");
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.deepEqual(moved.displacedWellIds, ["B1", "B2", "B3"]);
  assert.deepEqual(["B1", "B2", "B3"].map((wellId) => reaction(moved.plate, wellId)), rowA);
  assert.deepEqual(["A1", "A2", "A3"].map((wellId) => reaction(moved.plate, wellId)), rowB);
});

test("an overlapping shift rotates the displaced well into the vacated one", () => {
  const plate = examplePlate();
  const original = ["A1", "A2", "A3", "A4"].map((wellId) => reaction(plate, wellId));
  const moved = swapSelectedWells(plate, ["A1", "A2", "A3"], "A1", "A2");
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.deepEqual(
    ["A1", "A2", "A3", "A4"].map((wellId) => reaction(moved.plate, wellId)),
    [original[3], original[0], original[1], original[2]],
  );
});

test("non-contiguous selections keep their gaps; off-plate drops are refused", () => {
  const plate = examplePlate();
  const moved = swapSelectedWells(plate, ["A1", "A3"], "A1", "C1");
  assert.equal(moved.ok, true);
  if (moved.ok) {
    assert.deepEqual(moved.landingWellIds, ["C1", "C3"]);
    assert.equal(at(moved.plate, "C2")?.sample, null);
  }
  const refused = planSwap(plate, ["A1", "A2"], "A1", "A12");
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "out-of-bounds");
  assert.deepEqual(refused.landingWellIds, ["A12"]);
  assert.deepEqual(refused.moves, []);
});

test("every swap keeps the same set of reactions on the plate", () => {
  const plate = examplePlate();
  const census = (wells: typeof plate.wells) => wells.map((well) => `${well.sample}/${well.gene}/${well.replicateIndex}`).sort();
  for (const [selection, from, to] of [
    [["A1", "A2", "B1", "B2"], "A1", "B2"],
    [["A3", "B1"], "B1", "D7"],
    [["B3"], "B3", "A1"],
  ] as const) {
    const moved = swapSelectedWells(plate, selection, from, to);
    assert.equal(moved.ok, true);
    if (moved.ok) assert.deepEqual(census(moved.plate.wells), census(plate.wells));
  }
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

test("paste lines the first copied well up with the target, skips empty wells and reports overwrites", () => {
  const plate = examplePlate();
  // B2 then A3: A3 comes first in reading order, so it lands on the target.
  const copied = copySelectedWells(plate, ["B2", "A3", "A4"]);
  const plan = planPaste(plate, copied, "D5");
  assert.ok(plan);
  const filled = ["A3", "A4", "B2"].filter((wellId) => at(plate, wellId)?.sample && at(plate, wellId)?.gene);
  const expected = { A3: "D5", A4: "D6", B2: "E4" } as const;
  assert.deepEqual(plan.targets.map((target) => target.wellId), filled.map((wellId) => expected[wellId as keyof typeof expected]));
  assert.equal(plan.outside, 0);

  const overPlan = planPaste(plate, copySelectedWells(plate, ["A1"]), "B1");
  assert.deepEqual(overPlan?.overwrittenWellIds, ["B1"]);

  const edge = planPaste(plate, copySelectedWells(plate, ["A1", "A2", "A3"]), "A11");
  assert.equal(edge?.outside, 1);
  assert.deepEqual(pasteCopiedWells(plate, copySelectedWells(plate, ["A1", "A2", "A3"]), "A11"), { ok: false, reason: "out-of-bounds" });

  const emptyOnly = copySelectedWells(plate, ["H12"]);
  assert.deepEqual(pasteCopiedWells(plate, emptyOnly, "A1"), { ok: false, reason: "empty-clipboard" });
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

test("manual history records only changed wells and can be reversed", () => {
  const layout = planPlateLayout({
    plateType: 96,
    samples: ["S1"],
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  });
  const editedPlate = assignSelectedWells(layout.plates[0], ["A1"], {
    sample: "S1",
    gene: "R1",
    geneType: "reference",
  });
  const edited = { ...layout, plates: [editedPlate] };
  const patch = createManualLayoutPatch(layout, edited, [1]);

  assert.equal(patch.wells.length, 1);
  assert.equal(patch.wells[0].wellId, "A1");
  assert.equal(patch.plateNames.length, 0);
  assert.equal(
    applyManualLayoutPatch(layout, patch).plates[0].wells[0].gene,
    "R1",
  );
  assert.deepEqual(
    applyManualLayoutPatch(edited, invertManualLayoutPatch(patch)).plates[0]
      .wells[0],
    layout.plates[0].wells[0],
  );
});

test("manual history stores a plate rename without copying unchanged wells", () => {
  const layout = planPlateLayout({
    plateType: 96,
    samples: ["S1"],
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  });
  const renamed = {
    ...layout,
    plates: [{ ...layout.plates[0], name: "Validation plate" }],
  };
  const patch = createManualLayoutPatch(layout, renamed, [1]);

  assert.equal(patch.wells.length, 0);
  assert.deepEqual(patch.plateNames, [
    { plateNumber: 1, before: "Plate 01", after: "Validation plate" },
  ]);
  assert.equal(applyManualLayoutPatch(layout, patch).plates[0].name, "Validation plate");
});
