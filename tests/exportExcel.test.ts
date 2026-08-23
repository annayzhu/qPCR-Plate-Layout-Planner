import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPlateWorkbook,
  overviewWorkbookFilename,
  plateWorkbookFilename,
  type ExportContext,
} from "../lib/exportExcel";
import { planPlateLayout } from "../lib/platePlanner";

test("plate workbook exports bilingual reaction totals and scoped requirement sheets", async () => {
  const layout = planPlateLayout({
    plateType: 96,
    samples: Array.from({ length: 8 }, (_, index) => `S${index + 1}`),
    targetGenes: ["G1", "G2", "G3"],
    referenceGenes: ["R1"],
    replicates: 3,
  });
  const plate = layout.plates[0];
  const context: ExportContext = {
    plateType: 96,
    replicates: 3,
    samples: Array.from({ length: 8 }, (_, index) => `S${index + 1}`),
    targetGenes: ["G1", "G2", "G3"],
    referenceGenes: ["R1"],
    strategyLabel: "按样本分块 / Sample-major",
    generatedAt: "2026-07-31 12:00:00",
    validationStatus: "Valid",
    splitSamples: 0,
    repeatedReferenceBlocks: 0,
    repeatedReferenceWells: 0,
    reactionSystem: {
      cdnaPerWellUl: 1,
      forwardPrimerPerWellUl: 0.3,
      reversePrimerPerWellUl: 0.5,
      primerStockConcentrationUm: 10,
      masterMixPerWellUl: 5,
      totalPerWellUl: 10,
      overagePercent: 10,
      geneMixPreparationMode: "eight-strip",
    },
  };

  const { XLSX, workbook } = await buildPlateWorkbook(
    { ...plate, name: "Main run / 主实验", confirmed: true },
    context,
  );

  assert.deepEqual(workbook.SheetNames, [
    "Plate_Map",
    "Well_Detail",
    "Gene_Requirements",
    "Gene_8Channel_Setup",
    "Sample_cDNA",
    "Total_Requirements",
    "Design_Summary",
    "Reaction_Setup",
  ]);
  assert.equal(workbook.Sheets.Total_Requirements.A4.v, "反应预混液 / Master mix");
  assert.equal(workbook.Sheets.Total_Requirements.B4.v, 480);
  assert.equal(workbook.Sheets.Total_Requirements.C4.v, 528);
  const geneRequirementRows = XLSX.utils.sheet_to_json<
    Array<string | number>
  >(workbook.Sheets.Gene_Requirements, { header: 1 });
  assert.deepEqual(geneRequirementRows[0], [
    "范围 / Scope",
    "基因 / Assay",
    "类型 / Type",
    "孔数 / Well count",
    "上游引物 / Forward primer (µL)",
    "下游引物 / Reverse primer (µL)",
    "预混液 / Master mix (µL)",
    "用水 / Water (µL)",
    "配液不含cDNA / Mix excluding cDNA (µL)",
    "完整反应体积 / Reaction total (µL)",
    "上游引物终浓度 / Forward primer final (nM)",
    "下游引物终浓度 / Reverse primer final (nM)",
  ]);
  assert.equal(workbook.Sheets.Gene_8Channel_Setup.A1.v, "状态 / Status");
  assert.equal(workbook.Sheets.Sample_cDNA.A1.v, "范围 / Scope");
  assert.equal(
    workbook.Sheets.Gene_Requirements.K1.v,
    "上游引物终浓度 / Forward primer final (nM)",
  );
  assert.equal(workbook.Sheets.Gene_Requirements.K2.v, 300);
  assert.equal(workbook.Sheets.Gene_Requirements.L2.v, 500);
  assert.equal(workbook.Sheets.Well_Detail.A1.v, "孔板名称 / Plate name");
  assert.equal(workbook.Sheets.Well_Detail.B1.v, "孔板编号 / Plate number");
  assert.match(workbook.Sheets.Plate_Map.A1.v, /Main run \/ 主实验 \(Plate 01\)/);

  const summaryRows = XLSX.utils.sheet_to_json<Array<string | number>>(
    workbook.Sheets.Design_Summary,
    { header: 1 },
  );
  assert.ok(
    summaryRows.some(
      (row) =>
        row[0] === "特别说明 / Special note" &&
        String(row[1]).includes("Controls are not added automatically"),
    ),
  );
  assert.ok(
    summaryRows.some(
      (row) =>
        row[0] ===
          "引物液浓度（实际移取）/ Primer solution used" &&
        row[1] === "10 µM",
    ),
  );
  assert.ok(
    summaryRows.some(
      (row) =>
        row[0] ===
          "上/下游引物终浓度 / Forward/reverse primer final" &&
        row[1] === "F 300 nM; R 500 nM",
    ),
  );

  const reactionRows = XLSX.utils.sheet_to_json<Array<string | number>>(
    workbook.Sheets.Reaction_Setup,
    { header: 1 },
  );
  assert.ok(
    reactionRows.some(
      (row) =>
        row[0] ===
          "引物液浓度（实际移取）/ Primer solution used (µM)" &&
        row[1] === 10,
    ),
  );
  assert.ok(
    reactionRows.some(
      (row) =>
        row[0] === "上游引物终浓度 / Forward primer final (nM)" &&
        row[1] === 300,
    ),
  );
  assert.ok(
    reactionRows.some(
      (row) =>
        row[0] === "下游引物终浓度 / Reverse primer final (nM)" &&
        row[1] === 500,
    ),
  );
  assert.ok(
    summaryRows.some(
      (row) =>
        row[0] === "上样方式 / Loading pattern" &&
        row[1] === "连续孔位 / Sequential wells",
    ),
  );
  assert.ok(
    summaryRows.some(
      (row) =>
        row[0] === "填充方向 / Fill direction" &&
        row[1] === "纵向优先 / Vertical first",
    ),
  );

  const detailRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(
    workbook.Sheets.Well_Detail,
  );
  const occupiedDetail = detailRows.find((row) => row["样本 / Sample"] === "S1");
  assert.equal(
    occupiedDetail?.["上样批次 / Transfer pass"],
    "连续 / Sequential",
  );
  assert.equal(occupiedDetail?.["来源行 / Source row (A-H)"], "");
  assert.equal(
    occupiedDetail?.["八道样本组 / 8-channel sample group"],
    "",
  );

  const serialized = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
  const roundTripped = XLSX.read(serialized, { type: "buffer" });
  assert.deepEqual(roundTripped.SheetNames, workbook.SheetNames);
});

