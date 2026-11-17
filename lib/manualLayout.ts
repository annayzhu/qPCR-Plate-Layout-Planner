import {
  formatWellId,
  type GeneType,
  type PlanResult,
  type PlannerPlate,
  type PlannerWell,
} from "./platePlanner";

export interface ManualAssignment {
  sample: string | null;
  gene: string | null;
  geneType: GeneType | null;
}

export interface CopiedWell {
  rowOffset: number;
  columnOffset: number;
  sample: string | null;
  gene: string | null;
  geneType: GeneType | null;
  replicateIndex: number | null;
}

export interface WellClipboard {
  wells: CopiedWell[];
}

export interface ManualWellPatch {
  plateNumber: number;
  wellId: string;
  before: PlannerWell;
  after: PlannerWell;
}

export interface ManualPlateNamePatch {
  plateNumber: number;
  before: string;
  after: string;
}

/**
 * The durable delta for one manual edit. Derived plate metrics are deliberately
 * excluded because they are rebuilt by the Plate Editing Session after apply.
 */
export interface ManualLayoutPatch {
  plateNumbers: number[];
  wells: ManualWellPatch[];
  plateNames: ManualPlateNamePatch[];
}

export interface PastePlan {
  /** Wells that receive a copied well, in reading order. */
  targets: { wellId: string; copied: CopiedWell }[];
  /** Targets that already hold a reaction. */
  overwrittenWellIds: string[];
  /** Copied wells that would land outside the plate. */
  outside: number;
}

export type PasteCopiedWellsResult =
  | {
      ok: true;
      plate: PlannerPlate;
      pastedWellIds: string[];
      overwrittenWellIds: string[];
    }
  | { ok: false; reason: "empty-clipboard" | "invalid-anchor" | "out-of-bounds" };

export type BoxSelectionMode = "replace" | "add";

export interface SwapPlan {
  ok: boolean;
  reason?: "empty-selection" | "out-of-bounds";
  /** No shift: dropping on the starting well. */
  unchanged?: boolean;
  /** Where the selected wells land (only the in-bounds ones when refused). */
  landingWellIds: string[];
  /** Landing wells outside the selection; their contents go back to the vacated wells. */
  displacedWellIds: string[];
  moves: [from: string, to: string][];
}

export type SwapSelectionResult =
  | (SwapPlan & { ok: true; plate: PlannerPlate })
  | (SwapPlan & { ok: false });

function emptyManualWell(well: PlannerWell): PlannerWell {
  return {
    ...well,
    sample: null,
    gene: null,
    geneType: null,
    replicateIndex: null,
    source: "manual",
  };
}

export function rectangularWellIds(
  plate: PlannerPlate,
  anchorWellId: string,
  endWellId: string,
) {
  const anchor = plate.wells.find((well) => well.wellId === anchorWellId);
  const end = plate.wells.find((well) => well.wellId === endWellId);
  if (!anchor || !end) return [];
  const minRow = Math.min(anchor.row, end.row);
  const maxRow = Math.max(anchor.row, end.row);
  const minColumn = Math.min(anchor.column, end.column);
  const maxColumn = Math.max(anchor.column, end.column);
  return plate.wells
    .filter(
      (well) =>
        well.row >= minRow &&
        well.row <= maxRow &&
        well.column >= minColumn &&
        well.column <= maxColumn,
    )
    .sort((left, right) => left.row - right.row || left.column - right.column)
    .map((well) => well.wellId);
}

export function applyBoxSelection(
  currentWellIds: readonly string[],
  boxedWellIds: readonly string[],
  mode: BoxSelectionMode,
) {
  if (mode === "replace") return Array.from(new Set(boxedWellIds));
  return Array.from(new Set([...currentWellIds, ...boxedWellIds]));
}

function wellsAreEqual(left: PlannerWell, right: PlannerWell) {
  return (
    left.wellId === right.wellId &&
    left.row === right.row &&
    left.column === right.column &&
    left.sample === right.sample &&
    left.gene === right.gene &&
    left.geneType === right.geneType &&
    left.replicateIndex === right.replicateIndex &&
    left.source === right.source &&
    left.cellLine === right.cellLine &&
    left.comparisonGroup === right.comparisonGroup &&
    left.isBridge === right.isBridge &&
    left.crossPlateReason === right.crossPlateReason
  );
}

export function createManualLayoutPatch(
  before: PlanResult,
  after: PlanResult,
  affectedPlateNumbers: readonly number[],
): ManualLayoutPatch {
  const plateNumbers = Array.from(new Set(affectedPlateNumbers));
  const afterByPlateNumber = new Map(
    after.plates.map((plate) => [plate.plateNumber, plate]),
  );
  const wells: ManualWellPatch[] = [];
  const plateNames: ManualPlateNamePatch[] = [];

  for (const plateNumber of plateNumbers) {
    const beforePlate = before.plates.find(
      (plate) => plate.plateNumber === plateNumber,
    );
    const afterPlate = afterByPlateNumber.get(plateNumber);
    if (!beforePlate || !afterPlate) continue;
    if (beforePlate.name !== afterPlate.name) {
      plateNames.push({
        plateNumber,
        before: beforePlate.name,
        after: afterPlate.name,
      });
    }
    const afterByWellId = new Map(
      afterPlate.wells.map((well) => [well.wellId, well]),
    );
    for (const beforeWell of beforePlate.wells) {
      const afterWell = afterByWellId.get(beforeWell.wellId);
      if (!afterWell || wellsAreEqual(beforeWell, afterWell)) continue;
      wells.push({
        plateNumber,
        wellId: beforeWell.wellId,
        before: beforeWell,
        after: afterWell,
      });
    }
  }

  return { plateNumbers, wells, plateNames };
}

