import {
  refreshPlanDerivedData,
  validateLayout,
  type GeneType,
  type PlanInput,
  type PlanResult,
  type PlannerPlate,
  type ValidationResult,
} from "./platePlanner";
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
  translateSelectedWells,
  type ManualLayoutPatch,
  type WellClipboard,
} from "./manualLayout";

const HISTORY_LIMIT = 30;

export interface PlateSelection {
  plateNumber: number | null;
  wellIds: string[];
  anchorWellId: string | null;
}

interface HistorySnapshot {
  patch: ManualLayoutPatch;
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

function historySnapshot(
  session: PlateEditingSession,
  patch: ManualLayoutPatch,
): HistorySnapshot {
  return {
    patch,
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
  const undoPatch = createManualLayoutPatch(
    refreshedPlan,
    session.plan,
    affectedPlateNumbers,
  );
  const nextSession: PlateEditingSession = {
    ...session,
    plan: refreshedPlan,
    selection,
    confirmedPlateNumbers: new Set(
      [...session.confirmedPlateNumbers].filter(
        (plateNumber) => !invalidated.has(plateNumber),
      ),
    ),
    undoStack: cappedHistory(
      session.undoStack,
      historySnapshot(session, undoPatch),
    ),
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
    const wellIds = applyBoxSelection(base, range, command.mode);
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
    const applied = appliedMutation(
      session,
      replacePlate(session.plan, moved.plate),
      {
        plateNumber: command.plateNumber,
        wellIds: moved.movedWellIds,
        anchorWellId: command.destinationWellId,
      },
      [command.plateNumber],
    );
    return {
      ...applied,
      session: { ...applied.session, moveMode: false },
    };
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
    const changedPlateNumbers = target.patch.plateNumbers;
    const patchedPlan = applyManualLayoutPatch(session.plan, target.patch);
    const plan = refreshPlanDerivedData(patchedPlan, session.planInput);
    const oppositeSnapshot = historySnapshot(
      session,
      invertManualLayoutPatch(target.patch),
    );
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
          : cappedHistory(session.undoStack, oppositeSnapshot),
      redoStack:
        command.type === "redo"
          ? session.redoStack.slice(0, -1)
          : cappedHistory(session.redoStack, oppositeSnapshot),
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