test("384-well interleaved export follows physical A-P rows and records both 8-channel passes", async () => {
  const occupiedWells = [
    { wellId: "A1", row: 0, column: 0, sample: "S1", gene: "G1" },
    { wellId: "C1", row: 2, column: 0, sample: "S2", gene: "G1" },
    { wellId: "O1", row: 14, column: 0, sample: "S8", gene: "G1" },
    { wellId: "B1", row: 1, column: 0, sample: "S9", gene: "G1" },
    { wellId: "D1", row: 3, column: 0, sample: "S10", gene: "G1" },
    { wellId: "P1", row: 15, column: 0, sample: "S16", gene: "G1" },
    { wellId: "A4", row: 0, column: 3, sample: "S1", gene: "G2" },
    {
      wellId: "A7",
      row: 0,
      column: 6,
      sample: "S1",
      gene: "G3",
      source: "manual" as const,
    },
  ].map((well) => ({
    ...well,
    geneType: "target" as const,
    replicateIndex: 1,
    source:
      "source" in well && well.source === "manual"
        ? ("manual" as const)
        : ("auto" as const),
  }));
  const plate = {
    plateNumber: 1,
    name: "384 interleaved",
    rows: 16,
    columns: 24,
    wells: occupiedWells,
    confirmed: true,
  };
  const context: ExportContext = {
    plateType: 384,
    loadingPattern: "interleaved-8-channel",
    replicates: 3,
    samples: Array.from({ length: 16 }, (_, index) => `S${index + 1}`),
    targetGenes: ["G1", "G2", "G3"],
    referenceGenes: [],
    strategyLabel: "按基因排列 / By assay",
    layoutStrategy: "gene-major",
    generatedAt: "2026-07-31 15:30:00",
    validationStatus: "Valid",
    splitSamples: 0,
    repeatedReferenceBlocks: 0,
    repeatedReferenceWells: 0,
    reactionSystem: {
      cdnaPerWellUl: 1,
      forwardPrimerPerWellUl: 0.4,
      reversePrimerPerWellUl: 0.4,
      primerStockConcentrationUm: 10,
      masterMixPerWellUl: 5,
      totalPerWellUl: 10,
      overagePercent: 10,
      geneMixPreparationMode: "eight-strip",
    },
  };

  const { XLSX, workbook } = await buildPlateWorkbook(plate, context);
  assert.deepEqual(workbook.SheetNames, [
    "Plate_Map",
    "Well_Detail",
    "Gene_Requirements",
    "Gene_8Channel_Setup",
    "Sample_cDNA",
    "Total_Requirements",
    "Design_Summary",
    "Reaction_Setup",
  ]);

  const mapSheet = workbook.Sheets.Plate_Map;
  assert.equal(mapSheet.A3.v, "A");
  assert.equal(mapSheet.A4.v, "B");
  assert.equal(mapSheet.A5.v, "C");
  assert.equal(mapSheet.A18.v, "P");
  assert.match(mapSheet.B3.v, /^S1\nG1/);
  assert.match(mapSheet.B4.v, /^S9\nG1/);
  assert.match(mapSheet.B5.v, /^S2\nG1/);

  const eightStripSheet = workbook.Sheets.Gene_8Channel_Setup;
  assert.equal(eightStripSheet.F1.v, "八连排源通道 / Source channel");
  assert.equal(eightStripSheet.D2.v, "G1");
  assert.equal(eightStripSheet.F2.v, "A");
  assert.equal(eightStripSheet.G2.v, "A/B");
  assert.equal(eightStripSheet.H2.v, 1);
  assert.equal(eightStripSheet.I2.v, 1);
  assert.equal(eightStripSheet.J2.v, 2);
  assert.equal(eightStripSheet.L2.v, 19.8);
  assert.equal(eightStripSheet.N2.v, 2);

  const detailRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(
    workbook.Sheets.Well_Detail,
  );
  const byWell = new Map(detailRows.map((row) => [row["孔位 / Well"], row]));
  const assertLoading = (
    wellId: string,
    transferPass: string,
    sourceRow: string,
    sampleGroup: number | string,
  ) => {
    const row = byWell.get(wellId);
    assert.equal(row?.["上样批次 / Transfer pass"], transferPass);
    assert.equal(row?.["来源行 / Source row (A-H)"], sourceRow);
    assert.equal(
      row?.["八道样本组 / 8-channel sample group"],
      sampleGroup,
    );
  };

  assertLoading("A1", "第 1 次 / Pass 1", "A", 1);
  assertLoading("C1", "第 1 次 / Pass 1", "B", 1);
  assertLoading("O1", "第 1 次 / Pass 1", "H", 1);
  assertLoading("B1", "第 2 次 / Pass 2", "A", 2);
  assertLoading("D1", "第 2 次 / Pass 2", "B", 2);
  assertLoading("P1", "第 2 次 / Pass 2", "H", 2);
  assertLoading("A4", "第 1 次 / Pass 1", "A", 1);
  assertLoading(
    "A7",
    "第 1 次 / Pass 1",
    "手动复核 / Review manual",
    "手动规划 / Manual planning",
  );

  const summaryRows = XLSX.utils.sheet_to_json<Array<string | number>>(
    workbook.Sheets.Design_Summary,
    { header: 1 },
  );
  assert.ok(
    summaryRows.some(
      (row) =>
        row[0] === "上样方式 / Loading pattern" &&
        row[1] ===
          "固定 9 mm 八道排枪隔行 / Interleaved rows (fixed 9 mm 8-channel)",
    ),
  );
  assert.ok(
    summaryRows.some(
      (row) =>
        row[0] === "上样行序 / Loading row order" &&
        String(row[1]).includes("A/C/E/G/I/K/M/O"),
    ),
  );
  assert.ok(
    summaryRows.some(
      (row) =>
        row[0] === "填充方向 / Fill direction" &&
        row[1] === "纵向优先 / Vertical first",
    ),
  );

  const sampleMajorExport = await buildPlateWorkbook(plate, {
    ...context,
    layoutStrategy: "sample-major",
    strategyLabel: "按样本排列 / By sample",
  });
  const sampleMajorDetails =
    sampleMajorExport.XLSX.utils.sheet_to_json<
      Record<string, string | number>
    >(sampleMajorExport.workbook.Sheets.Well_Detail);
  const sampleMajorA1 = sampleMajorDetails.find(
    (row) => row["孔位 / Well"] === "A1",
  );
  assert.equal(
    sampleMajorA1?.["来源行 / Source row (A-H)"],
    "手动复核 / Review manual",
  );

  const horizontalExport = await buildPlateWorkbook(plate, {
    ...context,
    fillDirection: "horizontal",
  });
  const horizontalSummaryRows = XLSX.utils.sheet_to_json<
    Array<string | number>
  >(horizontalExport.workbook.Sheets.Design_Summary, { header: 1 });
  assert.ok(
    horizontalSummaryRows.some(
      (row) =>
        row[0] === "填充方向 / Fill direction" &&
        row[1] === "横向优先 / Horizontal first",
    ),
  );
});

