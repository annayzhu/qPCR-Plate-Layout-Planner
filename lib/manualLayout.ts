import {
  formatWellId,
  type GeneType,
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

export type PasteCopiedWellsResult =
  | {
      ok: true;
      plate: PlannerPlate;
      pastedWellIds: string[];
      overwrittenWellIds: string[];
    }
  | { ok: false; reason: "empty-clipboard" | "invalid-anchor" | "out-of-bounds" };

export type BoxSelectionMode = "replace" | "add";

export type TranslateSelectionResult =
  | {
      ok: true;
      plate: PlannerPlate;
      movedWellIds: string[];
      overwrittenWellIds: string[];
    }
  | {
      ok: false;
      reason: "empty-selection" | "out-of-bounds" | "collision";
      collisionWellIds?: string[];
    };

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

export function assignSelectedWells(
  plate: PlannerPlate,
  wellIds: string[],
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

export function copySelectedWells(
  plate: PlannerPlate,
  selectedWellIds: readonly string[],
): WellClipboard {
  const selected = new Set(selectedWellIds);
  const wells = plate.wells.filter((well) => selected.has(well.wellId));
  if (wells.length === 0) return { wells: [] };
  const minRow = Math.min(...wells.map((well) => well.row));
  const minColumn = Math.min(...wells.map((well) => well.column));
  return {
    wells: wells
      .slice()
      .sort((left, right) => left.row - right.row || left.column - right.column)
      .map((well) => ({
        rowOffset: well.row - minRow,
        columnOffset: well.column - minColumn,
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

export function pasteCopiedWells(
  plate: PlannerPlate,
  clipboard: WellClipboard,
  destinationAnchorWellId: string,
): PasteCopiedWellsResult {
  if (clipboard.wells.length === 0) {
    return { ok: false, reason: "empty-clipboard" };
  }
  const anchor = plate.wells.find(
    (well) => well.wellId === destinationAnchorWellId,
  );
  if (!anchor) return { ok: false, reason: "invalid-anchor" };

  const destinations = clipboard.wells.map((copied) => ({
    copied,
    row: anchor.row + copied.rowOffset,
    column: anchor.column + copied.columnOffset,
  }));
  if (
    destinations.some(
      ({ row, column }) =>
        row < 0 || row >= plate.rows || column < 0 || column >= plate.columns,
    )
  ) {
    return { ok: false, reason: "out-of-bounds" };
  }

  const destinationById = new Map(
    destinations.map((destination) => [
      formatWellId(destination.row, destination.column),
      destination,
    ]),
  );
  const overwrittenWellIds = plate.wells
    .filter(
      (well) =>
        destinationById.has(well.wellId) && Boolean(well.sample && well.gene),
    )
    .map((well) => well.wellId);
  const wells = plate.wells.map((well) => {
    const destination = destinationById.get(well.wellId);
    if (!destination) return well;
    return {
      ...well,
      sample: destination.copied.sample,
      gene: destination.copied.gene,
      geneType: destination.copied.geneType,
      replicateIndex: destination.copied.replicateIndex,
      source: "manual" as const,
    };
  });
  return {
    ok: true,
    plate: { ...plate, wells },
    pastedWellIds: destinations.map(({ row, column }) =>
      formatWellId(row, column),
    ),
    overwrittenWellIds,
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

export function translateSelectedWells(
  plate: PlannerPlate,
  selectedWellIds: string[],
  destinationAnchorWellId: string,
  allowOverwrite = false,
): TranslateSelectionResult {
  const selected = new Set(selectedWellIds);
  const sources = plate.wells
    .filter(
      (well) =>
        selected.has(well.wellId) &&
        Boolean(well.sample) &&
        Boolean(well.gene),
    )
    .sort((left, right) => left.row - right.row || left.column - right.column);
  const destinationAnchor = plate.wells.find(
    (well) => well.wellId === destinationAnchorWellId,
  );
  if (sources.length === 0 || !destinationAnchor) {
    return { ok: false, reason: "empty-selection" };
  }

  const minRow = Math.min(...sources.map((well) => well.row));
  const minColumn = Math.min(...sources.map((well) => well.column));
  const deltaRow = destinationAnchor.row - minRow;
  const deltaColumn = destinationAnchor.column - minColumn;
  const moves = sources.map((well) => ({
    source: well,
    row: well.row + deltaRow,
    column: well.column + deltaColumn,
  }));
  if (
    moves.some(
      (move) =>
        move.row < 0 ||
        move.row >= plate.rows ||
        move.column < 0 ||
        move.column >= plate.columns,
    )
  ) {
    return { ok: false, reason: "out-of-bounds" };
  }

  const sourceIds = new Set(sources.map((well) => well.wellId));
  const destinationIds = new Set(
    moves.map((move) => formatWellId(move.row, move.column)),
  );
  const collisionWellIds = plate.wells
    .filter(
      (well) =>
        destinationIds.has(well.wellId) &&
        !sourceIds.has(well.wellId) &&
        Boolean(well.sample) &&
        Boolean(well.gene),
    )
    .map((well) => well.wellId);
  if (collisionWellIds.length > 0 && !allowOverwrite) {
    return {
      ok: false,
      reason: "collision",
      collisionWellIds,
    };
  }

  const nextWells = plate.wells.map((well) =>
    sourceIds.has(well.wellId) ? emptyManualWell(well) : { ...well },
  );
  const indexByWellId = new Map(
    nextWells.map((well, index) => [well.wellId, index]),
  );
  for (const move of moves) {
    const destinationWellId = formatWellId(move.row, move.column);
    const destinationIndex = indexByWellId.get(destinationWellId);
    if (destinationIndex === undefined) {
      return { ok: false, reason: "out-of-bounds" };
    }
    nextWells[destinationIndex] = {
      ...move.source,
      wellId: destinationWellId,
      row: move.row,
      column: move.column,
      source: "manual",
    };
  }

  return {
    ok: true,
    plate: { ...plate, wells: nextWells },
    movedWellIds: moves.map((move) => formatWellId(move.row, move.column)),
    overwrittenWellIds: collisionWellIds,
  };
}
