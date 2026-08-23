"use client";

import {
  calculateEightStripGeneMixRequirements,
  primerFinalConcentrationNm,
  type ReactionSystemInput,
} from "./reactionCalculator";
import type {
  LayoutFillDirection,
  LayoutStrategy,
  LoadingPattern,
} from "./platePlanner";

export type GeneType = "target" | "reference";
export type LayoutSource = "auto" | "manual";

export interface ExportableWell {
  wellId: string;
  row: number;
  column: number;
  sample: string | null;
  gene: string | null;
  geneType: GeneType | null;
  replicateIndex: number | null;
  source: LayoutSource;
  cellLine?: string;
  comparisonGroup?: string;
  isBridge?: boolean;
  crossPlateReason?: string;
}

export interface ExportSampleDesign {
  name: string;
  kind?: "sample" | "blank";
  cellLine?: string;
  comparisonGroup?: string;
  isBridge?: boolean;
}

export interface ExportablePlate {
  plateNumber: number;
  /** User-editable display name. plateNumber remains the immutable identifier. */
  name?: string;
  rows: number;
  columns: number;
  wells: ExportableWell[];
  confirmed: boolean;
}

export interface ExportContext {
  plateType: 96 | 384;
  /** Physical loading route used to place samples into the destination plate. */
  loadingPattern?: LoadingPattern;
  fillDirection?: LayoutFillDirection;
  layoutStrategy?: LayoutStrategy;
  replicates: number;
  samples: string[];
  targetGenes: string[];
  referenceGenes: string[];
  strategyLabel: string;
  generatedAt: string;
  validationStatus: string;
  splitSamples: number;
  repeatedReferenceBlocks: number;
  repeatedReferenceWells: number;
  reactionSystem: ReactionSystemInput;
  /** Samples marked as Blank use water instead of cDNA template. */
  blankSamples?: string[];
  /** Optional comparison metadata used by strict group-aware allocation. */
  sampleDesigns?: ExportSampleDesign[];
}

const TARGET_FILLS = [
  "DDE8F2",
  "DCEBE8",
  "E4E2EF",
  "DCE7F0",
  "E1E9E3",
  "E3E5EC",
];

export const PLATE_WORKBOOK_SHEET_ORDER = [
  "Plate_Map",
  "Well_Detail",
  "Gene_Requirements",
  "Gene_8Channel_Setup",
  "Sample_cDNA",
  "Total_Requirements",
  "Design_Summary",
  "Reaction_Setup",
] as const;

const thinBorder = {
  style: "thin",
  color: { rgb: "D8D7D0" },
};

function safeDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function safeFilePart(value: string) {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._\s]+|[._\s]+$/g, "")
    .slice(0, 60);
  if (!cleaned || cleaned === "." || cleaned === "..") return "Untitled";
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(cleaned)
    ? `_${cleaned}`
    : cleaned;
}

function defaultPlateName(plateNumber: number) {
  return `Plate ${String(plateNumber).padStart(2, "0")}`;
}

function plateName(plate: ExportablePlate) {
  return plate.name?.trim() || defaultPlateName(plate.plateNumber);
}

function plateScopeLabel(plate: ExportablePlate) {
  const immutableLabel = defaultPlateName(plate.plateNumber);
  const customName = plateName(plate);
  return customName.toLocaleLowerCase() === immutableLabel.toLocaleLowerCase()
    ? immutableLabel
    : `${customName} (${immutableLabel})`;
}

export function plateWorkbookFilename(
  plate: ExportablePlate,
  context: Pick<ExportContext, "plateType">,
  date = new Date(),
) {
  const immutablePart = `Plate_${String(plate.plateNumber).padStart(2, "0")}`;
  const customName = plateName(plate);
  const defaultName = defaultPlateName(plate.plateNumber);
  const customPart =
    customName.toLocaleLowerCase() === defaultName.toLocaleLowerCase()
      ? ""
      : `_${safeFilePart(customName)}`;
  return `qPCR_${immutablePart}${customPart}_${context.plateType}well_${safeDateStamp(date)}.xlsx`;
}

export function overviewWorkbookFilename(date = new Date()) {
  return `qPCR_All_Plates_Overview_${safeDateStamp(date)}.xlsx`;
}

