import assert from "node:assert/strict";
import test from "node:test";
import { buildLoadingStrips, loadingStripSlots } from "../lib/loadingStrips";
import { planPlateLayout, validateLayout, type PlanInput } from "../lib/platePlanner";
import { calculateReactionRequirements, DEFAULT_REACTION_SYSTEM } from "../lib/reactionCalculator";
import { createPlannerSession, dispatchPlannerSession, plannerSessionIsStale, restorePlannerSession, serializePlannerSession } from "../lib/plannerSession";
import { buildPlateWorkbook, type ExportContext } from "../lib/exportExcel";

const samples = Array.from({ length: 11 }, (_, i) => `S${i + 1}`);
const sampleDesigns = samples.map((name, i) => ({ name, loadingGroup: i < 5 ? "Group A" : "Group B" }));
const input: PlanInput = { plateType: 384, samples, sampleDesigns, targetGenes: ["T1"], referenceGenes: ["R1"], replicates: 3 };

test("each user group starts a new strip; >8 members continue without filling another group's holes", () => {
  const strips = buildLoadingStrips(samples, sampleDesigns);
  assert.deepEqual(strips.map((strip) => strip.samples.length), [5, 6]);
  assert.equal(loadingStripSlots(strips).get("S6"), 8);
  const bigger = buildLoadingStrips(Array.from({ length: 18 }, (_, i) => `S${i + 1}`), sampleDesigns);
  assert.deepEqual(bigger.map((strip) => strip.samples.length), [5, 6, 7]);
  assert.deepEqual(buildLoadingStrips(samples).map((strip) => strip.samples.length), [8, 3]);
});

for (const plateType of [96, 384] as const) for (const fillDirection of ["vertical", "horizontal"] as const) {
  test(`${plateType} ${fillDirection}: complete strip tiles, horizontal replicates, padding stays empty`, () => {
    const setup = { ...input, plateType };
    const plan = planPlateLayout(setup, { loadingUnit: "eight-strip", strategy: "gene-major", fillDirection });
    assert.equal(validateLayout(plan, setup).valid, true);
    assert.equal(plan.metrics.usedWells, 66);
    const plate = plan.plates[0];
    const laneRows = plateType === 384 ? [[0, 2, 4, 6, 8, 10, 12, 14], [1, 3, 5, 7, 9, 11, 13, 15]] : [[0, 1, 2, 3, 4, 5, 6, 7]];
    for (const rows of laneRows) for (let column = 0; column < plate.columns; column += 3) {
      const names = rows.map((row) => plate.wells.find((well) => well.row === row && well.column === column)!.sample);
      if (names.every((name) => !name)) continue;
      assert.ok(JSON.stringify(names) === JSON.stringify([...samples.slice(0, 5), null, null, null]) || JSON.stringify(names) === JSON.stringify([...samples.slice(5), null, null]));
    }
    const s6ref = plate.wells.find((well) => well.sample === "S6" && well.gene === "R1" && well.replicateIndex === 1)!;
    assert.equal(s6ref.wellId, plateType === 384 && fillDirection === "vertical" ? "B1" : "A4");
    const requirements = calculateReactionRequirements(plan, DEFAULT_REACTION_SYSTEM, samples, [{ name: "T1", role: "target" }, { name: "R1", role: "reference" }]);
    assert.equal(requirements.totalWells, 66);
  });
}

test("comparison units spanning loading groups remain intact and references rerun on every involved plate", () => {
  const setup = { ...input, plateType: 96 as const, targetGenes: ["T1", "T2", "T3"], sampleDesigns: sampleDesigns.map((sample) => ({ ...sample, cellLine: "A549", comparisonGroup: "experiment" })) };
  const plan = planPlateLayout(setup, { loadingUnit: "eight-strip" });
  assert.equal(validateLayout(plan, setup).valid, true);
  for (const gene of setup.targetGenes) {
    assert.equal(plan.plates.filter((plate) => plate.wells.some((well) => well.gene === gene)).length, 1);
  }
});

test("oversized comparison groups use explicit bridges without splitting non-bridge source strips", () => {
  const names = Array.from({ length: 24 }, (_, i) => `S${i + 1}`);
  const setup = { ...input, plateType: 96 as const, samples: names, sampleDesigns: names.map((name, i) => ({ name, loadingGroup: `G${Math.floor(i / 8)}`, cellLine: "A549", comparisonGroup: "experiment", isBridge: i === 0 })) };
  assert.throws(() => planPlateLayout({ ...setup, sampleDesigns: setup.sampleDesigns.map((sample) => ({ ...sample, isBridge: false })) }, { loadingUnit: "eight-strip" }), /bridge|桥接/);
  const plan = planPlateLayout(setup, { loadingUnit: "eight-strip" });
  assert.equal(validateLayout(plan, setup).valid, true);
  assert.equal(plan.plates.length, 2);
});