export function applyManualLayoutPatch(
  plan: PlanResult,
  patch: ManualLayoutPatch,
): PlanResult {
  const namesByPlateNumber = new Map(
    patch.plateNames.map((entry) => [entry.plateNumber, entry.after]),
  );
  const wellsByPlateNumber = new Map<number, Map<string, PlannerWell>>();
  for (const entry of patch.wells) {
    const byWellId = wellsByPlateNumber.get(entry.plateNumber) ?? new Map();
    byWellId.set(entry.wellId, entry.after);
    wellsByPlateNumber.set(entry.plateNumber, byWellId);
  }
  return {
    ...plan,
    plates: plan.plates.map((plate) => {
      const name = namesByPlateNumber.get(plate.plateNumber) ?? plate.name;
      const changedWells = wellsByPlateNumber.get(plate.plateNumber);
      if (!changedWells && name === plate.name) return plate;
      return {
        ...plate,
        name,
        wells: changedWells
          ? plate.wells.map((well) => changedWells.get(well.wellId) ?? well)
          : plate.wells,
      };
    }),
  };
}

export function invertManualLayoutPatch(
  patch: ManualLayoutPatch,
): ManualLayoutPatch {
  return {
    plateNumbers: [...patch.plateNumbers],
    wells: patch.wells.map((entry) => ({
      ...entry,
      before: entry.after,
      after: entry.before,
    })),
    plateNames: patch.plateNames.map((entry) => ({
      ...entry,
      before: entry.after,
      after: entry.before,
    })),
  };
}

export function assignSelectedWells(
  plate: PlannerPlate,
  wellIds: readonly string[],
  assignment: ManualAssignment,
) {
  const selected = new Set(wellIds);
  return {
    ...plate,
    wells: plate.wells.map((well) => {
      if (!selected.has(well.wellId)) return well;
      if (!assignment.sample || !assignment.gene || !assignment.geneType) {
        return emptyManualWell(well);
      }
      return {
        ...well,
        sample: assignment.sample,
        gene: assignment.gene,
        geneType: assignment.geneType,
        replicateIndex: well.replicateIndex,
        source: "manual" as const,
      };
    }),
  };
}

function inReadingOrder<T extends { row: number; column: number }>(wells: T[]) {
  return wells
    .slice()
    .sort((left, right) => left.row - right.row || left.column - right.column);
}

function hasReaction(well: { sample: string | null; gene: string | null }) {
  return Boolean(well.sample && well.gene);
}

/**
 * Offsets are relative to the first selected well in reading order; that well
 * lands on the paste target and the rest keep their direction and spacing.
 */
export function copySelectedWells(
  plate: PlannerPlate,
  selectedWellIds: readonly string[],
): WellClipboard {
  const selected = new Set(selectedWellIds);
  const wells = inReadingOrder(plate.wells.filter((well) => selected.has(well.wellId)));
  if (wells.length === 0) return { wells: [] };
  const first = wells[0];
  return {
    wells: wells.map((well) => ({
      rowOffset: well.row - first.row,
      columnOffset: well.column - first.column,
      sample: well.sample,
      gene: well.gene,
      geneType: well.geneType,
      replicateIndex: well.replicateIndex,
    })),
  };
}

export function clipboardMatchesExperiment(
  clipboard: WellClipboard,
  sampleNames: readonly string[],
  geneNames: readonly string[],
) {
  const samples = new Set(sampleNames);
  const genes = new Set(geneNames);
  return clipboard.wells.every(
    (well) =>
      (!well.sample || samples.has(well.sample)) &&
      (!well.gene || genes.has(well.gene)),
  );
}

/** Empty copied wells keep the shape but are never pasted. */
export function planPaste(
  plate: PlannerPlate,
  clipboard: WellClipboard,
  destinationAnchorWellId: string,
): PastePlan | null {
  const anchor = plate.wells.find(
    (well) => well.wellId === destinationAnchorWellId,
  );
  if (!anchor) return null;
  const byWellId = new Map(plate.wells.map((well) => [well.wellId, well]));
  const targets: PastePlan["targets"] = [];
  let outside = 0;
  for (const copied of clipboard.wells) {
    if (!hasReaction(copied)) continue;
    const row = anchor.row + copied.rowOffset;
    const column = anchor.column + copied.columnOffset;
    if (row < 0 || row >= plate.rows || column < 0 || column >= plate.columns) {
      outside += 1;
      continue;
    }
    targets.push({ wellId: formatWellId(row, column), copied });
  }
  return {
    targets,
    overwrittenWellIds: targets
      .filter(({ wellId }) => {
        const well = byWellId.get(wellId);
        return Boolean(well && hasReaction(well));
      })
      .map(({ wellId }) => wellId),
    outside,
  };
}

