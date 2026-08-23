import {
  formatWellId,
  refreshPlanDerivedData,
  validateLayout,
  type GeneType,
  type PlanInput,
  type PlanResult,
  type PlannerPlate,
  type PlannerWell,
  type ValidationResult,
} from "./platePlanner";

const HISTORY_LIMIT = 30;

interface CopiedWell {
  rowOffset: number;
  columnOffset: number;
  sample: string | null;
  gene: string | null;
  geneType: GeneType | null;
  replicateIndex: number | null;
}

interface WellClipboard {
  wells: CopiedWell[];
}

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

function assignSelectedWells(
  plate: PlannerPlate,
  wellIds: readonly string[],
  assignment: {
    sample: string | null;
    gene: string | null;
    geneType: GeneType | null;
  },
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
        source: "manual" as const,
      };
    }),
  };
}

function copySelectedWells(
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

function clipboardMatchesExperiment(
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

type PasteResult =
  | {
      ok: true;
      plate: PlannerPlate;
      pastedWellIds: string[];
      overwrittenWellIds: string[];
    }
  | { ok: false; reason: "empty-clipboard" | "invalid-anchor" | "out-of-bounds" };

function pasteCopiedWells(
  plate: PlannerPlate,
  clipboard: WellClipboard,
  destinationAnchorWellId: string,
): PasteResult {
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

function restoreSelectedWells(
  currentPlate: PlannerPlate,
  automaticPlate: PlannerPlate,
  selectedWellIds: readonly string[],
) {
  const selected = new Set(selectedWellIds);
  const automaticByWellId = new Map(
    automaticPlate.wells.map((well) => [well.wellId, well]),
  );
  return {
    ...currentPlate,
    wells: currentPlate.wells.map((well) =>
      selected.has(well.wellId)
        ? { ...(automaticByWellId.get(well.wellId) ?? well) }
        : well,
    ),
  };
}

type TranslateResult =
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

function translateSelectedWells(
  plate: PlannerPlate,
  selectedWellIds: readonly string[],
  destinationAnchorWellId: string,
  allowOverwrite = false,
): TranslateResult {
  const selected = new Set(selectedWellIds);
  const sources = plate.wells
    .filter(
      (well) =>
        selected.has(well.wellId) && Boolean(well.sample) && Boolean(well.gene),
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
      ({ row, column }) =>
        row < 0 || row >= plate.rows || column < 0 || column >= plate.columns,
    )
  ) {
    return { ok: false, reason: "out-of-bounds" };
  }
  const sourceIds = new Set(sources.map((well) => well.wellId));
  const destinationIds = new Set(
    moves.map(({ row, column }) => formatWellId(row, column)),
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
    return { ok: false, reason: "collision", collisionWellIds };
  }
  const nextWells = plate.wells.map((well) =>
    sourceIds.has(well.wellId) ? emptyManualWell(well) : { ...well },
  );
  const indexByWellId = new Map(
    nextWells.map((well, index) => [well.wellId, index]),
  );
  for (const move of moves) {
    const wellId = formatWellId(move.row, move.column);
    const index = indexByWellId.get(wellId);
    if (index === undefined) return { ok: false, reason: "out-of-bounds" };
    nextWells[index] = {
      ...move.source,
      wellId,
      row: move.row,
      column: move.column,
      source: "manual",
    };
  }
  return {
    ok: true,
    plate: { ...plate, wells: nextWells },
    movedWellIds: moves.map(({ row, column }) => formatWellId(row, column)),
    overwrittenWellIds: collisionWellIds,
  };
}

export interface PlateSelection {
  plateNumber: number | null;
  wellIds: string[];
  anchorWellId: string | null;
}

interface HistorySnapshot {
  plan: PlanResult;
  selection: PlateSelection;
  moveMode: boolean;
}

export interface PlateEditingSession {
  plan: PlanResult;
  generatedBaseline: PlanResult;
  planInput: PlanInput;
  selection: PlateSelection;
  clipboard: WellClipboard | null;
  moveMode: boolean;
  confirmedPlateNumbers: Set<number>;
  undoStack: HistorySnapshot[];
  redoStack: HistorySnapshot[];
  audit: ValidationResult;
}

export interface CreatePlateEditingSessionInput {
  plan: PlanResult;
  generatedBaseline: PlanResult;
  planInput: PlanInput;
  confirmedPlateNumbers?: Iterable<number>;
}

type SelectionMode = "replace" | "add" | "toggle";

export type PlateEditCommand =
  | {
      type: "select";
      plateNumber: number;
      wellIds: string[];
      mode: SelectionMode;
      anchorWellId?: string | null;
    }
  | {
      type: "select-range";
      plateNumber: number;
      anchorWellId: string;
      endWellId: string;
      mode: "replace" | "add";
      baseWellIds?: string[];
    }
  | { type: "copy" }
  | {
      type: "paste";
      plateNumber: number;
      destinationWellId: string;
      allowOverwrite?: boolean;
    }
  | {
      type: "assign";
      sample: string;
      gene: string;
      geneType: GeneType;
    }
  | { type: "clear" }
  | { type: "restore-selected" }
  | {
      type: "move";
      plateNumber: number;
      destinationWellId: string;
      allowOverwrite?: boolean;
    }
  | { type: "set-move-mode"; enabled: boolean }
  | { type: "rename-plate"; plateNumber: number; name: string }
  | { type: "restore-plate"; plateNumber: number }
  | { type: "set-confirmed"; plateNumber: number; confirmed: boolean }
  | { type: "undo" }
  | { type: "redo" };

export type PlateEditOutcome = {
  status:
    | "selected"
    | "copied"
    | "applied"
    | "conflict"
    | "rejected"
    | "undone"
    | "redone"
    | "noop";
  reason?:
    | "no-selection"
    | "plate-not-found"
    | "baseline-not-found"
    | "empty-clipboard"
    | "clipboard-incompatible"
    | "invalid-anchor"
    | "out-of-bounds"
    | "collision"
    | "nothing-to-undo"
    | "nothing-to-redo";
  wellIds?: string[];
  affectedPlateNumbers?: number[];
};

export interface PlateEditResult {
  session: PlateEditingSession;
  outcome: PlateEditOutcome;
}

function cloneSelection(selection: PlateSelection): PlateSelection {
  return { ...selection, wellIds: [...selection.wellIds] };
}

function snapshot(session: PlateEditingSession): HistorySnapshot {
  return {
    plan: session.plan,
    selection: cloneSelection(session.selection),
    moveMode: session.moveMode,
  };
}

function cappedHistory(
  stack: readonly HistorySnapshot[],
  entry: HistorySnapshot,
) {
  return [...stack, entry].slice(-HISTORY_LIMIT);
}

function plateByNumber(plan: PlanResult, plateNumber: number) {
  return plan.plates.find((plate) => plate.plateNumber === plateNumber);
}

function rectangularWellIds(
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

function replacePlate(plan: PlanResult, replacement: PlannerPlate) {
  return {
    ...plan,
    plates: plan.plates.map((plate) =>
      plate.plateNumber === replacement.plateNumber ? replacement : plate,
    ),
  };
}

function appliedMutation(
  session: PlateEditingSession,
  plan: PlanResult,
  selection: PlateSelection,
  affectedPlateNumbers: number[],
): PlateEditResult {
  const refreshedPlan = refreshPlanDerivedData(plan, session.planInput);
  const invalidated = new Set(affectedPlateNumbers);
  const nextSession: PlateEditingSession = {
    ...session,
    plan: refreshedPlan,
    selection,
    confirmedPlateNumbers: new Set(
      [...session.confirmedPlateNumbers].filter(
        (plateNumber) => !invalidated.has(plateNumber),
      ),
    ),
    undoStack: cappedHistory(session.undoStack, snapshot(session)),
    redoStack: [],
    audit: validateLayout(refreshedPlan, session.planInput),
  };
  return {
    session: nextSession,
    outcome: {
      status: "applied",
      affectedPlateNumbers,
      wellIds: [...selection.wellIds],
    },
  };
}

function rejected(
  session: PlateEditingSession,
  reason: PlateEditOutcome["reason"],
): PlateEditResult {
  return { session, outcome: { status: "rejected", reason } };
}

export function createPlateEditingSession({
  plan,
  generatedBaseline,
  planInput,
  confirmedPlateNumbers = [],
}: CreatePlateEditingSessionInput): PlateEditingSession {
  const refreshedPlan = refreshPlanDerivedData(plan, planInput);
  return {
    plan: refreshedPlan,
    generatedBaseline,
    planInput,
    selection: { plateNumber: null, wellIds: [], anchorWellId: null },
    clipboard: null,
    moveMode: false,
    confirmedPlateNumbers: new Set(confirmedPlateNumbers),
    undoStack: [],
    redoStack: [],
    audit: validateLayout(refreshedPlan, planInput),
  };
}

export function dispatchPlateEdit(
  session: PlateEditingSession,
  command: PlateEditCommand,
): PlateEditResult {
  if (command.type === "select-range") {
    const plate = plateByNumber(session.plan, command.plateNumber);
    if (!plate) return rejected(session, "plate-not-found");
    const range = rectangularWellIds(
      plate,
      command.anchorWellId,
      command.endWellId,
    );
    const base =
      command.baseWellIds ??
      (session.selection.plateNumber === command.plateNumber
        ? session.selection.wellIds
        : []);
    const wellIds =
      command.mode === "add"
        ? Array.from(new Set([...base, ...range]))
        : range;
    const selection: PlateSelection = {
      plateNumber: command.plateNumber,
      wellIds,
      anchorWellId: command.endWellId,
    };
    return {
      session: { ...session, selection },
      outcome: { status: "selected", wellIds },
    };
  }

  if (command.type === "select") {
    const plate = plateByNumber(session.plan, command.plateNumber);
    if (!plate) return rejected(session, "plate-not-found");
    const validIds = new Set(plate.wells.map((well) => well.wellId));
    const requested = command.wellIds.filter((wellId) => validIds.has(wellId));
    const previous =
      session.selection.plateNumber === command.plateNumber
        ? session.selection.wellIds
        : [];
    const selected = new Set(command.mode === "replace" ? [] : previous);
    for (const wellId of requested) {
      if (command.mode === "toggle" && selected.has(wellId)) {
        selected.delete(wellId);
      } else {
        selected.add(wellId);
      }
    }
    const selection = {
      plateNumber: command.plateNumber,
      wellIds: [...selected],
      anchorWellId:
        command.anchorWellId === undefined
          ? (requested.at(-1) ?? null)
          : command.anchorWellId,
    };
    return {
      session: { ...session, selection },
      outcome: { status: "selected", wellIds: selection.wellIds },
    };
  }

  if (command.type === "copy") {
    if (
      session.selection.plateNumber === null ||
      session.selection.wellIds.length === 0
    ) {
      return rejected(session, "no-selection");
    }
    const plate = plateByNumber(session.plan, session.selection.plateNumber);
    if (!plate) return rejected(session, "plate-not-found");
    const clipboard = copySelectedWells(plate, session.selection.wellIds);
    if (clipboard.wells.length === 0) return rejected(session, "no-selection");
    return {
      session: { ...session, clipboard },
      outcome: { status: "copied", wellIds: session.selection.wellIds },
    };
  }

  if (command.type === "paste") {
    const plate = plateByNumber(session.plan, command.plateNumber);
    if (!plate) return rejected(session, "plate-not-found");
    if (!session.clipboard) return rejected(session, "empty-clipboard");
    if (
      !clipboardMatchesExperiment(
        session.clipboard,
        session.planInput.samples,
        [
          ...session.planInput.targetGenes,
          ...session.planInput.referenceGenes,
        ],
      )
    ) {
      return rejected(session, "clipboard-incompatible");
    }
    const pasted = pasteCopiedWells(
      plate,
      session.clipboard,
      command.destinationWellId,
    );
    if (!pasted.ok) return rejected(session, pasted.reason);
    if (pasted.overwrittenWellIds.length > 0 && !command.allowOverwrite) {
      return {
        session,
        outcome: {
          status: "conflict",
          reason: "collision",
          wellIds: pasted.overwrittenWellIds,
        },
      };
    }
    return appliedMutation(
      session,
      replacePlate(session.plan, pasted.plate),
      {
        plateNumber: command.plateNumber,
        wellIds: pasted.pastedWellIds,
        anchorWellId: command.destinationWellId,
      },
      [command.plateNumber],
    );
  }

  if (command.type === "assign" || command.type === "clear") {
    if (session.selection.plateNumber === null) {
      return rejected(session, "no-selection");
    }
    const plate = plateByNumber(session.plan, session.selection.plateNumber);
    if (!plate || session.selection.wellIds.length === 0) {
      return rejected(session, plate ? "no-selection" : "plate-not-found");
    }
    const assignment =
      command.type === "assign"
        ? {
            sample: command.sample,
            gene: command.gene,
            geneType: command.geneType,
          }
        : { sample: null, gene: null, geneType: null };
    const changed = assignSelectedWells(
      plate,
      session.selection.wellIds,
      assignment,
    );
    return appliedMutation(
      session,
      replacePlate(session.plan, changed),
      cloneSelection(session.selection),
      [plate.plateNumber],
    );
  }

  if (command.type === "restore-selected") {
    if (session.selection.plateNumber === null) {
      return rejected(session, "no-selection");
    }
    const plate = plateByNumber(session.plan, session.selection.plateNumber);
    const baseline = plateByNumber(
      session.generatedBaseline,
      session.selection.plateNumber,
    );
    if (!plate) return rejected(session, "plate-not-found");
    if (!baseline) return rejected(session, "baseline-not-found");
    if (session.selection.wellIds.length === 0) {
      return rejected(session, "no-selection");
    }
    const restored = restoreSelectedWells(
      plate,
      baseline,
      session.selection.wellIds,
    );
    return appliedMutation(
      session,
      replacePlate(session.plan, restored),
      cloneSelection(session.selection),
      [plate.plateNumber],
    );
  }

  if (command.type === "move") {
    if (session.selection.plateNumber !== command.plateNumber) {
      return rejected(session, "no-selection");
    }
    const plate = plateByNumber(session.plan, command.plateNumber);
    if (!plate) return rejected(session, "plate-not-found");
    const moved = translateSelectedWells(
      plate,
      session.selection.wellIds,
      command.destinationWellId,
      command.allowOverwrite,
    );
    if (!moved.ok) {
      if (moved.reason === "collision") {
        return {
          session,
          outcome: {
            status: "conflict",
            reason: "collision",
            wellIds: moved.collisionWellIds,
          },
        };
      }
      return rejected(session, moved.reason);
    }
    return appliedMutation(
      session,
      replacePlate(session.plan, moved.plate),
      {
        plateNumber: command.plateNumber,
        wellIds: moved.movedWellIds,
        anchorWellId: command.destinationWellId,
      },
      [command.plateNumber],
    );
  }

  if (command.type === "set-move-mode") {
    return {
      session: { ...session, moveMode: command.enabled },
      outcome: { status: "selected" },
    };
  }

  if (command.type === "rename-plate") {
    const plate = plateByNumber(session.plan, command.plateNumber);
    if (!plate) return rejected(session, "plate-not-found");
    const changed = { ...plate, name: command.name };
    return appliedMutation(
      session,
      replacePlate(session.plan, changed),
      cloneSelection(session.selection),
      [command.plateNumber],
    );
  }

  if (command.type === "restore-plate") {
    const current = plateByNumber(session.plan, command.plateNumber);
    const baseline = plateByNumber(
      session.generatedBaseline,
      command.plateNumber,
    );
    if (!current) return rejected(session, "plate-not-found");
    if (!baseline) return rejected(session, "baseline-not-found");
    const restored = appliedMutation(
      session,
      replacePlate(session.plan, { ...baseline, name: current.name }),
      { plateNumber: command.plateNumber, wellIds: [], anchorWellId: null },
      [command.plateNumber],
    );
    return {
      ...restored,
      session: { ...restored.session, moveMode: false },
    };
  }

  if (command.type === "set-confirmed") {
    if (!plateByNumber(session.plan, command.plateNumber)) {
      return rejected(session, "plate-not-found");
    }
    const confirmedPlateNumbers = new Set(session.confirmedPlateNumbers);
    if (command.confirmed) confirmedPlateNumbers.add(command.plateNumber);
    else confirmedPlateNumbers.delete(command.plateNumber);
    return {
      session: { ...session, confirmedPlateNumbers },
      outcome: { status: "applied", affectedPlateNumbers: [] },
    };
  }

  if (command.type === "undo" || command.type === "redo") {
    const sourceStack =
      command.type === "undo" ? session.undoStack : session.redoStack;
    const target = sourceStack.at(-1);
    if (!target) {
      return rejected(
        session,
        command.type === "undo" ? "nothing-to-undo" : "nothing-to-redo",
      );
    }
    const changedPlateNumbers = session.plan.plates
      .filter((plate, index) => plate !== target.plan.plates[index])
      .map((plate) => plate.plateNumber);
    const plan = refreshPlanDerivedData(target.plan, session.planInput);
    const next: PlateEditingSession = {
      ...session,
      plan,
      selection: cloneSelection(target.selection),
      moveMode: target.moveMode,
      confirmedPlateNumbers: new Set(
        [...session.confirmedPlateNumbers].filter(
          (plateNumber) => !changedPlateNumbers.includes(plateNumber),
        ),
      ),
      undoStack:
        command.type === "undo"
          ? session.undoStack.slice(0, -1)
          : cappedHistory(session.undoStack, snapshot(session)),
      redoStack:
        command.type === "redo"
          ? session.redoStack.slice(0, -1)
          : cappedHistory(session.redoStack, snapshot(session)),
      audit: validateLayout(plan, session.planInput),
    };
    return {
      session: next,
      outcome: {
        status: command.type === "undo" ? "undone" : "redone",
        affectedPlateNumbers: changedPlateNumbers,
      },
    };
  }

  return { session, outcome: { status: "noop" } };
}

export function dispatchPlateEdits(
  session: PlateEditingSession,
  commands: readonly PlateEditCommand[],
): PlateEditResult {
  let result: PlateEditResult = {
    session,
    outcome: { status: "noop" },
  };
  for (const command of commands) {
    result = dispatchPlateEdit(result.session, command);
    if (
      result.outcome.status === "rejected" ||
      result.outcome.status === "conflict"
    ) {
      break;
    }
  }
  return result;
}
