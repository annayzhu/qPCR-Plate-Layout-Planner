export type PlateType = 96 | 384;
export type GeneType = "target" | "reference";
export type LayoutSource = "auto" | "manual";
export type LayoutStrategy = "sample-major" | "gene-major" | "hybrid";
export type LayoutPreset = Exclude<LayoutStrategy, "hybrid">;
export type LoadingPattern = "sequential" | "interleaved-8-channel";
export type LayoutFillDirection = "vertical" | "horizontal";

export interface PlanOptions {
  strategy?: LayoutPreset;
  loadingPattern?: LoadingPattern;
  fillDirection?: LayoutFillDirection;
}

export interface PlanInput {
  plateType: PlateType;
  samples: string[];
  sampleDesigns?: PlanSampleDesign[];
  targetGenes: string[];
  referenceGenes: string[];
  replicates: number;
}

export interface PlanSampleDesign {
  name: string;
  kind?: "sample" | "blank";
  cellLine?: string;
  comparisonGroup?: string;
  isBridge?: boolean;
}

export interface PlannerWell {
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

export interface PlannerPlate {
  id: string;
  plateNumber: number;
  name: string;
  rows: number;
  columns: number;
  sampleNames: string[];
  wells: PlannerWell[];
}

export interface PlanMetrics {
  plateCount: number;
  usedWells: number;
  emptyWells: number;
  utilization: number;
  sampleSwitches: number;
  primerSwitches: number;
  structuralEmptyWells: number;
  rowTailWells: number;
  samplesPerPlate: number;
  samplePlateAppearances: number;
  splitSamples: number;
  repeatedReferenceBlocks: number;
  repeatedReferenceWells: number;
  genePlateOccurrences: number;
}

export interface PlanResult {
  plates: PlannerPlate[];
  strategy: LayoutStrategy;
  loadingPattern: LoadingPattern;
  fillDirection: LayoutFillDirection;
  metrics: PlanMetrics;
  reason: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  plateNumber?: number;
  wellIds?: string[];
  severity?: "warning" | "high";
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

interface AssayBlock {
  sample: string;
  gene: string;
  geneType: GeneType;
}

interface TargetPair {
  sample: string;
  gene: string;
}

interface AllocationUnit {
  pairs: TargetPair[];
  sampleOrder: number;
  geneOrder: number;
  splitOrder: number;
}

interface PackedPlate {
  samples: Map<string, Set<string>>;
}

type SampleIndexMap = ReadonlyMap<string, number>;

interface LayoutCandidate {
  strategy: LayoutStrategy;
  packedPlates: PackedPlate[];
  plateSequences: AssayBlock[][];
  plateCount: number;
  samplePlateAppearances: number;
  splitSamples: number;
  repeatedReferenceBlocks: number;
  genePlateOccurrences: number;
  sampleSwitches: number;
  primerSwitches: number;
  stableRank: number;
}

export class PlatePlannerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PlatePlannerError";
    this.code = code;
  }
}

export function getPlateDimensions(plateType: PlateType) {
  if (plateType === 96) return { rows: 8, columns: 12 };
  if (plateType === 384) return { rows: 16, columns: 24 };
  throw new PlatePlannerError(
    "E_PLATE_TYPE",
    "仅支持 96 孔板或 384 孔板。 / Only 96- and 384-well plates are supported.",
  );
}

export const INTERLEAVED_384_ROW_ORDER = [
  0, 2, 4, 6, 8, 10, 12, 14, 1, 3, 5, 7, 9, 11, 13, 15,
] as const;

function resolveLoadingPattern(
  plateType: PlateType,
  requested?: LoadingPattern,
): LoadingPattern {
  if (plateType === 96) return "sequential";
  return requested === "sequential"
    ? "sequential"
    : "interleaved-8-channel";
}

function loadingRowOrder(rows: number, loadingPattern: LoadingPattern) {
  if (rows === 16 && loadingPattern === "interleaved-8-channel") {
    return [...INTERLEAVED_384_ROW_ORDER];
  }
  return Array.from({ length: rows }, (_, index) => index);
}

function sampleGlobalIndex(
  sample: string,
  sampleIndices: SampleIndexMap,
) {
  const index = sampleIndices.get(sample);
  if (index === undefined) {
    throw new PlatePlannerError(
      "E_INTERNAL_SAMPLE_INDEX",
      `样本“${sample}”缺少全局孔位索引。 / The sample is missing its global loading-slot index.`,
    );
  }
  return index;
}

export function formatWellId(row: number, column: number) {
  let rowNumber = row + 1;
  let rowLabel = "";
  while (rowNumber > 0) {
    const remainder = (rowNumber - 1) % 26;
    rowLabel = String.fromCharCode(65 + remainder) + rowLabel;
    rowNumber = Math.floor((rowNumber - 1) / 26);
  }
  return `${rowLabel}${column + 1}`;
}

export function defaultPlateName(plateNumber: number) {
  return `Plate ${String(plateNumber).padStart(2, "0")}`;
}

function normalized(values: string[], label: "sample" | "gene") {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  const seen = new Set<string>();
  for (const value of cleaned) {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) {
      throw new PlatePlannerError(
        `E_DUPLICATE_${label.toUpperCase()}`,
        `${label === "sample" ? "样本 / Sample" : "基因 / Assay"}名称“${value}”重复，请先合并或重命名。 / The name is duplicated; merge or rename it first.`,
      );
    }
    seen.add(key);
  }
  return cleaned;
}

function normalizedDesignText(value?: string) {
  return value?.trim() ?? "";
}

function comparisonKey(cellLine: string, comparisonGroup: string) {
  return `${cellLine.trim().toLocaleLowerCase()}\u0000${comparisonGroup
    .trim()
    .toLocaleLowerCase()}`;
}

function normalizeSampleDesigns(
  samples: string[],
  rawDesigns: PlanSampleDesign[] = [],
) {
  const sampleByKey = new Map(
    samples.map((sample) => [sample.toLocaleLowerCase(), sample]),
  );
  const supplied = new Map<string, PlanSampleDesign>();
  for (const raw of rawDesigns) {
    const key = raw.name.trim().toLocaleLowerCase();
    if (!sampleByKey.has(key)) {
      throw new PlatePlannerError(
        "E_UNKNOWN_SAMPLE_DESIGN",
        `样本设计信息中的“${raw.name}”不在样本列表中。 / Sample design metadata refers to an unknown sample.`,
      );
    }
    if (supplied.has(key)) {
      throw new PlatePlannerError(
        "E_DUPLICATE_SAMPLE_DESIGN",
        `样本“${raw.name}”的设计信息重复。 / Sample design metadata is duplicated.`,
      );
    }
    supplied.set(key, raw);
  }

  return samples.map((name) => {
    const raw = supplied.get(name.toLocaleLowerCase());
    const cellLine = normalizedDesignText(raw?.cellLine);
    const comparisonGroup = normalizedDesignText(raw?.comparisonGroup);
    const isBridge = Boolean(raw?.isBridge);
    const kind = raw?.kind ?? "sample";
    if (comparisonGroup && !cellLine) {
      throw new PlatePlannerError(
        "E_COMPARISON_GROUP_REQUIRES_CELL_LINE",
        `样本“${name}”设置比较组时必须同时填写细胞系。 / A comparison group requires a cell line.`,
      );
    }
    if (isBridge && !comparisonGroup) {
      throw new PlatePlannerError(
        "E_BRIDGE_REQUIRES_COMPARISON_GROUP",
        `样本“${name}”只有加入比较组后才能设为桥接样本。 / A bridge sample must belong to a comparison group.`,
      );
    }
    if (kind === "blank" && (cellLine || comparisonGroup || isBridge)) {
      throw new PlatePlannerError(
        "E_BLANK_COMPARISON_METADATA",
        `Blank“${name}”不能设置细胞系、比较组或桥接状态。 / A Blank cannot have cell-line, comparison-group, or bridge metadata.`,
      );
    }
    return {
      name,
      kind,
      cellLine,
      comparisonGroup,
      isBridge,
    } satisfies PlanSampleDesign;
  });
}