export function pasteCopiedWells(
  plate: PlannerPlate,
  clipboard: WellClipboard,
  destinationAnchorWellId: string,
): PasteCopiedWellsResult {
  if (!clipboard.wells.some(hasReaction)) {
    return { ok: false, reason: "empty-clipboard" };
  }
  const plan = planPaste(plate, clipboard, destinationAnchorWellId);
  if (!plan) return { ok: false, reason: "invalid-anchor" };
  if (plan.outside > 0) return { ok: false, reason: "out-of-bounds" };

  const destinationById = new Map(
    plan.targets.map((target) => [target.wellId, target.copied]),
  );
  const wells = plate.wells.map((well) => {
    const copied = destinationById.get(well.wellId);
    if (!copied) return well;
    return {
      ...well,
      sample: copied.sample,
      gene: copied.gene,
      geneType: copied.geneType,
      replicateIndex: copied.replicateIndex,
      source: "manual" as const,
    };
  });
  return {
    ok: true,
    plate: { ...plate, wells },
    pastedWellIds: plan.targets.map((target) => target.wellId),
    overwrittenWellIds: plan.overwrittenWellIds,
  };
}

export function restoreSelectedWells(
  currentPlate: PlannerPlate,
  automaticPlate: PlannerPlate,
  selectedWellIds: readonly string[],
): PlannerPlate {
  const selected = new Set(selectedWellIds);
  const automaticByWellId = new Map(
    automaticPlate.wells.map((well) => [well.wellId, well]),
  );
  return {
    ...currentPlate,
    wells: currentPlate.wells.map((well) => {
      if (!selected.has(well.wellId)) return well;
      const automaticWell = automaticByWellId.get(well.wellId);
      return automaticWell ? { ...automaticWell } : well;
    }),
  };
}

/**
 * Dragging `fromWellId` onto `toWellId` shifts the whole selection by that
 * offset. Wells already where the selection lands go back, in reading order,
 * into the wells the selection leaves, so the edit is a permutation of wells.
 */
export function planSwap(
  plate: PlannerPlate,
  selectedWellIds: readonly string[],
  fromWellId: string,
  toWellId: string,
): SwapPlan {
  const byWellId = new Map(plate.wells.map((well) => [well.wellId, well]));
  const from = byWellId.get(fromWellId);
  const to = byWellId.get(toWellId);
  const selected = new Set(selectedWellIds);
  const sources = inReadingOrder(plate.wells.filter((well) => selected.has(well.wellId)));
  const empty: SwapPlan = { ok: false, reason: "empty-selection", landingWellIds: [], displacedWellIds: [], moves: [] };
  if (!from || !to || sources.length === 0) return empty;
  const rowShift = to.row - from.row;
  const columnShift = to.column - from.column;
  const landingWellIds: string[] = [];
  const moves: [string, string][] = [];
  let outside = false;
  for (const source of sources) {
    const row = source.row + rowShift;
    const column = source.column + columnShift;
    if (row < 0 || row >= plate.rows || column < 0 || column >= plate.columns) {
      outside = true;
      continue;
    }
    const target = formatWellId(row, column);
    landingWellIds.push(target);
    moves.push([source.wellId, target]);
  }
  if (outside) {
    return { ok: false, reason: "out-of-bounds", landingWellIds, displacedWellIds: [], moves: [] };
  }
  if (rowShift === 0 && columnShift === 0) {
    return { ok: true, unchanged: true, landingWellIds, displacedWellIds: [], moves: [] };
  }
  const sourceIds = new Set(sources.map((well) => well.wellId));
  const landing = new Set(landingWellIds);
  const displacedWellIds = inReadingOrder(
    landingWellIds
      .filter((wellId) => !sourceIds.has(wellId))
      .map((wellId) => byWellId.get(wellId)!),
  ).map((well) => well.wellId);
  const vacated = sources
    .map((well) => well.wellId)
    .filter((wellId) => !landing.has(wellId));
  displacedWellIds.forEach((wellId, index) => moves.push([wellId, vacated[index]]));
  return { ok: true, landingWellIds, displacedWellIds, moves };
}

export function swapSelectedWells(
  plate: PlannerPlate,
  selectedWellIds: readonly string[],
  fromWellId: string,
  toWellId: string,
): SwapSelectionResult {
  const plan = planSwap(plate, selectedWellIds, fromWellId, toWellId);
  if (!plan.ok) return { ...plan, ok: false };
  const byWellId = new Map(plate.wells.map((well) => [well.wellId, well]));
  const incoming = new Map(plan.moves.map(([from, to]) => [to, byWellId.get(from)!]));
  const wells = plate.wells.map((well) => {
    const source = incoming.get(well.wellId);
    if (!source) return well;
    return {
      ...source,
      wellId: well.wellId,
      row: well.row,
      column: well.column,
      source: "manual" as const,
    };
  });
  return { ...plan, ok: true, plate: { ...plate, wells } };
}