function rowLabel(index: number) {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function targetFill(gene: string, context: ExportContext) {
  const index = Math.max(0, context.targetGenes.indexOf(gene));
  return TARGET_FILLS[index % TARGET_FILLS.length];
}

function wellFill(well: ExportableWell, context: ExportContext) {
  if (!well.gene || !well.geneType) return "F7F6F2";
  if (well.geneType === "reference") return "F3DFC4";
  return targetFill(well.gene, context);
}

function roundedVolume(value: number) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function loadingPatternLabel(context: ExportContext) {
  return context.plateType === 384 &&
    context.loadingPattern === "interleaved-8-channel"
    ? "固定 9 mm 八道排枪隔行 / Interleaved rows (fixed 9 mm 8-channel)"
    : "连续孔位 / Sequential wells";
}

function hasFixedSourcePlateMapping(context: ExportContext) {
  return (
    context.plateType === 384 &&
    context.loadingPattern === "interleaved-8-channel" &&
    (context.fillDirection ?? "vertical") === "vertical" &&
    (context.layoutStrategy === "gene-major" ||
      (context.layoutStrategy === undefined &&
        /按基因|By assay/iu.test(context.strategyLabel)))
  );
}

function sourcePlateMappingLabel(context: ExportContext) {
  if (
    context.plateType !== 384 ||
    context.loadingPattern !== "interleaved-8-channel"
  ) {
    return "不适用 / Not applicable";
  }
  if (!hasFixedSourcePlateMapping(context)) {
    return (context.fillDirection ?? "vertical") === "horizontal"
      ? "横向优先不生成可直接执行的固定 A–H 来源板映射，请人工规划。 / Horizontal-first layout does not provide a direct fixed A–H source-plate map; plan it manually."
      : "按样本排列不生成可直接执行的固定 A–H 来源板映射，请人工规划。 / Sample-major layout does not provide a direct fixed A–H source-plate map; plan it manually.";
  }
  return "样本按输入顺序每 8 个组成一个来源八道组；同一样本在所有基因中保持同一 A–H 来源行。手动修改孔需复核。 / Every 8 input-order samples form one source group; each sample keeps the same A–H source row across assays. Review manual wells.";
}

function wellLoadingMetadata(
  well: ExportableWell,
  context: ExportContext,
) {
  if (!well.sample || !well.gene) {
    return {
      transferPass: "",
      sourceRow: "",
      sampleGroup: "",
    };
  }

  if (
    context.plateType !== 384 ||
    context.loadingPattern !== "interleaved-8-channel"
  ) {
    return {
      transferPass: "连续 / Sequential",
      sourceRow: "",
      sampleGroup: "",
    };
  }

  const sampleIndex = context.samples.indexOf(well.sample);
  const positionWithinBand =
    sampleIndex >= 0 ? sampleIndex % 16 : -1;
  const expectedDestinationRow =
    positionWithinBand < 0
      ? -1
      : positionWithinBand < 8
        ? positionWithinBand * 2
        : (positionWithinBand - 8) * 2 + 1;
  const mappingNeedsReview =
    !hasFixedSourcePlateMapping(context) ||
    well.source === "manual" ||
    sampleIndex < 0 ||
    well.row !== expectedDestinationRow;

  if (mappingNeedsReview) {
    return {
      transferPass: `第 ${(well.row % 2) + 1} 次 / Pass ${(well.row % 2) + 1}`,
      sourceRow: "手动复核 / Review manual",
      sampleGroup: "手动规划 / Manual planning",
    };
  }

  const transferPass = positionWithinBand < 8 ? 1 : 2;
  return {
    transferPass: `第 ${transferPass} 次 / Pass ${transferPass}`,
    sourceRow: rowLabel(sampleIndex % 8),
    sampleGroup: Math.floor(sampleIndex / 8) + 1,
  };
}

function appendReactionSheets(
  XLSX: typeof import("xlsx-js-style"),
  workbook: import("xlsx-js-style").WorkBook,
  plates: ExportablePlate[],
  context: ExportContext,
  scope: string,
) {
  const occupied = plates.flatMap((plate) =>
    plate.wells.filter((well) => well.sample && well.gene),
  );
  const blankSampleSet = new Set(context.blankSamples ?? []);
  const sampleDesignMap = new Map(
    (context.sampleDesigns ?? []).map((sample) => [
      sample.name.trim().toLocaleLowerCase(),
      sample,
    ]),
  );
  const blankWells = occupied.filter(
    (well) => well.sample && blankSampleSet.has(well.sample),
  );
  const templateWells = occupied.length - blankWells.length;
  const factor = 1 + context.reactionSystem.overagePercent / 100;
  const forwardPerWell = context.reactionSystem.forwardPrimerPerWellUl;
  const reversePerWell = context.reactionSystem.reversePrimerPerWellUl;
  const primerPairPerWell = forwardPerWell + reversePerWell;
  const forwardFinalNm = primerFinalConcentrationNm(
    context.reactionSystem.primerStockConcentrationUm,
    forwardPerWell,
    context.reactionSystem.totalPerWellUl,
  );
  const reverseFinalNm = primerFinalConcentrationNm(
    context.reactionSystem.primerStockConcentrationUm,
    reversePerWell,
    context.reactionSystem.totalPerWellUl,
  );
  const sampleWaterPerWell = Math.max(
    0,
    context.reactionSystem.totalPerWellUl -
      context.reactionSystem.masterMixPerWellUl -
      primerPairPerWell -
      context.reactionSystem.cdnaPerWellUl,
  );
  const blankWaterPerWell =
    sampleWaterPerWell + context.reactionSystem.cdnaPerWellUl;
  const perWellRows = [
    ["范围 / Scope", scope, ""],
    [
      "组分 / Component",
      "样本孔 / Sample well (µL)",
      "Blank 孔 / Blank well (µL)",
    ],
    [
      "SYBR Green 反应预混液 / Master mix",
      context.reactionSystem.masterMixPerWellUl,
      context.reactionSystem.masterMixPerWellUl,
    ],
    ["上游引物 / Forward primer", forwardPerWell, forwardPerWell],
    ["下游引物 / Reverse primer", reversePerWell, reversePerWell],
    [
      "引物液浓度（实际移取）/ Primer solution used (µM)",
      context.reactionSystem.primerStockConcentrationUm,
      context.reactionSystem.primerStockConcentrationUm,
    ],
    [
      "上游引物终浓度 / Forward primer final (nM)",
      roundedVolume(forwardFinalNm),
      roundedVolume(forwardFinalNm),
    ],
    [
      "下游引物终浓度 / Reverse primer final (nM)",
      roundedVolume(reverseFinalNm),
      roundedVolume(reverseFinalNm),
    ],
    [
      "cDNA 模板 / cDNA template",
      context.reactionSystem.cdnaPerWellUl,
      0,
    ],
    [
      "RNase-free ddH2O / Nuclease-free water",
      sampleWaterPerWell,
      blankWaterPerWell,
    ],
    [
      "总体积 / Total volume",
      context.reactionSystem.totalPerWellUl,
      context.reactionSystem.totalPerWellUl,
    ],
    [
      "实际反应孔 / Occupied wells",
      `${templateWells} 样本孔 / sample wells`,
      `${blankWells.length} Blank 孔 / Blank wells`,
    ],
    [
      "配液余量 / Pipetting overage",
      `${context.reactionSystem.overagePercent}%`,
      `${context.reactionSystem.overagePercent}%`,
    ],
    [
      "前提 / Assumption",
      `上、下游引物使用相同浓度的实际移取液，体积分别填写；当前终浓度分别为 ${roundedVolume(forwardFinalNm)} nM 和 ${roundedVolume(reverseFinalNm)} nM。未输入 cDNA 浓度，不能换算原始 RNA 量。 / Forward and reverse primers use the same pipetted-solution concentration and their volumes are entered separately; current final concentrations are ${roundedVolume(forwardFinalNm)} nM and ${roundedVolume(reverseFinalNm)} nM. cDNA concentration is not entered.`,
      "Blank 孔不加 cDNA，并以等体积 RNase-free ddH2O 补足。 / Blank wells omit cDNA and replace it with the same volume of RNase-free water.",
    ],
  ];
  const reactionSheet = XLSX.utils.aoa_to_sheet(perWellRows);
  reactionSheet["!cols"] = [{ wch: 48 }, { wch: 62 }, { wch: 62 }];

  const recommendedReactions = occupied.length * factor;
  const theoreticalWater =
    occupied.length * sampleWaterPerWell +
    blankWells.length * context.reactionSystem.cdnaPerWellUl;
  const totalRows = [
    ["范围 / Scope", scope, ""],
    [
      "项目 / Requirement",
      "理论需要 / Required (µL)",
      `建议准备 / Prepare +${context.reactionSystem.overagePercent}% (µL)`,
    ],
    [
      "反应总体积 / Total reaction volume",
      roundedVolume(occupied.length * context.reactionSystem.totalPerWellUl),
      roundedVolume(
        recommendedReactions * context.reactionSystem.totalPerWellUl,
      ),
    ],
    [
      "反应预混液 / Master mix",
      roundedVolume(
        occupied.length * context.reactionSystem.masterMixPerWellUl,
      ),
      roundedVolume(
        recommendedReactions * context.reactionSystem.masterMixPerWellUl,
      ),
    ],
    [
      "上游引物 / Forward primer",
      roundedVolume(occupied.length * forwardPerWell),
      roundedVolume(recommendedReactions * forwardPerWell),
    ],
    [
      "下游引物 / Reverse primer",
      roundedVolume(occupied.length * reversePerWell),
      roundedVolume(recommendedReactions * reversePerWell),
    ],
    [
      "引物总体积（仅汇总，分别准备）/ Primer total (summary only; prepare separately)",
      roundedVolume(
        occupied.length * primerPairPerWell,
      ),
      roundedVolume(
        recommendedReactions * primerPairPerWell,
      ),
    ],
    [
      "cDNA 模板 / cDNA template",
      roundedVolume(
        templateWells * context.reactionSystem.cdnaPerWellUl,
      ),
      roundedVolume(
        templateWells *
          factor *
          context.reactionSystem.cdnaPerWellUl,
      ),
    ],
    [
      "无核酸酶水 / Nuclease-free water",
      roundedVolume(theoreticalWater),
      roundedVolume(theoreticalWater * factor),
    ],
  ];
  const totalSheet = XLSX.utils.aoa_to_sheet(totalRows);
  totalSheet["!cols"] = [{ wch: 48 }, { wch: 28 }, { wch: 32 }];

  const geneCounts = new Map<
    string,
    { count: number; blankCount: number; geneType: string }
  >();
  const sampleCounts = new Map<string, number>();
  for (const well of occupied) {
    if (well.gene) {
      const current = geneCounts.get(well.gene) ?? {
        count: 0,
        blankCount: 0,
        geneType:
          well.geneType === "reference" ? "Reference" : "Target",
      };
      current.count += 1;
      if (well.sample && blankSampleSet.has(well.sample)) {
        current.blankCount += 1;
      }
      geneCounts.set(well.gene, current);
    }
    if (well.sample) {
      sampleCounts.set(
        well.sample,
        (sampleCounts.get(well.sample) ?? 0) + 1,
      );
    }
  }
  const geneRows = Array.from(geneCounts.entries()).map(
    ([gene, item]) => {
      const prepareReactions = item.count * factor;
      return {
        "范围 / Scope": scope,
        "基因 / Assay": gene,
        "类型 / Type":
          item.geneType === "Reference"
            ? "内参 / Reference"
            : "目的 / Target",
        "孔数 / Well count": item.count,
        "上游引物 / Forward primer (µL)": roundedVolume(
          prepareReactions * forwardPerWell,
        ),
        "下游引物 / Reverse primer (µL)": roundedVolume(
          prepareReactions * reversePerWell,
        ),
        "预混液 / Master mix (µL)": roundedVolume(
          prepareReactions *
            context.reactionSystem.masterMixPerWellUl,
        ),
        "用水 / Water (µL)": roundedVolume(
          (item.count * sampleWaterPerWell +
            item.blankCount * context.reactionSystem.cdnaPerWellUl) *
            factor,
        ),
        "配液不含cDNA / Mix excluding cDNA (µL)": roundedVolume(
          (item.count *
            (context.reactionSystem.masterMixPerWellUl +
              primerPairPerWell +
              sampleWaterPerWell) +
            item.blankCount * context.reactionSystem.cdnaPerWellUl) *
            factor,
        ),
        "完整反应体积 / Reaction total (µL)": roundedVolume(
          prepareReactions * context.reactionSystem.totalPerWellUl,
        ),
        "上游引物终浓度 / Forward primer final (nM)":
          roundedVolume(forwardFinalNm),
        "下游引物终浓度 / Reverse primer final (nM)":
          roundedVolume(reverseFinalNm),
      };
    },
  );
  const geneSheet = XLSX.utils.json_to_sheet(geneRows);
  geneSheet["!cols"] = [
    { wch: 24 },
    { wch: 22 },
    { wch: 14 },
    { wch: 12 },
    ...Array.from({ length: 8 }, () => ({ wch: 22 })),
  ];

  const sampleRows = Array.from(sampleCounts.entries()).map(
    ([sample, wellCount]) => {
      const isBlank = blankSampleSet.has(sample);
      const design = sampleDesignMap.get(sample.trim().toLocaleLowerCase());
      const theoretical = isBlank
        ? 0
        : wellCount * context.reactionSystem.cdnaPerWellUl;
      const replacementWater = isBlank
        ? wellCount * context.reactionSystem.cdnaPerWellUl
        : 0;
      return {
        "范围 / Scope": scope,
        "样本 / Sample": sample,
        "样本类型 / Sample type": isBlank
          ? "空白 / Blank"
          : "样本 / Sample",
        "细胞系 / Cell line": design?.cellLine ?? "",
        "比较组 / Comparison group": design?.comparisonGroup ?? "",
        "桥接样本 / Bridge sample": design?.isBridge ? "是 / Yes" : "否 / No",
        "孔数 / Well count": wellCount,
        "理论 cDNA / Required cDNA (µL)": roundedVolume(theoretical),
        "建议准备 cDNA / Prepare cDNA (µL)": roundedVolume(
          theoretical * factor,
        ),
        "理论替代补水 / Required replacement water (µL)":
          roundedVolume(replacementWater),
        "建议替代补水 / Prepare replacement water (µL)":
          roundedVolume(replacementWater * factor),
      };
    },
  );
  const sampleSheet = XLSX.utils.json_to_sheet(sampleRows);
  sampleSheet["!cols"] = [
    { wch: 24 },
    { wch: 28 },
    { wch: 20 },
    { wch: 20 },
    { wch: 22 },
    { wch: 18 },
    { wch: 14 },
    { wch: 24 },
    { wch: 22 },
    { wch: 32 },
    { wch: 31 },
  ];

  const eightStripRequirements = calculateEightStripGeneMixRequirements(
    plates,
    context.loadingPattern ?? "sequential",
    context.reactionSystem,
    context.blankSamples,
  );
  const eightStripRows = eightStripRequirements.flatMap((requirement) =>
    requirement.channels.map((channel) => ({
      "范围 / Scope": scope,
      "孔板名称 / Plate name": requirement.plateName,
      "孔板编号 / Plate number": requirement.plateNumber,
      "基因 / Assay": requirement.gene,
      "类型 / Type":
        requirement.geneType === "reference"
          ? "内参 / Reference"
          : "目的 / Target",
      "八连排源通道 / Source channel": channel.channel,
      "目标板行 / Destination rows": channel.destinationRows,
      "第1次上样孔 / Pass 1 wells": channel.pass1WellCount,
      "第2次上样孔 / Pass 2 wells": channel.pass2WellCount,
      "总孔数 / Total wells": channel.wellCount,
      "Blank 孔 / Blank wells": channel.blankWellCount,
      "本管基因混合液 / Assay mix in tube (µL)":
        roundedVolume(channel.assayMixUl),
      "Blank 替代水（另加）/ Blank replacement water, separate (µL)":
        roundedVolume(channel.blankReplacementWaterUl),
      "本基因排枪加液次数 / Multichannel dispenses for assay":
        requirement.transferCycles,
      "本基因混合液合计 / Assay-mix total (µL)":
        roundedVolume(requirement.totalAssayMixUl),
    })),
  );
  const eightStripSheet =
    eightStripRows.length > 0
      ? XLSX.utils.json_to_sheet(eightStripRows)
      : XLSX.utils.aoa_to_sheet([
          ["状态 / Status", "本方案未启用 384 孔 A–H 八连排 gene mix 分装。 / 384-well A–H 8-tube-strip assay-mix preparation is not enabled for this design."],
        ]);
  eightStripSheet["!cols"] = [
    { wch: 24 },
    { wch: 24 },
    { wch: 14 },
    { wch: 22 },
    { wch: 16 },
    { wch: 20 },
    { wch: 22 },
    { wch: 18 },
    { wch: 18 },
    { wch: 16 },
    { wch: 16 },
    { wch: 28 },
    { wch: 34 },
    { wch: 28 },
    { wch: 28 },
  ];

  XLSX.utils.book_append_sheet(workbook, reactionSheet, "Reaction_Setup");
  XLSX.utils.book_append_sheet(workbook, totalSheet, "Total_Requirements");
  XLSX.utils.book_append_sheet(workbook, geneSheet, "Gene_Requirements");
  XLSX.utils.book_append_sheet(
    workbook,
    eightStripSheet,
    "Gene_8Channel_Setup",
  );
  XLSX.utils.book_append_sheet(workbook, sampleSheet, "Sample_cDNA");
}

function triggerDownload(content: BlobPart, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function buildPlateWorkbook(
  plate: ExportablePlate,
  context: ExportContext,
) {
  const XLSX = (await import("xlsx-js-style")).default;
  const workbook = XLSX.utils.book_new();
  const wellMap = new Map(plate.wells.map((well) => [well.wellId, well]));
  const occupiedWells = plate.wells.filter(
    (well) => well.sample && well.gene,
  );
  const samplesOnPlate = Array.from(
    new Set(
      occupiedWells.flatMap((well) => (well.sample ? [well.sample] : [])),
    ),
  );
  const targetsOnPlate = Array.from(
    new Set(
      occupiedWells.flatMap((well) =>
        well.geneType === "target" && well.gene ? [well.gene] : [],
      ),
    ),
  );
  const referencesOnPlate = Array.from(
    new Set(
      occupiedWells.flatMap((well) =>
        well.geneType === "reference" && well.gene ? [well.gene] : [],
      ),
    ),
  );
  const sampleNameSet = new Set(
    samplesOnPlate.map((sample) => sample.trim().toLocaleLowerCase()),
  );
  const sampleDesignsOnPlate = (context.sampleDesigns ?? []).filter((sample) =>
    sampleNameSet.has(sample.name.trim().toLocaleLowerCase()),
  );
  const comparisonGroupsOnPlate = Array.from(
    new Set(
      sampleDesignsOnPlate.flatMap((sample) =>
        sample.cellLine?.trim() && sample.comparisonGroup?.trim()
          ? [`${sample.cellLine.trim()} / ${sample.comparisonGroup.trim()}`]
          : [],
      ),
    ),
  );
  const bridgeSamplesOnPlate = sampleDesignsOnPlate
    .filter((sample) => sample.isBridge)
    .map((sample) => sample.name);
  const crossPlateReasons = Array.from(
    new Set(
      occupiedWells.flatMap((well) =>
        well.crossPlateReason ? [well.crossPlateReason] : [],
      ),
    ),
  );
  const targetWells = occupiedWells.filter(
    (well) => well.geneType === "target",
  ).length;
  const referenceWells = occupiedWells.filter(
    (well) => well.geneType === "reference",
  ).length;
  const manualWells = plate.wells.filter(
    (well) => well.source === "manual",
  ).length;

  const mapRows: Array<Array<string | number>> = [
    [
      `${plateScopeLabel(plate)} · ${context.plateType} 孔板 / ${context.plateType}-well plate`,
    ],
    ["", ...Array.from({ length: plate.columns }, (_, index) => index + 1)],
  ];

  for (let row = 0; row < plate.rows; row += 1) {
    const rowValues: Array<string | number> = [rowLabel(row)];
    for (let column = 0; column < plate.columns; column += 1) {
      const wellId = `${rowLabel(row)}${column + 1}`;
      const well = wellMap.get(wellId);
      rowValues.push(
        well?.sample && well.gene
          ? `${well.sample}\n${well.gene}\nR${well.replicateIndex}/${context.replicates}`
          : "",
      );
    }
    mapRows.push(rowValues);
  }

  const mapSheet = XLSX.utils.aoa_to_sheet(mapRows);
  mapSheet["!merges"] = [
    {
      s: { r: 0, c: 0 },
      e: { r: 0, c: plate.columns },
    },
  ];
  mapSheet["!cols"] = [
    { wch: 5 },
    ...Array.from({ length: plate.columns }, () => ({
      wch: context.plateType === 384 ? 11 : 15,
    })),
  ];
  mapSheet["!rows"] = [
    { hpt: 30 },
    { hpt: 22 },
    ...Array.from({ length: plate.rows }, () => ({
      hpt: context.plateType === 384 ? 32 : 45,
    })),
  ];

  const titleCell = mapSheet.A1;
  if (titleCell) {
    titleCell.s = {
      font: { bold: true, color: { rgb: "FFFFFF" }, sz: 15 },
      fill: { fgColor: { rgb: "3D4A63" } },
      alignment: { horizontal: "left", vertical: "center" },
    };
  }

  for (let column = 0; column <= plate.columns; column += 1) {
    const address = XLSX.utils.encode_cell({ r: 1, c: column });
    const cell = mapSheet[address];
    if (cell) {
      cell.s = {
        font: { bold: true, color: { rgb: "5E5D57" } },
        fill: { fgColor: { rgb: "F0EFEA" } },
        alignment: { horizontal: "center", vertical: "center" },
        border: {
          top: thinBorder,
          bottom: thinBorder,
          left: thinBorder,
          right: thinBorder,
        },
      };
    }
  }

  for (let row = 0; row < plate.rows; row += 1) {
    const rowHeader = mapSheet[
      XLSX.utils.encode_cell({ r: row + 2, c: 0 })
    ];
    if (rowHeader) {
      rowHeader.s = {
        font: { bold: true, color: { rgb: "5E5D57" } },
        fill: { fgColor: { rgb: "F0EFEA" } },
        alignment: { horizontal: "center", vertical: "center" },
        border: {
          top: thinBorder,
          bottom: thinBorder,
          left: thinBorder,
          right: thinBorder,
        },
      };
    }

    for (let column = 0; column < plate.columns; column += 1) {
      const wellId = `${rowLabel(row)}${column + 1}`;
      const well = wellMap.get(wellId) ?? {
        wellId,
        row,
        column,
        sample: null,
        gene: null,
        geneType: null,
        replicateIndex: null,
        source: "auto" as const,
      };
      const address = XLSX.utils.encode_cell({
        r: row + 2,
        c: column + 1,
      });
      const cell = mapSheet[address] ?? { t: "s", v: "" };
      mapSheet[address] = cell;
      cell.s = {
        font: {
          color: { rgb: well.geneType === "reference" ? "754A1D" : "29465E" },
          sz: context.plateType === 384 ? 8 : 9,
        },
        fill: { fgColor: { rgb: wellFill(well, context) } },
        alignment: {
          horizontal: "center",
          vertical: "center",
          wrapText: true,
        },
        border: {
          top:
            well.source === "manual"
              ? { style: "medium", color: { rgb: "6D5BD0" } }
              : thinBorder,
          bottom:
            well.source === "manual"
              ? { style: "medium", color: { rgb: "6D5BD0" } }
              : thinBorder,
          left:
            well.source === "manual"
              ? { style: "medium", color: { rgb: "6D5BD0" } }
              : thinBorder,
          right:
            well.source === "manual"
              ? { style: "medium", color: { rgb: "6D5BD0" } }
              : thinBorder,
        },
      };
    }
  }

  const detailRows = plate.wells
    .slice()
    .sort((a, b) => a.row - b.row || a.column - b.column)
    .map((well) => {
      const loadingMetadata = wellLoadingMetadata(well, context);
      const sampleDesign = well.sample
        ? context.sampleDesigns?.find(
            (sample) =>
              sample.name.trim().toLocaleLowerCase() ===
              well.sample?.trim().toLocaleLowerCase(),
          )
        : undefined;
      return {
        "孔板名称 / Plate name": plateName(plate),
        "孔板编号 / Plate number": plate.plateNumber,
        "孔位 / Well": well.wellId,
        "行 / Row": rowLabel(well.row),
        "列 / Column": well.column + 1,
        "样本 / Sample": well.sample ?? "",
        "细胞系 / Cell line": well.cellLine ?? sampleDesign?.cellLine ?? "",
        "比较组 / Comparison group":
          well.comparisonGroup ?? sampleDesign?.comparisonGroup ?? "",
        "桥接样本 / Bridge sample":
          (well.isBridge ?? sampleDesign?.isBridge) ? "是 / Yes" : "否 / No",
        "跨板原因 / Cross-plate reason": well.crossPlateReason ?? "",
        "基因 / Assay": well.gene ?? "",
        "类型 / Assay type":
          well.geneType === "reference"
            ? "内参 / Reference"
            : well.geneType === "target"
              ? "目的 / Target"
              : "",
        "复孔序号 / Replicate": well.replicateIndex ?? "",
        "上样批次 / Transfer pass": loadingMetadata.transferPass,
        "来源行 / Source row (A-H)": loadingMetadata.sourceRow,
        "八道样本组 / 8-channel sample group":
          loadingMetadata.sampleGroup,
        "布局来源 / Layout source":
          well.source === "manual" ? "手动 / Manual" : "自动 / Auto",
        "校验状态 / Validation": context.validationStatus,
      };
    });
  const detailSheet = XLSX.utils.json_to_sheet(detailRows);
  detailSheet["!autofilter"] = {
    ref: `A1:R${Math.max(2, detailRows.length + 1)}`,
  };
  detailSheet["!cols"] = [
    { wch: 24 },
    { wch: 16 },
    { wch: 8 },
    { wch: 7 },
    { wch: 9 },
    { wch: 24 },
    { wch: 20 },
    { wch: 22 },
    { wch: 18 },
    { wch: 34 },
    { wch: 18 },
    { wch: 14 },
    { wch: 16 },
    { wch: 20 },
    { wch: 22 },
    { wch: 32 },
    { wch: 15 },
    { wch: 18 },
  ];

  const summaryRows = [
    ["字段 / Field", "值 / Value"],
    ["孔板名称 / Plate name", plateName(plate)],
    ["孔板编号 / Plate number", plate.plateNumber],
    ["孔板规格 / Plate format", `${context.plateType} 孔 / wells`],
    [
      "引物液浓度（实际移取）/ Primer solution used",
      `${context.reactionSystem.primerStockConcentrationUm} µM`,
    ],
    [
      "上/下游引物终浓度 / Forward/reverse primer final",
      `F ${roundedVolume(
        primerFinalConcentrationNm(
          context.reactionSystem.primerStockConcentrationUm,
          context.reactionSystem.forwardPrimerPerWellUl,
          context.reactionSystem.totalPerWellUl,
        ),
      )} nM; R ${roundedVolume(
        primerFinalConcentrationNm(
          context.reactionSystem.primerStockConcentrationUm,
          context.reactionSystem.reversePrimerPerWellUl,
          context.reactionSystem.totalPerWellUl,
        ),
      )} nM`,
    ],
    ["上样方式 / Loading pattern", loadingPatternLabel(context)],
    [
      "填充方向 / Fill direction",
      (context.fillDirection ?? "vertical") === "horizontal"
        ? "横向优先 / Horizontal first"
        : "纵向优先 / Vertical first",
    ],
    [
      "上样行序 / Loading row order",
      context.plateType === 384 &&
      context.loadingPattern === "interleaved-8-channel"
        ? "第 1 次 A/C/E/G/I/K/M/O；第 2 次 B/D/F/H/J/L/N/P / Pass 1 A/C/E/G/I/K/M/O; Pass 2 B/D/F/H/J/L/N/P"
        : `${context.plateType === 384 ? "A–P" : "A–H"} 连续物理行序 / Sequential physical row order`,
    ],
    [
      "基因反应混合液准备 / Assay-mix preparation",
      context.plateType === 384 &&
      context.loadingPattern === "interleaved-8-channel"
        ? context.reactionSystem.geneMixPreparationMode === "eight-strip"
          ? "A–H 八连排分装 / A–H 8-tube-strip aliquots"
          : "单管准备 / Single-tube preparation"
        : "不适用 / Not applicable",
    ],
    ["技术复孔 / Technical replicates", context.replicates],
    ["实验总样本数 / Total samples", context.samples.length],
    ["实验目的基因数 / Target assays", context.targetGenes.length],
    ["实验内参基因数 / Reference assays", context.referenceGenes.length],
    ["实验目的基因 / Target assay names", context.targetGenes.join(", ")],
    [
      "实验内参基因 / Reference assay names",
      context.referenceGenes.join(", "),
    ],
    ["本板样本数 / Samples on plate", samplesOnPlate.length],
    ["本板样本 / Sample names on plate", samplesOnPlate.join(", ")],
    [
      "本板比较单元 / Comparison units on plate",
      comparisonGroupsOnPlate.length > 0
        ? comparisonGroupsOnPlate.join(", ")
        : "未设置 / Not configured",
    ],
    [
      "本板桥接样本 / Bridge samples on plate",
      bridgeSamplesOnPlate.length > 0
        ? bridgeSamplesOnPlate.join(", ")
        : "无 / None",
    ],
    [
      "跨板原因 / Cross-plate reason",
      crossPlateReasons.length > 0
        ? crossPlateReasons.join("; ")
        : "无 / None",
    ],
    ["本板目的基因 / Targets on plate", targetsOnPlate.join(", ")],
    [
      "本板内参基因 / References on plate",
      referencesOnPlate.join(", "),
    ],
    ["本板目的基因孔 / Target wells", targetWells],
    ["本板内参孔 / Reference wells", referenceWells],
    ["本板手动修改孔 / Manual wells", manualWells],
    ["跨板样本数 / Split samples", context.splitSamples],
    [
      "重复内参复孔组 / Rerun reference blocks",
      context.repeatedReferenceBlocks,
    ],
    ["重复内参孔 / Rerun reference wells", context.repeatedReferenceWells],
    ["排布策略 / Layout strategy", context.strategyLabel],
    [
      "来源板映射 / Source-plate mapping",
      sourcePlateMappingLabel(context),
    ],
    [
      "复孔方向 / Replicate direction",
      "从左向右连续，不跨行 / Contiguous left-to-right, no row wrap",
    ],
    [
      "跨板规则 / Cross-plate rule",
      (context.sampleDesigns ?? []).some(
        (sample) => sample.cellLine && sample.comparisonGroup,
      )
        ? "比较单元（细胞系 × 比较组 × 单个目的基因）在可容纳时不可跨板；超大单元仅在指定桥接样本后拆分，且桥接样本在每块板重复目的基因及全部内参。 / A comparison unit (cell line × comparison group × one target) stays on one plate whenever feasible; oversized units split only with designated bridge samples, which repeat the target and all references on every plate."
        : "未设置比较组时沿用样本级规则：目的基因可跨板，但任何含该样本目的基因的板都必须重新安排该样本全部内参。 / Without comparison groups, legacy sample-level allocation applies: targets may span plates, but every plate containing a sample target must include all references for that sample.",
    ],
    [
      "确认状态 / Confirmation",
      plate.confirmed ? "已确认 / Confirmed" : "草稿 / Draft",
    ],
    ["校验状态 / Validation", context.validationStatus],
    ["生成时间 / Generated at", context.generatedAt],
    [
      "特别说明 / Special note",
      "本布局不自动添加 NTC、no-RT 或阳性模板控制；请另行核查熔解曲线、扩增效率和内参稳定性，并遵循本地 SOP。 / Controls are not added automatically; verify melt profiles, assay efficiency, reference stability, and the local SOP.",
    ],
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!cols"] = [{ wch: 22 }, { wch: 88 }];

  XLSX.utils.book_append_sheet(workbook, mapSheet, "Plate_Map");
  XLSX.utils.book_append_sheet(workbook, detailSheet, "Well_Detail");
  XLSX.utils.book_append_sheet(workbook, summarySheet, "Design_Summary");
  appendReactionSheets(
    XLSX,
    workbook,
    [plate],
    context,
    plateScopeLabel(plate),
  );
  workbook.SheetNames = [...PLATE_WORKBOOK_SHEET_ORDER];
  return { XLSX, workbook };
}

export async function exportPlateExcel(
  plate: ExportablePlate,
  context: ExportContext,
) {
  const { XLSX, workbook } = await buildPlateWorkbook(plate, context);
  const data = XLSX.write(workbook, {
    bookType: "xlsx",
    type: "array",
    compression: true,
  });
  const filename = plateWorkbookFilename(plate, context);
  triggerDownload(
    data,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filename,
  );
}

export async function exportAllPlateExcels(
  plates: ExportablePlate[],
  context: ExportContext,
) {
  const [JSZipModule, XLSXModule] = await Promise.all([
    import("jszip"),
    import("xlsx-js-style"),
  ]);
  const JSZip = JSZipModule.default;
  const XLSX = XLSXModule.default;
  const zip = new JSZip();
  const exportedAt = new Date();

  for (const plate of plates) {
    const { workbook } = await buildPlateWorkbook(plate, context);
    const data = XLSX.write(workbook, {
      bookType: "xlsx",
      type: "array",
      compression: true,
    });
    zip.file(
      plateWorkbookFilename(plate, context, exportedAt),
      data,
    );
  }

  const overviewRows = plates.map((plate) => {
    const occupied = plate.wells.filter(
      (well) => well.sample && well.gene,
    );
    const used = occupied.length;
    const samplesOnPlate = new Set(
      occupied.flatMap((well) => (well.sample ? [well.sample] : [])),
    );
    return {
      "孔板名称 / Plate name": plateName(plate),
      "孔板编号 / Plate number": plate.plateNumber,
      "上样方式 / Loading pattern": loadingPatternLabel(context),
      "本板样本数 / Samples on plate": samplesOnPlate.size,
      "已用孔 / Used wells": used,
      "目的基因孔 / Target wells": occupied.filter(
        (well) => well.geneType === "target",
      ).length,
      "内参孔 / Reference wells": occupied.filter(
        (well) => well.geneType === "reference",
      ).length,
      "手动孔 / Manual wells": plate.wells.filter(
        (well) => well.source === "manual",
      ).length,
      "空孔 / Empty wells": plate.rows * plate.columns - used,
      "利用率 / Utilization": used / (plate.rows * plate.columns),
      "已确认 / Confirmed": plate.confirmed ? "是 / Yes" : "否 / No",
      "校验状态 / Validation": context.validationStatus,
      "跨板样本 / Split samples": context.splitSamples,
      "重复内参复孔组 / Rerun reference blocks":
        context.repeatedReferenceBlocks,
      "重复内参孔 / Rerun reference wells":
        context.repeatedReferenceWells,
    };
  });
  const overviewBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    overviewBook,
    XLSX.utils.json_to_sheet(overviewRows),
    "Plate_Overview",
  );
  appendReactionSheets(
    XLSX,
    overviewBook,
    plates,
    context,
    "All plates / 全部孔板",
  );
  const overviewData = XLSX.write(overviewBook, {
    bookType: "xlsx",
    type: "array",
    compression: true,
  });
  zip.file(overviewWorkbookFilename(exportedAt), overviewData);

  const archive = await zip.generateAsync({ type: "blob" });
  triggerDownload(
    archive,
    "application/zip",
    `qPCR_plate_layout_${safeDateStamp(exportedAt)}.zip`,
  );
}