function validateInput(input: PlanInput) {
  const dimensions = getPlateDimensions(input.plateType);
  const samples = normalized(input.samples, "sample");
  const targetGenes = normalized(input.targetGenes, "gene");
  const referenceGenes = normalized(input.referenceGenes, "gene");
  const sampleDesigns = normalizeSampleDesigns(samples, input.sampleDesigns);

  if (samples.length === 0) {
    throw new PlatePlannerError(
      "E_NO_SAMPLE",
      "请至少添加 1 个样本。 / Add at least one sample.",
    );
  }
  if (targetGenes.length === 0) {
    throw new PlatePlannerError(
      "E_NO_TARGET",
      "请至少添加 1 个目的基因。 / Add at least one target assay.",
    );
  }
  if (referenceGenes.length === 0) {
    throw new PlatePlannerError(
      "E_NO_REFERENCE",
      "请至少将 1 个基因标记为内参基因。 / Mark at least one assay as a reference.",
    );
  }
  if (!Number.isInteger(input.replicates) || input.replicates < 1) {
    throw new PlatePlannerError(
      "E_REPLICATE_COUNT",
      "技术复孔数必须是正整数。 / Technical replicate count must be a positive integer.",
    );
  }
  if (input.replicates > dimensions.columns) {
    throw new PlatePlannerError(
      "E_REPLICATE_WIDER_THAN_ROW",
      `${input.plateType} 孔板每行只有 ${dimensions.columns} 孔，无法横向连续放置 ${input.replicates} 个复孔。 / A ${input.plateType}-well plate has ${dimensions.columns} columns per row, so ${input.replicates} contiguous replicates will not fit.`,
    );
  }

  const targetKeys = new Set(
    targetGenes.map((gene) => gene.toLocaleLowerCase()),
  );
  const roleConflict = referenceGenes.find((gene) =>
    targetKeys.has(gene.toLocaleLowerCase()),
  );
  if (roleConflict) {
    throw new PlatePlannerError(
      "E_GENE_ROLE_CONFLICT",
      `基因“${roleConflict}”不能同时作为目的基因和内参基因。 / An assay cannot be both target and reference.`,
    );
  }

  const blocksPerRow = Math.floor(dimensions.columns / input.replicates);
  const blockCapacity = dimensions.rows * blocksPerRow;
  if (referenceGenes.length + 1 > blockCapacity) {
    throw new PlatePlannerError(
      "E_REFERENCE_BUNDLE_TOO_LARGE",
      `每次安排一个目的基因时，都必须同时容纳 ${referenceGenes.length} 个内参复孔组；当前孔板最多容纳 ${blockCapacity} 个横向复孔组，无法形成有效的同板配对。 / The plate cannot hold one target block together with all ${referenceGenes.length} reference blocks for the same sample.`,
    );
  }

  return {
    ...input,
    samples,
    targetGenes,
    referenceGenes,
    sampleDesigns,
    dimensions,
    blocksPerRow,
    blockCapacity,
  };
}

function emptyPackedPlate(): PackedPlate {
  return { samples: new Map<string, Set<string>>() };
}

function packedLoad(plate: PackedPlate, referenceCount: number) {
  let targetBlocks = 0;
  for (const targets of plate.samples.values()) {
    targetBlocks += targets.size;
  }
  return targetBlocks + plate.samples.size * referenceCount;
}

function addTargetPair(plate: PackedPlate, pair: TargetPair) {
  const targets = plate.samples.get(pair.sample) ?? new Set<string>();
  targets.add(pair.gene);
  plate.samples.set(pair.sample, targets);
}

function packOrderedPairs(
  pairs: TargetPair[],
  blockCapacity: number,
  referenceCount: number,
): PackedPlate[] {
  const plates: PackedPlate[] = [];

  for (const pair of pairs) {
    let bestIndex = -1;
    let bestLoad = -1;

    for (let index = 0; index < plates.length; index += 1) {
      const plate = plates[index];
      const existingTargets = plate.samples.get(pair.sample);
      if (!existingTargets || existingTargets.has(pair.gene)) continue;
      const load = packedLoad(plate, referenceCount);
      if (load + 1 <= blockCapacity && load > bestLoad) {
        bestIndex = index;
        bestLoad = load;
      }
    }

    if (bestIndex < 0) {
      for (let index = 0; index < plates.length; index += 1) {
        const plate = plates[index];
        if (plate.samples.has(pair.sample)) continue;
        const load = packedLoad(plate, referenceCount);
        const cost = referenceCount + 1;
        if (load + cost <= blockCapacity && load > bestLoad) {
          bestIndex = index;
          bestLoad = load;
        }
      }
    }

    if (bestIndex < 0) {
      plates.push(emptyPackedPlate());
      bestIndex = plates.length - 1;
    }
    addTargetPair(plates[bestIndex], pair);
  }

  return plates;
}

function packWholeSamples(
  samples: string[],
  targetGenes: string[],
  blockCapacity: number,
  referenceCount: number,
): PackedPlate[] {
  const fullBundleSize = targetGenes.length + referenceCount;
  if (fullBundleSize > blockCapacity) {
    return packOrderedPairs(
      samples.flatMap((sample) =>
        targetGenes.map((gene) => ({ sample, gene })),
      ),
      blockCapacity,
      referenceCount,
    );
  }

  const plates: PackedPlate[] = [];
  for (const sample of samples) {
    let bestIndex = -1;
    let bestLoad = -1;
    for (let index = 0; index < plates.length; index += 1) {
      const load = packedLoad(plates[index], referenceCount);
      if (load + fullBundleSize <= blockCapacity && load > bestLoad) {
        bestIndex = index;
        bestLoad = load;
      }
    }
    if (bestIndex < 0) {
      plates.push(emptyPackedPlate());
      bestIndex = plates.length - 1;
    }
    plates[bestIndex].samples.set(sample, new Set(targetGenes));
  }
  return plates;
}

function geneBandLoad(
  plate: PackedPlate,
  referenceCount: number,
  rows: number,
  sampleIndices: SampleIndexMap,
) {
  if (plate.samples.size === 0) return 0;

  const referenceBands = new Set<number>();
  const targetBands = new Map<string, Set<number>>();
  for (const [sample, targets] of plate.samples) {
    const globalBand = Math.floor(
      sampleGlobalIndex(sample, sampleIndices) / rows,
    );
    referenceBands.add(globalBand);
    for (const gene of targets) {
      const bands = targetBands.get(gene) ?? new Set<number>();
      bands.add(globalBand);
      targetBands.set(gene, bands);
    }
  }

  const referenceBandCount = referenceCount * referenceBands.size;
  const targetBandCount = Array.from(targetBands.values()).reduce(
    (sum, bands) => sum + bands.size,
    0,
  );
  return referenceBandCount + targetBandCount;
}

function copyPackedPlate(plate: PackedPlate) {
  return {
    samples: new Map(
      Array.from(plate.samples, ([sample, targets]) => [
        sample,
        new Set(targets),
      ]),
    ),
  };
}

function geneBandLoadAfterPair(
  plate: PackedPlate,
  pair: TargetPair,
  referenceCount: number,
  rows: number,
  sampleIndices: SampleIndexMap,
) {
  const hypothetical = copyPackedPlate(plate);
  addTargetPair(hypothetical, pair);
  return geneBandLoad(
    hypothetical,
    referenceCount,
    rows,
    sampleIndices,
  );
}

function packOrderedPairsIntoGeneBands(
  pairs: TargetPair[],
  bandCapacity: number,
  referenceCount: number,
  rows: number,
  sampleIndices: SampleIndexMap,
): PackedPlate[] {
  const plates: PackedPlate[] = [];

  for (const pair of pairs) {
    let bestIndex = -1;
    let bestLoad = -1;

    for (let index = 0; index < plates.length; index += 1) {
      const existingTargets = plates[index].samples.get(pair.sample);
      if (!existingTargets || existingTargets.has(pair.gene)) continue;
      const nextLoad = geneBandLoadAfterPair(
        plates[index],
        pair,
        referenceCount,
        rows,
        sampleIndices,
      );
      if (nextLoad <= bandCapacity && nextLoad > bestLoad) {
        bestIndex = index;
        bestLoad = nextLoad;
      }
    }

    if (bestIndex < 0) {
      for (let index = 0; index < plates.length; index += 1) {
        if (plates[index].samples.has(pair.sample)) continue;
        const nextLoad = geneBandLoadAfterPair(
          plates[index],
          pair,
          referenceCount,
          rows,
          sampleIndices,
        );
        if (nextLoad <= bandCapacity && nextLoad > bestLoad) {
          bestIndex = index;
          bestLoad = nextLoad;
        }
      }
    }

    if (bestIndex < 0) {
      const newPlate = emptyPackedPlate();
      addTargetPair(newPlate, pair);
      if (
        geneBandLoad(
          newPlate,
          referenceCount,
          rows,
          sampleIndices,
        ) > bandCapacity
      ) {
        throw new PlatePlannerError(
          "E_INTERLEAVED_GENE_BUNDLE_TOO_LARGE",
          "当前复孔数与内参数量无法在 384 孔隔行上样的一个 16 行列块组中同时容纳目的基因和内参。 / The selected replicate count and references cannot fit one target-plus-reference bundle in an interleaved 384-well gene layout.",
        );
      }
      plates.push(newPlate);
      continue;
    }

    addTargetPair(plates[bestIndex], pair);
  }

  return plates;
}

