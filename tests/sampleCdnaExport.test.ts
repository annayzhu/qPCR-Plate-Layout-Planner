import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import XLSX from "xlsx-js-style";
import {
  buildPlateWorkbook,
  exportAllPlateExcels,
  type ExportablePlate,
  type ExportContext,
} from "../lib/exportExcel";
import { DEFAULT_REACTION_SYSTEM } from "../lib/reactionCalculator";

function exportFixture() {
  const context: ExportContext = {
    plateType: 384,
    replicates: 1,
    samples: ["S10", "Blank", "S2", "Unused"],
    blankSamples: ["Blank"],
    targetGenes: ["G1"],
    referenceGenes: [],
    strategyLabel: "Test",
    generatedAt: "2026-10-13",
    validationStatus: "Warning",
    splitSamples: 0,
    repeatedReferenceBlocks: 0,
    repeatedReferenceWells: 0,
    reactionSystem: DEFAULT_REACTION_SYSTEM,
  };
  const plates: ExportablePlate[] = [
    ["S2", "Manual-2", "Blank", "S10", "S2", "Manual-1"],
    ["Blank", "S10", "S10"],
  ].map((names, index) => ({
    plateNumber: index + 1,
    rows: 16,
    columns: 24,
    confirmed: true,
    wells: names.map((sample, row) => ({
      wellId: `${String.fromCharCode(65 + row)}1`,
      row,
      column: 0,
      sample,
      gene: "G1",
      geneType: "target",
      replicateIndex: 1,
      source: "manual",
    })),
  }));
  return { context, plates };
}

function sampleRows(workbook: XLSX.WorkBook) {
  return XLSX.utils.sheet_to_json<Record<string, string | number>>(
    workbook.Sheets.Sample_cDNA,
  );
}

test("Sample_cDNA follows the current input order, excludes unused samples and retains manual-only samples", async () => {
  const { context, plates } = exportFixture();
  for (const samples of [context.samples, ["S2", "Unused", "S10", "Blank"]]) {
    const { workbook } = await buildPlateWorkbook(plates[0], { ...context, samples });
    const saved = XLSX.read(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
    const rows = sampleRows(saved);
    assert.deepEqual(
      rows.map((row) => row["样本 / Sample"]),
      [...samples.filter((sample) => sample !== "Unused"), "Manual-2", "Manual-1"],
    );
    const counts = new Map(rows.map((row) => [row["样本 / Sample"], row["孔数 / Well count"]]));
    assert.equal(counts.get("S2"), 2);
    assert.equal(counts.get("S10"), 1);
    const blank = rows.find((row) => row["样本 / Sample"] === "Blank")!;
    assert.equal(blank["建议准备 cDNA / Prepare cDNA (µL)"], 0);
    assert.equal(blank["建议替代补水 / Prepare replacement water (µL)"], 1.12);
    const sample = rows.find((row) => row["样本 / Sample"] === "S2")!;
    assert.equal(sample["建议准备 cDNA / Prepare cDNA (µL)"], 2.24);
  }
});

test("batch ZIP plate files and overview use the same sample order and actual counts", async (t) => {
  const { context, plates } = exportFixture();
  let download: Blob | undefined;
  // Replace only the browser download boundary; build and read the real ZIP/XLSX files.
  t.mock.method(URL, "createObjectURL", (blob: Blob) => {
    download = blob;
    return "blob:test-export";
  });
  for (const [key, value] of Object.entries({
    document: {
      createElement: () => ({ style: {}, click() {}, remove() {} }),
      body: { appendChild() {} },
    },
    window: { setTimeout() {} },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  await exportAllPlateExcels(plates, context);
  assert.ok(download);
  const archive = await JSZip.loadAsync(await download.arrayBuffer());
  assert.equal(Object.keys(archive.files).length, 3);
  for (const [name, file] of Object.entries(archive.files)) {
    const workbook = XLSX.read(await file.async("nodebuffer"), { type: "buffer" });
    const rows = sampleRows(workbook);
    const isOverview = name.includes("All_Plates_Overview");
    const isSecondPlate = name.startsWith("qPCR_Plate_02_");
    assert.deepEqual(rows.map((row) => row["样本 / Sample"]),
      isSecondPlate ? ["S10", "Blank"] : ["S10", "Blank", "S2", "Manual-2", "Manual-1"]);
    if (isOverview) {
      assert.equal(rows[0]["孔数 / Well count"], 3);
      assert.equal(rows[0]["建议准备 cDNA / Prepare cDNA (µL)"], 3.36);
      assert.equal(rows[1]["孔数 / Well count"], 2);
      assert.equal(rows[1]["建议准备 cDNA / Prepare cDNA (µL)"], 0);
    }
  }
});