test("loading groups survive save/restore and undo; changing a group invalidates the preview", () => {
  let session = createPlannerSession({ samples: sampleDesigns.map((sample, i) => ({ ...sample, id: String(i), kind: "sample" })), genes: [{ id: "g1", name: "T1", role: "target" }, { id: "g2", name: "R1", role: "reference" }] });
  session = dispatchPlannerSession(session, { type: "generate-layout", generatedAt: "test" }).session;
  assert.equal(plannerSessionIsStale(session), false);
  const restored = restorePlannerSession(serializePlannerSession(session));
  assert.equal(restored.ok, true);
  assert.equal(restored.session.setup.loadingUnit, "eight-strip");
  assert.equal(plannerSessionIsStale(restored.session), false);
  const changed = dispatchPlannerSession(session, { type: "commit-entries", samples: session.setup.samples.map((sample) => ({ ...sample, loadingGroup: "all" })), genes: session.setup.genes }).session;
  assert.equal(plannerSessionIsStale(changed), true);
  assert.equal(plannerSessionIsStale(dispatchPlannerSession(changed, { type: "undo-entries" }).session), false);
});

test("old v9 drafts keep their original well-level plan and signature", () => {
  let session = createPlannerSession({ loadingUnit: "well", samples: [{ id: "s1", name: "S1", kind: "sample" }], genes: [{ id: "t", name: "T1", role: "target" }, { id: "r", name: "R1", role: "reference" }] });
  session = dispatchPlannerSession(session, { type: "generate-layout", generatedAt: "old" }).session;
  const old = JSON.parse(serializePlannerSession(session));
  delete old.setup.loadingUnit;
  delete old.plateEditing.plan.loadingUnit;
  delete old.plateEditing.generatedBaseline.loadingUnit;
  const restored = restorePlannerSession(JSON.stringify(old));
  assert.equal(restored.session.setup.loadingUnit, "well");
  assert.equal(plannerSessionIsStale(restored.session), false);
  assert.deepEqual(restored.session.plateEditing?.plan.plates, session.plateEditing?.plan.plates);
});

test("deterministic strip layouts preserve channel identity for both plate formats, orders and loading patterns", () => {
  for (let count = 1; count <= 33; count += 4) for (const plateType of [96, 384] as const) for (const fillDirection of ["horizontal", "vertical"] as const) for (const strategy of ["sample-major", "gene-major"] as const) {
    const names = Array.from({ length: count }, (_, i) => `S${i + 1}`);
    const designs = names.map((name, i) => ({ name, loadingGroup: `G${Math.floor(i / 5)}` }));
    const setup = { ...input, plateType, samples: names, sampleDesigns: designs, replicates: count % 2 + 2, targetGenes: ["T1", "T2", "T3", "T4"] };
    const options = { loadingUnit: "eight-strip" as const, fillDirection, strategy, loadingPattern: count % 3 ? "interleaved-8-channel" as const : "sequential" as const };
    const plan = planPlateLayout(setup, options);
    assert.equal(validateLayout(plan, setup).valid, true, `${count}/${plateType}/${fillDirection}/${strategy}`);
    assert.deepEqual(plan, planPlateLayout(setup, options));
    const slots = loadingStripSlots(buildLoadingStrips(names, designs));
    for (const plate of plan.plates) {
      const tiles = new Map<string, Set<string>>();
      for (const well of plate.wells.filter((well) => well.sample && well.gene)) {
        const interleaved = plan.loadingPattern === "interleaved-8-channel";
        const lane = interleaved ? well.row % 2 : Math.floor(well.row / 8);
        const channel = interleaved ? Math.floor(well.row / 2) : well.row % 8;
        assert.equal(channel, slots.get(well.sample!)! % 8);
        const key = `${lane}/${Math.floor(well.column / setup.replicates)}`;
        const content = tiles.get(key) ?? new Set<string>();
        content.add(`${Math.floor(slots.get(well.sample!)! / 8)}/${well.gene}`);
        tiles.set(key, content);
      }
      for (const content of tiles.values()) assert.equal(content.size, 1);
    }
  }
});

for (const fillDirection of ["horizontal", "vertical"] as const) test(`Excel ${fillDirection} round-trip preserves groups, empty channels and actual well counts`, async () => {
  const plan = planPlateLayout(input, { loadingUnit: "eight-strip", fillDirection, strategy: "gene-major" });
  const context: ExportContext = { ...input, loadingUnit: "eight-strip", fillDirection, loadingPattern: plan.loadingPattern, layoutStrategy: plan.strategy, strategyLabel: "By assay", generatedAt: "test", validationStatus: "Valid", splitSamples: 0, repeatedReferenceBlocks: 0, repeatedReferenceWells: 0, reactionSystem: DEFAULT_REACTION_SYSTEM };
  const { XLSX, workbook } = await buildPlateWorkbook({ ...plan.plates[0], confirmed: true }, context);
  const restored = XLSX.read(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }), { type: "buffer" });
  assert.deepEqual(restored.SheetNames.slice(0, 3), ["Plate_Map", "Well_Detail", "Source_Strips"]);
  const strips = XLSX.utils.sheet_to_json<Record<string, unknown>>(restored.Sheets.Source_Strips);
  assert.equal(strips[0].A, "S1");
  assert.equal(strips[0].F, "留空 / Empty");
  assert.equal(strips[1].A, "S6");
  const details = XLSX.utils.sheet_to_json<Record<string, unknown>>(restored.Sheets.Well_Detail);
  const s6 = details.find((row) => row["样本 / Sample"] === "S6");
  assert.equal(s6?.["来源行 / Source row (A-H)"], "A");
  assert.equal(s6?.["八道样本组 / 8-channel sample group"], 2);
  assert.equal(s6?.["上样组 / Loading group"], "Group B");
  assert.equal(details.filter((row) => row["样本 / Sample"]).length, 66);
});