function packWholeSamplesIntoGeneBands(
  samples: string[],
  targetGenes: string[],
  bandCapacity: number,
  referenceCount: number,
  rows: number,
  sampleIndices: SampleIndexMap,
): PackedPlate[] {
  if (targetGenes.length + referenceCount > bandCapacity) {
    return packOrderedPairsIntoGeneBands(
      sampleMajorPairs(samples, targetGenes),
      bandCapacity,
      referenceCount,
      rows,
      sampleIndices,
    );
  }

  const plates: PackedPlate[] = [];
  for (const sample of samples) {
    let bestIndex = -1;
    let bestLoad = -1;

    for (let index = 0; index < plates.length; index += 1) {
      const hypothetical = copyPackedPlate(plates[index]);
      hypothetical.samples.set(sample, new Set(targetGenes));
      const nextLoad = geneBandLoad(
        hypothetical,
        referenceCount,
        rows,
        sampleIndices,
      );
      if (nextLoad <= bandCapacity && nextLoad > bestLoad) {
        bestIndex = index;
        bestLoad = nextLoad;
      }
    }

    if (bestIndex < 0) {
      const newPlate = emptyPackedPlate();
      newPlate.samples.set(sample, new Set(targetGenes));
      plates.push(newPlate);
    } else {
      plates[bestIndex].samples.set(sample, new Set(targetGenes));
    }
  }
  return plates;
}

function packIntoPlateLimit(
  samples: string[],
  targetGenes: string[],
  plateLimit: number,
  blockCapacity: number,
  referenceCount: number,
): PackedPlate[] | null {
  const plates = Array.from(
    { length: plateLimit },
    () => emptyPackedPlate(),
  );

  for (const sample of samples) {
    const wholePlate = plates
      .map((plate, index) => ({
        index,
        load: packedLoad(plate, referenceCount),
      }))
      .filter(
        ({ index, load }) =>
          !plates[index].samples.has(sample) &&
          load + referenceCount + targetGenes.length <= blockCapacity,
      )
      .sort(
        (left, right) =>
          right.load - left.load || left.index - right.index,
      )[0];

    if (wholePlate) {
      plates[wholePlate.index].samples.set(
        sample,
        new Set(targetGenes),
      );
      continue;
    }

    const options = plates
      .map((plate, index) => {
        const load = packedLoad(plate, referenceCount);
        const availableTargets =
          blockCapacity - load - referenceCount;
        const targetUnion = new Set<string>();
        for (const targets of plate.samples.values()) {
          targets.forEach((gene) => targetUnion.add(gene));
        }
        return { index, availableTargets, targetUnion };
      })
      .filter((option) => option.availableTargets > 0)
      .sort(
        (left, right) =>
          right.availableTargets - left.availableTargets ||
          right.targetUnion.size - left.targetUnion.size ||
          left.index - right.index,
      );

    const selected: typeof options = [];
    let available = 0;
    for (const option of options) {
      selected.push(option);
      available += option.availableTargets;
      if (available >= targetGenes.length) break;
    }
    if (available < targetGenes.length) return null;

    const remainingGenes = new Set(targetGenes);
    selected.forEach((option, optionIndex) => {
      const remainingPlateCount = selected.length - optionIndex - 1;
      const count = Math.min(
        option.availableTargets,
        remainingGenes.size - remainingPlateCount,
      );
      const orderedGenes = Array.from(remainingGenes).sort(
        (left, right) =>
          Number(option.targetUnion.has(right)) -
            Number(option.targetUnion.has(left)) ||
          targetGenes.indexOf(left) - targetGenes.indexOf(right),
      );
      const chosen = orderedGenes.slice(0, count);
      plates[option.index].samples.set(sample, new Set(chosen));
      chosen.forEach((gene) => remainingGenes.delete(gene));
    });
    if (remainingGenes.size > 0) return null;
  }

  return plates.filter((plate) => plate.samples.size > 0);
}

function sampleMajorPairs(samples: string[], genes: string[]) {
  return samples.flatMap((sample) =>
    genes.map((gene) => ({ sample, gene })),
  );
}