test("Blank wells use zero cDNA and replace template volume with water", async () => {
  const layout = planPlateLayout({
    plateType: 96,
    samples: Array.from({ length: 8 }, (_, index) => `S${index + 1}`),
    targetGenes: ["G1", "G2", "G3"],
    referenceGenes: ["R1"],
    replicates: 3,
  });
  const plate = layout.plates[0];
  const context: ExportContext = {
    plateType: 96,
    replicates: 3,
    samples: Array.from({ length: 8 }, (_, index) => `S${index + 1}`),
    blankSamples: ["S1"],
    targetGenes: ["G1", "G2", "G3"],
    referenceGenes: ["R1"],
    strategyLabel: "按样本分块 / Sample-major",
    generatedAt: "2026-07-31 12:00:00",
    validationStatus: "Advisory",
    splitSamples: 0,
    repeatedReferenceBlocks: 0,
    repeatedReferenceWells: 0,
    reactionSystem: {
      cdnaPerWellUl: 1,
      forwardPrimerPerWellUl: 0.4,
      reversePrimerPerWellUl: 0.4,
      primerStockConcentrationUm: 10,
      masterMixPerWellUl: 5,
      totalPerWellUl: 10,
      overagePercent: 10,
      geneMixPreparationMode: "eight-strip",
    },
  };

  const { XLSX, workbook } = await buildPlateWorkbook(
    { ...plate, name: "Blank check", confirmed: true },
    context,
  );
  const totalRows = XLSX.utils.sheet_to_json<Array<string | number>>(
    workbook.Sheets.Total_Requirements,
    { header: 1 },
  );
  const cdnaRow = totalRows.find(
    (row) => row[0] === "cDNA 模板 / cDNA template",
  );
  const waterRow = totalRows.find(
    (row) => row[0] === "无核酸酶水 / Nuclease-free water",
  );
  assert.deepEqual(cdnaRow, ["cDNA 模板 / cDNA template", 84, 92.4]);
  assert.deepEqual(waterRow, [
    "无核酸酶水 / Nuclease-free water",
    319.2,
    351.12,
  ]);

  const sampleRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(
    workbook.Sheets.Sample_cDNA,
  );
  const blankRow = sampleRows.find((row) => row["样本 / Sample"] === "S1");
  assert.equal(blankRow?.["样本类型 / Sample type"], "空白 / Blank");
  assert.equal(blankRow?.["理论 cDNA / Required cDNA (µL)"], 0);
  assert.equal(blankRow?.["建议准备 cDNA / Prepare cDNA (µL)"], 0);
  assert.equal(
    blankRow?.["理论替代补水 / Required replacement water (µL)"],
    12,
  );
  assert.equal(
    blankRow?.["建议替代补水 / Prepare replacement water (µL)"],
    13.2,
  );
});