function geneMajorPairs(samples: string[], genes: string[]) {
  return genes.flatMap((gene, geneIndex) => {
    const orderedSamples =
      geneIndex % 2 === 0 ? samples : samples.slice().reverse();
    return orderedSamples.map((sample) => ({ sample, gene }));
  });
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

function blockPairs(
  samples: string[],
  genes: string[],
  sampleChunkSize: number,
  geneChunkSize: number,
  orientation: "sample" | "gene",
) {
  const sampleChunks = chunks(samples, sampleChunkSize);
  const geneChunks = chunks(genes, geneChunkSize);
  const pairs: TargetPair[] = [];

  if (orientation === "sample") {
    sampleChunks.forEach((sampleChunk, sampleChunkIndex) => {
      geneChunks.forEach((geneChunk, geneChunkIndex) => {
        const orderedSamples =
          geneChunkIndex % 2 === 0
            ? sampleChunk
            : sampleChunk.slice().reverse();
        const orderedGenes =
          sampleChunkIndex % 2 === 0
            ? geneChunk
            : geneChunk.slice().reverse();
        orderedSamples.forEach((sample) => {
          orderedGenes.forEach((gene) => pairs.push({ sample, gene }));
        });
      });
    });
  } else {
    geneChunks.forEach((geneChunk, geneChunkIndex) => {
      sampleChunks.forEach((sampleChunk, sampleChunkIndex) => {
        const orderedGenes =
          sampleChunkIndex % 2 === 0
            ? geneChunk
            : geneChunk.slice().reverse();
        const orderedSamples =
          geneChunkIndex % 2 === 0
            ? sampleChunk
            : sampleChunk.slice().reverse();
        orderedGenes.forEach((gene) => {
          orderedSamples.forEach((sample) => pairs.push({ sample, gene }));
        });
      });
    });
  }

  return pairs;
}

function candidateChunkSizes(length: number) {
  const raw = [
    1,
    2,
    3,
    4,
    Math.ceil(length / 2),
    Math.ceil(length / 3),
    length,
  ];
  return Array.from(
    new Set(raw.filter((value) => value >= 1 && value <= length)),
  ).sort((left, right) => left - right);
}

function generateGeneBandPackings(
  samples: string[],
  targetGenes: string[],
  bandCapacity: number,
  referenceCount: number,
  rows: number,
) {
  const candidates: PackedPlate[][] = [];
  const signatures = new Set<string>();
  const sampleIndices = new Map(
    samples.map((sample, index) => [sample, index]),
  );
  const add = (plates: PackedPlate[]) => {
    const signature = packingSignature(plates);
    if (!signatures.has(signature)) {
      signatures.add(signature);
      candidates.push(plates);
    }
  };

  add(
    packWholeSamplesIntoGeneBands(
      samples,
      targetGenes,
      bandCapacity,
      referenceCount,
      rows,
      sampleIndices,
    ),
  );
  add(
    packOrderedPairsIntoGeneBands(
      sampleMajorPairs(samples, targetGenes),
      bandCapacity,
      referenceCount,
      rows,
      sampleIndices,
    ),
  );
  add(
    packOrderedPairsIntoGeneBands(
      geneMajorPairs(samples, targetGenes),
      bandCapacity,
      referenceCount,
      rows,
      sampleIndices,
    ),
  );

  const sampleSizes = candidateChunkSizes(samples.length);
  const geneSizes = candidateChunkSizes(targetGenes.length);
  for (const sampleSize of sampleSizes) {
    for (const geneSize of geneSizes) {
      add(
        packOrderedPairsIntoGeneBands(
          blockPairs(
            samples,
            targetGenes,
            sampleSize,
            geneSize,
            "sample",
          ),
          bandCapacity,
          referenceCount,
          rows,
          sampleIndices,
        ),
      );
      add(
        packOrderedPairsIntoGeneBands(
          blockPairs(
            samples,
            targetGenes,
            sampleSize,
            geneSize,
            "gene",
          ),
          bandCapacity,
          referenceCount,
          rows,
          sampleIndices,
        ),
      );
    }
  }

  return candidates;
}

function packingSignature(plates: PackedPlate[]) {
  return plates
    .map((plate) =>
      Array.from(plate.samples.entries())
        .map(
          ([sample, targets]) =>
            `${sample}:${Array.from(targets).sort().join(",")}`,
        )
        .sort()
        .join("|"),
    )
    .sort()
    .join("||");
}

function addPairsToPlate(plate: PackedPlate, pairs: readonly TargetPair[]) {
  for (const pair of pairs) addTargetPair(plate, pair);
}

function loadAfterPairs(
  plate: PackedPlate,
  pairs: readonly TargetPair[],
  load: (plate: PackedPlate) => number,
) {
  const hypothetical = copyPackedPlate(plate);
  addPairsToPlate(hypothetical, pairs);
  return load(hypothetical);
}

function packAllocationUnits(
  units: readonly AllocationUnit[],
  capacity: number,
  load: (plate: PackedPlate) => number,
) {
  const plates: PackedPlate[] = [];
  for (const unit of units) {
    let bestIndex = -1;
    let bestLoad = -1;
    for (let index = 0; index < plates.length; index += 1) {
      const nextLoad = loadAfterPairs(plates[index], unit.pairs, load);
      if (nextLoad <= capacity && nextLoad > bestLoad) {
        bestIndex = index;
        bestLoad = nextLoad;
      }
    }
    if (bestIndex < 0) {
      const plate = emptyPackedPlate();
      addPairsToPlate(plate, unit.pairs);
      if (load(plate) > capacity) {
        throw new PlatePlannerError(
          "E_INTERNAL_COMPARISON_UNIT_OVERFLOW",
          "比较组排板单元超出孔板容量。 / A comparison allocation unit exceeds plate capacity.",
        );
      }
      plates.push(plate);
    } else {
      addPairsToPlate(plates[bestIndex], unit.pairs);
    }
  }
  return plates;
}

function comparisonAllocationUnits(
  samples: string[],
  sampleDesigns: PlanSampleDesign[],
  targetGenes: string[],
  capacity: number,
  load: (plate: PackedPlate) => number,
  replicates: number,
) {
  const sampleIndex = new Map(
    samples.map((sample, index) => [sample, index]),
  );
  const grouped = new Map<string, PlanSampleDesign[]>();
  const ungrouped: PlanSampleDesign[] = [];
  for (const design of sampleDesigns) {
    if (!design.cellLine || !design.comparisonGroup) {
      ungrouped.push(design);
      continue;
    }
    const key = comparisonKey(design.cellLine, design.comparisonGroup);
    const members = grouped.get(key) ?? [];
    members.push(design);
    grouped.set(key, members);
  }

  const units: AllocationUnit[] = [];
  for (const members of grouped.values()) {
    const firstSampleOrder = Math.min(
      ...members.map((member) => sampleIndex.get(member.name) ?? 0),
    );
    targetGenes.forEach((gene, geneOrder) => {
      const fullPairs = members.map((member) => ({
        sample: member.name,
        gene,
      }));
      const requiredBlocks = loadAfterPairs(emptyPackedPlate(), fullPairs, load);
      if (requiredBlocks <= capacity) {
        units.push({
          pairs: fullPairs,
          sampleOrder: firstSampleOrder,
          geneOrder,
          splitOrder: 0,
        });
        return;
      }

      const bridgePairs = members
        .filter((member) => member.isBridge)
        .map((member) => ({ sample: member.name, gene }));
      if (bridgePairs.length === 0) {
        throw new PlatePlannerError(
          "E_COMPARISON_UNIT_TOO_LARGE",
          `比较组“${members[0].cellLine} / ${members[0].comparisonGroup}”检测 ${gene} 需要 ${requiredBlocks * replicates} 孔，单板当前最多可用 ${capacity * replicates} 孔；请指定桥接样本后显式跨板。 / The comparison unit needs ${requiredBlocks * replicates} wells but only ${capacity * replicates} are available; select a bridge sample to enable an explicit cross-plate design.`,
        );
      }
      if (loadAfterPairs(emptyPackedPlate(), bridgePairs, load) > capacity) {
        throw new PlatePlannerError(
          "E_BRIDGE_OVERHEAD_TOO_LARGE",
          `比较组“${members[0].cellLine} / ${members[0].comparisonGroup}”选择的桥接样本已超过单板容量。 / The selected bridge samples exceed single-plate capacity.`,
        );
      }

      const nonBridge = members.filter((member) => !member.isBridge);
      let currentPairs = [...bridgePairs];
      let splitOrder = 0;
      for (const member of nonBridge) {
        const nextPairs = [
          ...currentPairs,
          { sample: member.name, gene },
        ];
        if (loadAfterPairs(emptyPackedPlate(), nextPairs, load) <= capacity) {
          currentPairs = nextPairs;
          continue;
        }
        if (currentPairs.length === bridgePairs.length) {
          throw new PlatePlannerError(
            "E_BRIDGE_OVERHEAD_TOO_LARGE",
            `桥接样本与任一其他样本无法共同装入单板。 / Bridge overhead leaves no capacity for another sample.`,
          );
        }
        units.push({
          pairs: currentPairs,
          sampleOrder: firstSampleOrder,
          geneOrder,
          splitOrder,
        });
        splitOrder += 1;
        currentPairs = [
          ...bridgePairs,
          { sample: member.name, gene },
        ];
      }
      if (currentPairs.length > bridgePairs.length || nonBridge.length === 0) {
        units.push({
          pairs: currentPairs,
          sampleOrder: firstSampleOrder,
          geneOrder,
          splitOrder,
        });
      }
    });
  }

  for (const design of ungrouped) {
    targetGenes.forEach((gene, geneOrder) => {
      units.push({
        pairs: [{ sample: design.name, gene }],
        sampleOrder: sampleIndex.get(design.name) ?? 0,
        geneOrder,
        splitOrder: 0,
      });
    });
  }
  return units;
}

function generateComparisonPackings(
  samples: string[],
  sampleDesigns: PlanSampleDesign[],
  targetGenes: string[],
  capacity: number,
  load: (plate: PackedPlate) => number,
  replicates: number,
) {
  const units = comparisonAllocationUnits(
    samples,
    sampleDesigns,
    targetGenes,
    capacity,
    load,
    replicates,
  );
  const orders = [
    units.slice().sort(
      (left, right) =>
        left.sampleOrder - right.sampleOrder ||
        left.geneOrder - right.geneOrder ||
        left.splitOrder - right.splitOrder,
    ),
    units.slice().sort(
      (left, right) =>
        left.geneOrder - right.geneOrder ||
        left.sampleOrder - right.sampleOrder ||
        left.splitOrder - right.splitOrder,
    ),
    units.slice().sort((left, right) => {
      const leftLoad = loadAfterPairs(emptyPackedPlate(), left.pairs, load);
      const rightLoad = loadAfterPairs(emptyPackedPlate(), right.pairs, load);
      return (
        rightLoad - leftLoad ||
        left.geneOrder - right.geneOrder ||
        left.sampleOrder - right.sampleOrder
      );
    }),
  ];
  const seen = new Set<string>();
  return orders
    .map((order) => packAllocationUnits(order, capacity, load))
    .filter((plates) => {
      const signature = packingSignature(plates);
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
}

function generatePackings(
  samples: string[],
  targetGenes: string[],
  blockCapacity: number,
  referenceCount: number,
) {
  const candidates: PackedPlate[][] = [];
  const signatures = new Set<string>();
  const add = (plates: PackedPlate[]) => {
    const signature = packingSignature(plates);
    if (!signatures.has(signature)) {
      signatures.add(signature);
      candidates.push(plates);
    }
  };

  add(
    packWholeSamples(
      samples,
      targetGenes,
      blockCapacity,
      referenceCount,
    ),
  );
  add(
    packOrderedPairs(
      sampleMajorPairs(samples, targetGenes),
      blockCapacity,
      referenceCount,
    ),
  );
  add(
    packOrderedPairs(
      geneMajorPairs(samples, targetGenes),
      blockCapacity,
      referenceCount,
    ),
  );

  const sampleSizes = candidateChunkSizes(samples.length);
  const geneSizes = candidateChunkSizes(targetGenes.length);
  for (const sampleSize of sampleSizes) {
    for (const geneSize of geneSizes) {
      add(
        packOrderedPairs(
          blockPairs(
            samples,
            targetGenes,
            sampleSize,
            geneSize,
            "sample",
          ),
          blockCapacity,
          referenceCount,
        ),
      );
      add(
        packOrderedPairs(
          blockPairs(
            samples,
            targetGenes,
            sampleSize,
            geneSize,
            "gene",
          ),
          blockCapacity,
          referenceCount,
        ),
      );
    }
  }

  const currentMinimum = Math.min(
    ...candidates.map((plates) => plates.length),
  );
  const minimumAppearancesPerSample = Math.ceil(
    targetGenes.length / (blockCapacity - referenceCount),
  );
  const loadLowerBound = Math.ceil(
    (samples.length *
      (targetGenes.length +
        referenceCount * minimumAppearancesPerSample)) /
      blockCapacity,
  );
  const plateLowerBound = Math.max(
    minimumAppearancesPerSample,
    loadLowerBound,
  );
  const sampleOrders: string[][] = [
    samples,
    samples.slice().reverse(),
  ];
  const rotationCount = Math.min(samples.length, 12);
  for (let index = 1; index < rotationCount; index += 1) {
    const offset = Math.floor((index * samples.length) / rotationCount);
    sampleOrders.push([
      ...samples.slice(offset),
      ...samples.slice(0, offset),
    ]);
  }
  const geneOrders = [targetGenes, targetGenes.slice().reverse()];
  for (
    let plateLimit = plateLowerBound;
    plateLimit <= currentMinimum;
    plateLimit += 1
  ) {
    for (const sampleOrder of sampleOrders) {
      for (const orderedGenes of geneOrders) {
        const packing = packIntoPlateLimit(
          sampleOrder,
          orderedGenes,
          plateLimit,
          blockCapacity,
          referenceCount,
        );
        if (packing) add(packing);
      }
    }
  }
  return candidates;
}

function sampleOrderForPlate(
  plate: PackedPlate,
  inputSamples: string[],
) {
  return inputSamples.filter((sample) => plate.samples.has(sample));
}

function geneOrder(
  targetGenes: string[],
  referenceGenes: string[],
) {
  return [
    ...referenceGenes.map((gene) => ({
      gene,
      geneType: "reference" as const,
    })),
    ...targetGenes.map((gene) => ({
      gene,
      geneType: "target" as const,
    })),
  ];
}

function hasAssay(
  plate: PackedPlate,
  sample: string,
  gene: string,
  geneType: GeneType,
) {
  if (!plate.samples.has(sample)) return false;
  if (geneType === "reference") return true;
  return plate.samples.get(sample)?.has(gene) ?? false;
}

function sampleMajorSequence(
  plate: PackedPlate,
  samples: string[],
  genes: ReturnType<typeof geneOrder>,
) {
  const sequence: AssayBlock[] = [];
  const plateSamples = sampleOrderForPlate(plate, samples);
  plateSamples.forEach((sample) => {
    genes.forEach(({ gene, geneType }) => {
      if (hasAssay(plate, sample, gene, geneType)) {
        sequence.push({ sample, gene, geneType });
      }
    });
  });
  return sequence;
}

function geneMajorSequence(
  plate: PackedPlate,
  samples: string[],
  genes: ReturnType<typeof geneOrder>,
) {
  const sequence: AssayBlock[] = [];
  const plateSamples = sampleOrderForPlate(plate, samples);
  genes.forEach(({ gene, geneType }) => {
    plateSamples.forEach((sample) => {
      if (hasAssay(plate, sample, gene, geneType)) {
        sequence.push({ sample, gene, geneType });
      }
    });
  });
  return sequence;
}

function hybridSequence(
  plate: PackedPlate,
  samples: string[],
  genes: ReturnType<typeof geneOrder>,
) {
  const plateSamples = sampleOrderForPlate(plate, samples);
  if (plateSamples.length <= 1) {
    return sampleMajorSequence(plate, samples, genes);
  }
  const sampleChunks = chunks(
    plateSamples,
    Math.max(1, Math.ceil(plateSamples.length / 2)),
  );
  const sequence: AssayBlock[] = [];
  sampleChunks.forEach((sampleChunk, chunkIndex) => {
    const orderedGenes =
      chunkIndex % 2 === 0 ? genes : genes.slice().reverse();
    orderedGenes.forEach(({ gene, geneType }, geneIndex) => {
      const orderedSamples =
        geneIndex % 2 === 0 ? sampleChunk : sampleChunk.slice().reverse();
      orderedSamples.forEach((sample) => {
        if (hasAssay(plate, sample, gene, geneType)) {
          sequence.push({ sample, gene, geneType });
        }
      });
    });
  });
  return sequence;
}

function countSwitches(plateSequences: AssayBlock[][]) {
  let sampleSwitches = 0;
  let primerSwitches = 0;
  for (const sequence of plateSequences) {
    for (let index = 1; index < sequence.length; index += 1) {
      if (sequence[index].sample !== sequence[index - 1].sample) {
        sampleSwitches += 1;
      }
      if (sequence[index].gene !== sequence[index - 1].gene) {
        primerSwitches += 1;
      }
    }
  }
  return { sampleSwitches, primerSwitches };
}

function allocationMetrics(
  plates: PackedPlate[],
  samples: string[],
  targetGenes: string[],
  referenceCount: number,
) {
  const appearances = new Map(samples.map((sample) => [sample, 0]));
  let genePlateOccurrences = 0;

  for (const plate of plates) {
    const targetUnion = new Set<string>();
    for (const [sample, targets] of plate.samples) {
      appearances.set(sample, (appearances.get(sample) ?? 0) + 1);
      targets.forEach((gene) => targetUnion.add(gene));
    }
    genePlateOccurrences +=
      targetUnion.size + (plate.samples.size > 0 ? referenceCount : 0);
  }

  const samplePlateAppearances = Array.from(appearances.values()).reduce(
    (sum, count) => sum + count,
    0,
  );
  const splitSamples = Array.from(appearances.values()).filter(
    (count) => count > 1,
  ).length;
  return {
    plateCount: plates.length,
    samplePlateAppearances,
    splitSamples,
    repeatedReferenceBlocks:
      (samplePlateAppearances - samples.length) * referenceCount,
    genePlateOccurrences,
    targetBlocks: samples.length * targetGenes.length,
  };
}

function buildCandidate(
  packedPlates: PackedPlate[],
  strategy: LayoutStrategy,
  samples: string[],
  targetGenes: string[],
  referenceGenes: string[],
): LayoutCandidate {
  const genes = geneOrder(targetGenes, referenceGenes);
  const builder =
    strategy === "sample-major"
      ? sampleMajorSequence
      : strategy === "gene-major"
        ? geneMajorSequence
        : hybridSequence;
  const plateSequences = packedPlates.map((plate) =>
    builder(plate, samples, genes),
  );
  const allocation = allocationMetrics(
    packedPlates,
    samples,
    targetGenes,
    referenceGenes.length,
  );
  const switches = countSwitches(plateSequences);
  return {
    strategy,
    packedPlates,
    plateSequences,
    ...allocation,
    ...switches,
    stableRank:
      strategy === "sample-major" ? 0 : strategy === "hybrid" ? 1 : 2,
  };
}

function candidateScore(candidate: LayoutCandidate) {
  return [
    candidate.plateCount,
    candidate.samplePlateAppearances,
    candidate.genePlateOccurrences,
    candidate.stableRank,
    candidate.primerSwitches,
    candidate.sampleSwitches,
  ];
}

function compareScores(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function emptyWells(rows: number, columns: number): PlannerWell[] {
  const wells: PlannerWell[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      wells.push({
        wellId: formatWellId(row, column),
        row,
        column,
        sample: null,
        gene: null,
        geneType: null,
        replicateIndex: null,
        source: "auto",
      });
    }
  }
  return wells;
}

function requiredBlockColumns(
  sequence: AssayBlock[],
  rows: number,
  strategy: LayoutStrategy,
  loadingPattern: LoadingPattern,
  sampleIndices: SampleIndexMap,
) {
  if (
    strategy !== "gene-major" ||
    loadingPattern !== "interleaved-8-channel"
  ) {
    return Math.ceil(sequence.length / rows);
  }

  const geneBands = new Map<string, Set<number>>();
  for (const block of sequence) {
    const bands = geneBands.get(block.gene) ?? new Set<number>();
    bands.add(
      Math.floor(
        sampleGlobalIndex(block.sample, sampleIndices) / rows,
      ),
    );
    geneBands.set(block.gene, bands);
  }
  return Array.from(geneBands.values()).reduce(
    (sum, bands) => sum + bands.size,
    0,
  );
}

function materializePlate(
  sequence: AssayBlock[],
  packedPlate: PackedPlate,
  plateNumber: number,
  rows: number,
  columns: number,
  replicates: number,
  inputSamples: string[],
  strategy: LayoutStrategy,
  loadingPattern: LoadingPattern,
  fillDirection: LayoutFillDirection,
  sampleDesigns: PlanSampleDesign[],
  repeatingBridgeSamples: ReadonlySet<string>,
): PlannerPlate {
  const wells = emptyWells(rows, columns);
  const wellIndex = new Map(wells.map((well, index) => [well.wellId, index]));
  const rowOrder = loadingRowOrder(rows, loadingPattern);
  const blocksPerRow = Math.floor(columns / replicates);
  const sampleIndices = new Map(
    inputSamples.map((sample, index) => [sample, index]),
  );
  const sampleDesignByName = new Map(
    sampleDesigns.map((design) => [design.name, design]),
  );
  const alignEachGene =
    strategy === "gene-major" &&
    loadingPattern === "interleaved-8-channel" &&
    fillDirection === "vertical";
  const alignedGeneBandColumns = new Map<string, Map<number, number>>();
  if (alignEachGene) {
    const geneBands = new Map<string, Set<number>>();
    for (const block of sequence) {
      const bands = geneBands.get(block.gene) ?? new Set<number>();
      bands.add(
        Math.floor(
          sampleGlobalIndex(block.sample, sampleIndices) / rows,
        ),
      );
      geneBands.set(block.gene, bands);
    }
    let nextBlockColumn = 0;
    for (const [gene, bands] of geneBands) {
      const columnsByBand = new Map<number, number>();
      Array.from(bands)
        .sort((left, right) => left - right)
        .forEach((band) => {
          columnsByBand.set(band, nextBlockColumn);
          nextBlockColumn += 1;
        });
      alignedGeneBandColumns.set(gene, columnsByBand);
    }
  }

  sequence.forEach((block, blockIndex) => {
    let rowPosition: number;
    let blockColumn: number;
    if (alignEachGene) {
      const globalIndex = sampleGlobalIndex(
        block.sample,
        sampleIndices,
      );
      const globalBand = Math.floor(globalIndex / rows);
      const alignedColumn =
        alignedGeneBandColumns.get(block.gene)?.get(globalBand);
      if (alignedColumn === undefined) {
        throw new PlatePlannerError(
          "E_INTERNAL_GENE_BAND",
          "排板计算缺少基因列块映射。 / The gene-band column mapping is missing.",
        );
      }
      rowPosition = globalIndex % rows;
      blockColumn = alignedColumn;
    } else {
      if (fillDirection === "horizontal") {
        rowPosition = Math.floor(blockIndex / blocksPerRow);
        blockColumn = blockIndex % blocksPerRow;
      } else {
        rowPosition = blockIndex % rows;
        blockColumn = Math.floor(blockIndex / rows);
      }
    }
    const row = rowOrder[rowPosition];
    const startColumn = blockColumn * replicates;
    for (
      let replicateIndex = 0;
      replicateIndex < replicates;
      replicateIndex += 1
    ) {
      const column = startColumn + replicateIndex;
      const wellId = formatWellId(row, column);
      const index = wellIndex.get(wellId);
      if (index === undefined) {
        throw new PlatePlannerError(
          "E_INTERNAL_OVERFLOW",
          "排板计算发生越界，请检查输入。 / Plate calculation exceeded the available grid; check the inputs.",
        );
      }
      const design = sampleDesignByName.get(block.sample);
      const isRepeatedBridge = Boolean(
        design?.isBridge && repeatingBridgeSamples.has(block.sample),
      );
      wells[index] = {
        wellId,
        row,
        column,
        sample: block.sample,
        gene: block.gene,
        geneType: block.geneType,
        replicateIndex: replicateIndex + 1,
        source: "auto",
        ...(design?.cellLine ? { cellLine: design.cellLine } : {}),
        ...(design?.comparisonGroup
          ? { comparisonGroup: design.comparisonGroup }
          : {}),
        ...(design?.isBridge ? { isBridge: true } : {}),
        ...(isRepeatedBridge
          ? {
              crossPlateReason:
                "比较组超出单板容量，作为跨板桥接重复 / Repeated bridge for an oversized comparison unit",
            }
          : {}),
      };
    }
  });

  return {
    id: `plate-${plateNumber}`,
    plateNumber,
    name: defaultPlateName(plateNumber),
    rows,
    columns,
    sampleNames: sampleOrderForPlate(packedPlate, inputSamples),
    wells,
  };
}

export function planPlateLayout(
  rawInput: PlanInput,
  options: PlanOptions = {},
): PlanResult {
  const input = validateInput(rawInput);
  const loadingPattern = resolveLoadingPattern(
    input.plateType,
    options.loadingPattern,
  );
  const fillDirection = options.fillDirection ?? "vertical";
  const strategies: LayoutStrategy[] = options.strategy
    ? [options.strategy]
    : loadingPattern === "interleaved-8-channel"
      ? ["gene-major"]
      : ["sample-major", "gene-major", "hybrid"];
  const sampleIndices = new Map(
    input.samples.map((sample, index) => [sample, index]),
  );
  const usesInterleavedGeneBands =
    input.plateType === 384 &&
    loadingPattern === "interleaved-8-channel" &&
    fillDirection === "vertical";
  const hasComparisonGroups = input.sampleDesigns.some(
    (sample) => sample.cellLine && sample.comparisonGroup,
  );
  const standardLoad = (plate: PackedPlate) =>
    packedLoad(plate, input.referenceGenes.length);
  const standardPackings = strategies.some(
    (strategy) => strategy !== "gene-major" || !usesInterleavedGeneBands,
  )
    ? hasComparisonGroups
      ? generateComparisonPackings(
          input.samples,
          input.sampleDesigns,
          input.targetGenes,
          input.blockCapacity,
          standardLoad,
          input.replicates,
        )
      : generatePackings(
          input.samples,
          input.targetGenes,
          input.blockCapacity,
          input.referenceGenes.length,
        )
    : [];
  const geneBandLoadForInput = (plate: PackedPlate) =>
    geneBandLoad(
      plate,
      input.referenceGenes.length,
      input.dimensions.rows,
      sampleIndices,
    );
  const geneBandPackings =
    usesInterleavedGeneBands &&
    strategies.includes("gene-major") &&
    input.referenceGenes.length + 1 <= input.blocksPerRow
      ? hasComparisonGroups
        ? generateComparisonPackings(
            input.samples,
            input.sampleDesigns,
            input.targetGenes,
            input.blocksPerRow,
            geneBandLoadForInput,
            input.replicates,
          )
        : generateGeneBandPackings(
            input.samples,
            input.targetGenes,
            input.blocksPerRow,
            input.referenceGenes.length,
            input.dimensions.rows,
          )
      : [];
  const candidates = strategies.flatMap((strategy) => {
    const packings =
      strategy === "gene-major" && usesInterleavedGeneBands
        ? geneBandPackings
        : standardPackings;
    return packings
      .map((packing) =>
        buildCandidate(
          packing,
          strategy,
          input.samples,
          input.targetGenes,
          input.referenceGenes,
        ),
      )
      .filter((candidate) =>
        candidate.plateSequences.every(
          (sequence) =>
            requiredBlockColumns(
              sequence,
              input.dimensions.rows,
              strategy,
              loadingPattern,
              sampleIndices,
            ) <= input.blocksPerRow,
        ),
      );
  });
  if (candidates.length === 0) {
    throw new PlatePlannerError(
      "E_INTERLEAVED_GENE_BUNDLE_TOO_LARGE",
      "当前复孔数与内参数量无法形成有效的 384 孔八道排枪隔行布局，请减少复孔数、减少内参数量或改用连续孔位上样。 / The selected replicates and references cannot form a valid interleaved 384-well layout; reduce them or use sequential loading.",
    );
  }
  candidates.sort((left, right) =>
    compareScores(candidateScore(left), candidateScore(right)),
  );
  const best = candidates[0];

  const targetPlateCounts = new Map<string, number>();
  for (const plate of best.packedPlates) {
    for (const [sample, targets] of plate.samples) {
      for (const gene of targets) {
        const key = groupKey(sample, gene);
        targetPlateCounts.set(key, (targetPlateCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const bridgeNames = new Set(
    input.sampleDesigns
      .filter((design) => design.isBridge)
      .map((design) => design.name),
  );
  const repeatingBridgeSamples = new Set(
    Array.from(targetPlateCounts.entries())
      .filter(([key, count]) => {
        const [sample] = key.split("\u0000");
        return count > 1 && bridgeNames.has(sample);
      })
      .map(([key]) => key.split("\u0000")[0]),
  );

  const plates = best.plateSequences.map((sequence, index) =>
    materializePlate(
      sequence,
      best.packedPlates[index],
      index + 1,
      input.dimensions.rows,
      input.dimensions.columns,
      input.replicates,
      input.samples,
      best.strategy,
      loadingPattern,
      fillDirection,
      input.sampleDesigns,
      repeatingBridgeSamples,
    ),
  );
  const usedBlocks = best.plateSequences.reduce(
    (sum, sequence) => sum + sequence.length,
    0,
  );
  const usedWells = usedBlocks * input.replicates;
  const totalWells =
    plates.length * input.dimensions.rows * input.dimensions.columns;
  const rowTailWells =
    plates.length *
    input.dimensions.rows *
    (input.dimensions.columns -
      input.blocksPerRow * input.replicates);
  const strategyName =
    best.strategy === "sample-major"
      ? "按样本排列 / By sample"
      : best.strategy === "gene-major"
        ? "按基因排列 / By assay"
        : "混合分块 / Hybrid";
  const repeatExplanation =
    best.repeatedReferenceBlocks > 0
      ? `为把实验压缩到 ${plates.length} 块板，有 ${best.splitSamples} 个样本跨板；其内参已在涉及的每块板重新安排，共增加 ${best.repeatedReferenceBlocks} 个内参复孔组（${best.repeatedReferenceBlocks * input.replicates} 孔）。 / ${best.splitSamples} sample(s) span plates; all references are rerun on each involved plate, adding ${best.repeatedReferenceBlocks * input.replicates} reference wells.`
      : "所有样本均可在单板内完成，没有产生跨板内参重做。 / Every sample fits on one plate; no reference reruns are added.";

  return {
    plates,
    strategy: best.strategy,
    loadingPattern,
    fillDirection,
    metrics: {
      plateCount: plates.length,
      usedWells,
      emptyWells: totalWells - usedWells,
      utilization: totalWells === 0 ? 0 : usedWells / totalWells,
      sampleSwitches: best.sampleSwitches,
      primerSwitches: best.primerSwitches,
      structuralEmptyWells: totalWells - usedWells,
      rowTailWells,
      samplesPerPlate:
        plates.length === 0
          ? 0
          : Math.max(...plates.map((plate) => plate.sampleNames.length)),
      samplePlateAppearances: best.samplePlateAppearances,
      splitSamples: best.splitSamples,
      repeatedReferenceBlocks: best.repeatedReferenceBlocks,
      repeatedReferenceWells:
        best.repeatedReferenceBlocks * input.replicates,
      genePlateOccurrences: best.genePlateOccurrences,
    },
    reason: hasComparisonGroups
      ? `已先执行比较单元同板约束，再在可行方案中优化板数与操作切换；超大单元仅使用指定桥接样本拆分。推荐${strategyName}：${repeatExplanation} / Comparison-unit integrity is enforced before optimizing plate count and handling switches; oversized units split only with designated bridge samples.`
      : options.strategy
        ? `已按用户选择生成${strategyName}布局；孔板分配仍优先减少板数与跨板内参重做。${repeatExplanation} / The selected ${strategyName} layout was generated while plate allocation continued to minimize plate count and reference reruns.`
        : `系统在已生成的可行候选中，依次比较板数、跨板内参重做、引物跨板批次和板内切换。推荐${strategyName}：${repeatExplanation} / Feasible candidates are ranked by plate count, reference reruns, assay batches, and within-plate switches.`,
  };
}

export function refreshPlanDerivedData(
  result: PlanResult,
  rawInput: PlanInput,
): PlanResult {
  const input = validateInput(rawInput);
  const targetSet = new Set(input.targetGenes);
  const sampleAppearances = new Map(
    input.samples.map((sample) => [sample, 0]),
  );
  let usedWells = 0;
  let sampleSwitches = 0;
  let primerSwitches = 0;
  let genePlateOccurrences = 0;
  let manualWells = 0;
  const designByName = new Map(
    input.sampleDesigns.map((design) => [design.name, design]),
  );
  const bridgeTargetPlates = new Map<string, Set<number>>();
  for (const plate of result.plates) {
    for (const well of plate.wells) {
      if (
        !well.sample ||
        !well.gene ||
        well.geneType !== "target" ||
        !designByName.get(well.sample)?.isBridge
      ) {
        continue;
      }
      const key = groupKey(well.sample, well.gene);
      const plateNumbers = bridgeTargetPlates.get(key) ?? new Set<number>();
      plateNumbers.add(plate.plateNumber);
      bridgeTargetPlates.set(key, plateNumbers);
    }
  }
  const repeatingBridgeSamples = new Set(
    Array.from(bridgeTargetPlates.entries())
      .filter(([, plates]) => plates.size > 1)
      .map(([key]) => key.split("\u0000")[0]),
  );

  const plates = result.plates.map((plate) => {
    const occupied = plate.wells
      .filter((well) => well.sample && well.gene)
      .slice()
      .sort(
        (left, right) =>
          Math.floor(left.column / input.replicates) -
            Math.floor(right.column / input.replicates) ||
          left.row - right.row ||
          left.column - right.column,
      );
    usedWells += occupied.length;
    manualWells += plate.wells.filter(
      (well) => well.source === "manual",
    ).length;

    for (let index = 1; index < occupied.length; index += 1) {
      if (occupied[index].sample !== occupied[index - 1].sample) {
        sampleSwitches += 1;
      }
      if (occupied[index].gene !== occupied[index - 1].gene) {
        primerSwitches += 1;
      }
    }

    const genesOnPlate = new Set(
      occupied.flatMap((well) => (well.gene ? [well.gene] : [])),
    );
    genePlateOccurrences += genesOnPlate.size;

    const targetSamples = new Set(
      occupied.flatMap((well) =>
        well.sample && well.gene && targetSet.has(well.gene)
          ? [well.sample]
          : [],
      ),
    );
    targetSamples.forEach((sample) =>
      sampleAppearances.set(
        sample,
        (sampleAppearances.get(sample) ?? 0) + 1,
      ),
    );

    const assignedSamples = new Set(
      occupied.flatMap((well) => (well.sample ? [well.sample] : [])),
    );
    const decoratedWells = plate.wells.map((well) => {
      const baseWell = { ...well };
      delete baseWell.cellLine;
      delete baseWell.comparisonGroup;
      delete baseWell.isBridge;
      delete baseWell.crossPlateReason;
      if (!well.sample || !well.gene) return baseWell;
      const design = designByName.get(well.sample);
      return {
        ...baseWell,
        ...(design?.cellLine ? { cellLine: design.cellLine } : {}),
        ...(design?.comparisonGroup
          ? { comparisonGroup: design.comparisonGroup }
          : {}),
        ...(design?.isBridge ? { isBridge: true } : {}),
        ...(design?.isBridge && repeatingBridgeSamples.has(well.sample)
          ? {
              crossPlateReason:
                "比较组超出单板容量，作为跨板桥接重复 / Repeated bridge for an oversized comparison unit",
            }
          : {}),
      };
    });
    return {
      ...plate,
      name: plate.name?.trim() || defaultPlateName(plate.plateNumber),
      sampleNames: input.samples.filter((sample) =>
        assignedSamples.has(sample),
      ),
      wells: decoratedWells,
    };
  });

  const appearanceCounts = Array.from(sampleAppearances.values());
  const samplePlateAppearances = appearanceCounts.reduce(
    (sum, count) => sum + count,
    0,
  );
  const splitSamples = appearanceCounts.filter((count) => count > 1).length;
  const repeatedReferenceBlocks =
    appearanceCounts.reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    ) * input.referenceGenes.length;
  const totalWells =
    plates.length * input.dimensions.rows * input.dimensions.columns;
  const rowTailWells =
    plates.length *
    input.dimensions.rows *
    (input.dimensions.columns -
      input.blocksPerRow * input.replicates);
  const repeatedReferenceWells =
    repeatedReferenceBlocks * input.replicates;

  return {
    ...result,
    plates,
    metrics: {
      ...result.metrics,
      plateCount: plates.length,
      usedWells,
      emptyWells: totalWells - usedWells,
      utilization: totalWells === 0 ? 0 : usedWells / totalWells,
      sampleSwitches,
      primerSwitches,
      structuralEmptyWells: totalWells - usedWells,
      rowTailWells,
      samplesPerPlate:
        plates.length === 0
          ? 0
          : Math.max(...plates.map((plate) => plate.sampleNames.length)),
      samplePlateAppearances,
      splitSamples,
      repeatedReferenceBlocks,
      repeatedReferenceWells,
      genePlateOccurrences,
    },
    reason:
      manualWells === 0
        ? result.reason
        : `当前含 ${manualWells} 个手动调整孔，摘要已按现有孔位重算。${splitSamples > 0 ? `${splitSamples} 个样本跨板，预计需额外重做 ${repeatedReferenceBlocks} 个内参复孔组（${repeatedReferenceWells} 孔）。` : "当前没有样本跨板。"}请以即时校验结果作为确认依据。 / Summary recalculated from ${manualWells} manually edited wells; use the live validation result before confirmation.`,
  };
}

function groupKey(sample: string, gene: string) {
  return `${sample}\u0000${gene}`;
}

export function validateLayout(
  result: PlanResult,
  rawInput: PlanInput,
): ValidationResult {
  let input: ReturnType<typeof validateInput>;
  try {
    input = validateInput(rawInput);
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          code:
            error instanceof PlatePlannerError
              ? error.code
              : "E_INVALID_INPUT",
          message:
            error instanceof Error
              ? error.message
              : "实验设置无效。 / Invalid experiment setup.",
        },
      ],
    };
  }

  const errors: ValidationIssue[] = [];
  const seenPlateNames = new Set<string>();
  for (const plate of result.plates) {
    const plateName =
      plate.name?.trim() || defaultPlateName(plate.plateNumber);
    const normalizedPlateName = plateName.toLocaleLowerCase();
    if (seenPlateNames.has(normalizedPlateName)) {
      errors.push({
        code: "E_DUPLICATE_PLATE_NAME",
        plateNumber: plate.plateNumber,
        message: `孔板名称“${plateName}”重复。 / Plate name “${plateName}” is duplicated.`,
      });
    }
    seenPlateNames.add(normalizedPlateName);
  }
  const globalTargetGroups = new Map<
    string,
    Array<{ well: PlannerWell; plateNumber: number }>
  >();
  const knownSamples = new Set(input.samples);
  const targetSet = new Set(input.targetGenes);
  const referenceSet = new Set(input.referenceGenes);
  const comparisonGroups = new Map<string, PlanSampleDesign[]>();
  for (const design of input.sampleDesigns) {
    if (!design.cellLine || !design.comparisonGroup) continue;
    const key = comparisonKey(design.cellLine, design.comparisonGroup);
    const members = comparisonGroups.get(key) ?? [];
    members.push(design);
    comparisonGroups.set(key, members);
  }
  const sampleIndices = new Map(
    input.samples.map((sample, index) => [sample, index]),
  );
  const comparisonUnitFits = (
    members: PlanSampleDesign[],
    gene: string,
  ) => {
    const plate = emptyPackedPlate();
    addPairsToPlate(
      plate,
      members.map((member) => ({ sample: member.name, gene })),
    );
    return result.plates[0]?.rows === 16 &&
      result.loadingPattern === "interleaved-8-channel" &&
      result.strategy === "gene-major" &&
      result.fillDirection === "vertical"
      ? geneBandLoad(
          plate,
          input.referenceGenes.length,
          input.dimensions.rows,
          sampleIndices,
        ) <= input.blocksPerRow
      : packedLoad(plate, input.referenceGenes.length) <= input.blockCapacity;
  };
  const allowedBridgeRepeats = new Set<string>();
  for (const members of comparisonGroups.values()) {
    for (const gene of input.targetGenes) {
      if (comparisonUnitFits(members, gene)) continue;
      for (const bridge of members.filter((member) => member.isBridge)) {
        allowedBridgeRepeats.add(groupKey(bridge.name, gene));
      }
    }
  }

  result.plates.forEach((plate) => {
    const plateGroups = new Map<string, PlannerWell[]>();
    for (const well of plate.wells) {
      if (!well.sample && !well.gene) continue;
      if (!well.sample || !well.gene) {
        errors.push({
          code: "E_PARTIAL_WELL_ASSIGNMENT",
          plateNumber: plate.plateNumber,
          wellIds: [well.wellId],
          message: `Plate ${String(plate.plateNumber).padStart(2, "0")}：${well.wellId} 的样本或基因信息不完整。 / Sample or assay assignment is incomplete.`,
        });
        continue;
      }
      if (!knownSamples.has(well.sample)) {
        errors.push({
          code: "E_UNKNOWN_SAMPLE",
          plateNumber: plate.plateNumber,
          wellIds: [well.wellId],
          message: `${well.wellId} 使用了未登记样本 ${well.sample}。 / The well uses an unregistered sample.`,
        });
      }
      if (!targetSet.has(well.gene) && !referenceSet.has(well.gene)) {
        errors.push({
          code: "E_UNKNOWN_GENE",
          plateNumber: plate.plateNumber,
          wellIds: [well.wellId],
          message: `${well.wellId} 使用了未登记基因 ${well.gene}。 / The well uses an unregistered assay.`,
        });
      } else {
        const expectedGeneType: GeneType = targetSet.has(well.gene)
          ? "target"
          : "reference";
        if (well.geneType !== expectedGeneType) {
          errors.push({
            code: "E_GENE_TYPE_MISMATCH",
            plateNumber: plate.plateNumber,
            wellIds: [well.wellId],
            message: `Plate ${String(plate.plateNumber).padStart(2, "0")}：${well.wellId} 的基因 ${well.gene} 应标记为${expectedGeneType === "reference" ? "内参" : "目的"}基因。 / The assay role does not match the experiment setup.`,
          });
        }
      }
      const key = groupKey(well.sample, well.gene);
      const local = plateGroups.get(key) ?? [];
      local.push(well);
      plateGroups.set(key, local);
      if (targetSet.has(well.gene)) {
        const global = globalTargetGroups.get(key) ?? [];
        global.push({ well, plateNumber: plate.plateNumber });
        globalTargetGroups.set(key, global);
      }
    }

    for (const [key, wells] of plateGroups) {
      const [sample, gene] = key.split("\u0000");
      const sorted = wells
        .slice()
        .sort((left, right) => left.column - right.column);
      const sameRow = sorted.every((well) => well.row === sorted[0].row);
      const continuous = sorted.every(
        (well, index) =>
          index === 0 || well.column === sorted[index - 1].column + 1,
      );
      const replicateOrder = sorted.every(
        (well, index) => well.replicateIndex === index + 1,
      );
      if (
        wells.length !== input.replicates ||
        !sameRow ||
        !continuous ||
        !replicateOrder
      ) {
        errors.push({
          code: "E_REPLICATE_BLOCK_BROKEN",
          plateNumber: plate.plateNumber,
          wellIds: wells.map((well) => well.wellId),
          message: `Plate ${String(plate.plateNumber).padStart(2, "0")}：${sample} × ${gene} 的 ${input.replicates} 个复孔必须在同一行从左向右连续。 / Replicates must be contiguous from left to right in one row.`,
        });
      }
    }

    const targetSamples = new Set(
      Array.from(plateGroups.keys())
        .filter((key) => targetSet.has(key.split("\u0000")[1]))
        .map((key) => key.split("\u0000")[0]),
    );
    const referenceSamples = new Set(
      Array.from(plateGroups.keys())
        .filter((key) => referenceSet.has(key.split("\u0000")[1]))
        .map((key) => key.split("\u0000")[0]),
    );

    for (const sample of targetSamples) {
      for (const referenceGene of input.referenceGenes) {
        const wells = plateGroups.get(groupKey(sample, referenceGene)) ?? [];
        if (wells.length !== input.replicates) {
          errors.push({
            code: "E_REFERENCE_COHERENCE",
            plateNumber: plate.plateNumber,
            message: `Plate ${String(plate.plateNumber).padStart(2, "0")}：样本 ${sample} 在本板有目的基因，但缺少完整内参 ${referenceGene}；跨板时内参必须在每块板重新做。 / This sample has a target on the plate but lacks a complete ${referenceGene} block; all references must be rerun on every involved plate.`,
          });
        }
      }
    }

    for (const sample of referenceSamples) {
      if (!targetSamples.has(sample)) {
        errors.push({
          code: "E_ORPHAN_REFERENCE",
          plateNumber: plate.plateNumber,
          message: `Plate ${String(plate.plateNumber).padStart(2, "0")}：样本 ${sample} 只有内参、没有目的基因检测，请确认是否为多余孔。 / This sample has references but no target assay on the plate.`,
        });
      }
    }
  });

  for (const sample of input.samples) {
    for (const gene of input.targetGenes) {
      const assignments =
        globalTargetGroups.get(groupKey(sample, gene)) ?? [];
      const assignmentCounts = new Map<number, number>();
      assignments.forEach((assignment) =>
        assignmentCounts.set(
          assignment.plateNumber,
          (assignmentCounts.get(assignment.plateNumber) ?? 0) + 1,
        ),
      );
      const validBridgeRepeat =
        allowedBridgeRepeats.has(groupKey(sample, gene)) &&
        assignments.length >= input.replicates &&
        assignments.length % input.replicates === 0 &&
        Array.from(assignmentCounts.values()).every(
          (count) => count === input.replicates,
        );
      if (assignments.length !== input.replicates && !validBridgeRepeat) {
        const affectedPlateNumbers = Array.from(
          new Set(assignments.map((assignment) => assignment.plateNumber)),
        );
        const plateNumbers =
          affectedPlateNumbers.length > 0
            ? affectedPlateNumbers
            : [undefined];
        for (const plateNumber of plateNumbers) {
          const wells =
            plateNumber === undefined
              ? []
              : assignments
                  .filter(
                    (assignment) =>
                      assignment.plateNumber === plateNumber,
                  )
                  .map((assignment) => assignment.well);
          errors.push({
            code:
              assignments.length === 0
                ? "E_REQUIRED_ASSAY_MISSING"
                : "E_REQUIRED_ASSAY_DUPLICATED",
            plateNumber,
            wellIds: wells.map((well) => well.wellId),
            message:
              assignments.length === 0
                ? `缺少 ${sample} × ${gene} 的目的基因检测孔。 / Required target wells are missing.`
                : `${sample} × ${gene} 共出现 ${assignments.length} 孔，应为 ${input.replicates} 孔。 / Found ${assignments.length} wells; expected ${input.replicates}.`,
          });
        }
      }
    }
  }

  for (const members of comparisonGroups.values()) {
    for (const gene of input.targetGenes) {
      const assignmentsBySample = new Map(
        members.map((member) => [
          member.name,
          globalTargetGroups.get(groupKey(member.name, gene)) ?? [],
        ]),
      );
      const involvedPlates = new Set(
        Array.from(assignmentsBySample.values()).flatMap((assignments) =>
          assignments.map((assignment) => assignment.plateNumber),
        ),
      );
      if (involvedPlates.size <= 1) continue;
      if (comparisonUnitFits(members, gene)) {
        errors.push({
          code: "E_COMPARISON_UNIT_SPLIT",
          severity: "high",
          message: `比较组“${members[0].cellLine} / ${members[0].comparisonGroup}”检测 ${gene} 时被拆到 ${Array.from(involvedPlates).join(", ")} 号板；自动布局应保持同板，手动拆分可能引入板间效应。 / The comparison unit is split across plates; manual splitting may introduce a plate effect.`,
        });
        continue;
      }
      const bridges = members.filter((member) => member.isBridge);
      for (const plateNumber of involvedPlates) {
        for (const bridge of bridges) {
          const count = (
            assignmentsBySample.get(bridge.name) ?? []
          ).filter(
            (assignment) => assignment.plateNumber === plateNumber,
          ).length;
          if (count !== input.replicates) {
            errors.push({
              code: "E_BRIDGE_SAMPLE_MISSING",
              severity: "high",
              plateNumber,
              message: `Plate ${String(plateNumber).padStart(2, "0")}：跨板比较组缺少桥接样本 ${bridge.name} × ${gene} 的完整复孔。 / The split comparison group is missing its complete bridge replicate block.`,
            });
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