test("single and batch plate filenames share the dated safe naming helper", () => {
  const plate = {
    plateNumber: 3,
    name: 'Day 1 / Run:*?"<>|',
    rows: 8,
    columns: 12,
    wells: [],
    confirmed: true,
  };
  const exportDate = new Date(2026, 6, 31, 13, 15, 41);
  assert.equal(
    plateWorkbookFilename(plate, { plateType: 96 }, exportDate),
    "qPCR_Plate_03_Day_1_Run_96well_20260731.xlsx",
  );
  assert.equal(
    overviewWorkbookFilename(exportDate),
    "qPCR_All_Plates_Overview_20260731.xlsx",
  );
});

test("comparison and bridge metadata are exported with actual bridge well usage", async () => {
  const samples = Array.from({ length: 17 }, (_, index) => `S${index + 1}`);
  const sampleDesigns = samples.map((name, index) => ({
    name,
    kind: "sample" as const,
    cellLine: "A549",
    comparisonGroup: "FBN2 knockdown",
    isBridge: index === 0,
  }));
  const layout = planPlateLayout({
    plateType: 96,
    samples,
    sampleDesigns,
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  });
  const context: ExportContext = {
    plateType: 96,
    replicates: 3,
    samples,
    sampleDesigns,
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    strategyLabel: "按基因排列 / By assay",
    layoutStrategy: "gene-major",
    generatedAt: "2026-08-23 12:00:00",
    validationStatus: "Valid",
    splitSamples: layout.metrics.splitSamples,
    repeatedReferenceBlocks: layout.metrics.repeatedReferenceBlocks,
    repeatedReferenceWells: layout.metrics.repeatedReferenceWells,
    reactionSystem: {
      cdnaPerWellUl: 1,
      forwardPrimerPerWellUl: 0.2,
      reversePrimerPerWellUl: 0.2,
      primerStockConcentrationUm: 10,
      masterMixPerWellUl: 5,
      totalPerWellUl: 10,
      overagePercent: 12,
      geneMixPreparationMode: "eight-strip",
    },
  };

  for (const plate of layout.plates) {
    const { XLSX, workbook } = await buildPlateWorkbook(
      { ...plate, confirmed: true },
      context,
    );
    const detailRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(
      workbook.Sheets.Well_Detail,
    );
    const bridgeDetail = detailRows.find(
      (row) => row["样本 / Sample"] === "S1",
    );
    assert.equal(bridgeDetail?.["细胞系 / Cell line"], "A549");
    assert.equal(
      bridgeDetail?.["比较组 / Comparison group"],
      "FBN2 knockdown",
    );
    assert.equal(bridgeDetail?.["桥接样本 / Bridge sample"], "是 / Yes");
    assert.match(
      String(bridgeDetail?.["跨板原因 / Cross-plate reason"]),
      /bridge/i,
    );

    const sampleRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(
      workbook.Sheets.Sample_cDNA,
    );
    const bridgeUsage = sampleRows.find(
      (row) => row["样本 / Sample"] === "S1",
    );
    const actualBridgeWells = plate.wells.filter(
      (well) => well.sample === "S1" && well.gene,
    ).length;
    assert.equal(bridgeUsage?.["孔数 / Well count"], actualBridgeWells);
    assert.equal(bridgeUsage?.["桥接样本 / Bridge sample"], "是 / Yes");

    const summaryRows = XLSX.utils.sheet_to_json<Array<string | number>>(
      workbook.Sheets.Design_Summary,
      { header: 1 },
    );
    assert.ok(
      summaryRows.some(
        (row) =>
          row[0] === "本板比较单元 / Comparison units on plate" &&
          String(row[1]).includes("A549 / FBN2 knockdown"),
      ),
    );
  }
});
