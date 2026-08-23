import {
  createPlateEditingSession,
  dispatchPlateEdit,
  dispatchPlateEdits,
  type PlateEditCommand,
  type PlateEditOutcome,
  type PlateEditingSession,
} from "./plateEditingSession";
import {
  defaultPlateName,
  planPlateLayout,
  type LayoutFillDirection,
  type LayoutPreset,
  type LoadingPattern,
  type PlanInput,
  type PlanResult,
  type PlateType,
  validateLayout,
} from "./platePlanner";
import {
  calculateReactionRequirements,
  DEFAULT_REACTION_SYSTEM,
  normalizeReactionSystemInput,
  type LegacyReactionSystemInput,
  type ReactionSystemInput,
} from "./reactionCalculator";
import {
  createEntryHistory,
  recordEntryState,
  redoEntryState,
  undoEntryState,
  type EntryHistory,
} from "./entryHistory";

export type PlannerLanguage = "zh" | "en";
export type SampleKind = "sample" | "blank";
export type GeneRole = "target" | "reference";

export interface SampleEntry {
  id: string;
  name: string;
  kind: SampleKind;
  cellLine?: string;
  comparisonGroup?: string;
  isBridge?: boolean;
}

export interface GeneEntry {
  id: string;
  name: string;
  role: GeneRole;
}

export interface ExperimentSetup {
  plateType: PlateType;
  samples: SampleEntry[];
  genes: GeneEntry[];
  replicates: number;
  layoutPreset: LayoutPreset;
  loadingPattern: LoadingPattern;
  fillDirection: LayoutFillDirection;
}

export interface PlannerSession {
  setup: ExperimentSetup;
  entryHistory: EntryHistory<SampleEntry, GeneEntry>;
  plateEditing: PlateEditingSession | null;
  layoutSignature: string;
  generatedAt: string;
  reactionSystem: ReactionSystemInput;
  language: PlannerLanguage;
}

export interface CreatePlannerSessionInput {
  plateType?: PlateType;
  samples?: SampleEntry[];
  genes?: GeneEntry[];
  replicates?: number;
  layoutPreset?: LayoutPreset;
  loadingPattern?: LoadingPattern;
  fillDirection?: LayoutFillDirection;
  reactionSystem?: Partial<ReactionSystemInput> | LegacyReactionSystemInput;
  language?: PlannerLanguage;
}

export type PlannerSessionCommand =
  | { type: "patch-setup"; patch: Partial<ExperimentSetup> }
  | { type: "commit-entries"; samples: SampleEntry[]; genes: GeneEntry[] }
  | { type: "undo-entries" }
  | { type: "redo-entries" }
  | { type: "set-reaction-system"; reactionSystem: ReactionSystemInput }
  | { type: "set-language"; language: PlannerLanguage }
  | { type: "generate-layout"; generatedAt: string }
  | { type: "edit-plate"; command: PlateEditCommand }
  | { type: "edit-plate-many"; commands: PlateEditCommand[] }
  | { type: "reset" };

export interface PlannerSessionTransition {
  session: PlannerSession;
  outcome:
    | PlateEditOutcome
    | {
        status: "applied" | "rejected" | "noop";
        reason?: "no-plate-plan" | "generation-failed";
        message?: string;
      };
}

interface StoredPlannerSessionV9 {
  version: 9;
  setup: ExperimentSetup;
  plateEditing: {
    plan: PlanResult;
    generatedBaseline: PlanResult;
    confirmedPlateNumbers: number[];
  } | null;
  generation: {
    layoutSignature: string;
    generatedAt: string;
  };
  reactionSystem: ReactionSystemInput;
  language: PlannerLanguage;
}

type StoredPlannerSessionV8 = Omit<StoredPlannerSessionV9, "version"> & {
  version: 8;
};

type LegacyStoredPlannerSession = Record<string, unknown> & {
  version: number;
  plateType: PlateType;
  samples: SampleEntry[] | string[];
  genes: GeneEntry[];
  replicates: number;
  layout?: PlanResult | null;
  automaticLayout?: PlanResult | null;
  layoutSignature?: string;
  generatedAt?: string;
  confirmed?: Record<string, boolean>;
  reactionSystem?: Partial<ReactionSystemInput> | LegacyReactionSystemInput;
  language?: PlannerLanguage;
  layoutPreset?: LayoutPreset;
  loadingPattern?: LoadingPattern;
  fillDirection?: LayoutFillDirection;
};

export interface RestorePlannerSessionOptions {
  createId?: (prefix: "sample", index: number) => string;
}

export type RestorePlannerSessionResult = {
  ok: boolean;
  session: PlannerSession;
  migratedFrom: number | null;
};

function defaultLoadingPattern(plateType: PlateType): LoadingPattern {
  return plateType === 384 ? "interleaved-8-channel" : "sequential";
}

function defaultId(prefix: "sample", index: number) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${index}`;
}

function clonePlan<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function plannerSessionPlanInput(setup: ExperimentSetup): PlanInput {
  return {
    plateType: setup.plateType,
    samples: setup.samples.map((sample) => sample.name.trim()).filter(Boolean),
    sampleDesigns: setup.samples
      .filter((sample) => sample.name.trim())
      .map((sample) => ({
        name: sample.name.trim(),
        kind: sample.kind,
        cellLine: sample.cellLine?.trim(),
        comparisonGroup: sample.comparisonGroup?.trim(),
        isBridge: Boolean(sample.isBridge),
      })),
    targetGenes: setup.genes
      .filter((gene) => gene.role === "target" && gene.name.trim())
      .map((gene) => gene.name.trim()),
    referenceGenes: setup.genes
      .filter((gene) => gene.role === "reference" && gene.name.trim())
      .map((gene) => gene.name.trim()),
    replicates: setup.replicates,
  };
}

export function plannerSessionSignature(setup: ExperimentSetup) {
  return JSON.stringify({
    plateType: setup.plateType,
    samples: setup.samples.map(
      ({ name, kind, cellLine, comparisonGroup, isBridge }) => ({
        name,
        kind,
        cellLine: cellLine ?? "",
        comparisonGroup: comparisonGroup ?? "",
        isBridge: Boolean(isBridge),
      }),
    ),
    genes: setup.genes.map(({ name, role }) => ({ name, role })),
    replicates: setup.replicates,
    layoutPreset: setup.layoutPreset,
    loadingPattern: setup.loadingPattern,
    fillDirection: setup.fillDirection,
  });
}

function legacySignatureV2(setup: ExperimentSetup) {
  return JSON.stringify({
    plateType: setup.plateType,
    samples: setup.samples.map(({ name }) => name),
    genes: setup.genes.map(({ name, role }) => ({ name, role })),
    replicates: setup.replicates,
  });
}

function legacySignatureV3(setup: ExperimentSetup) {
  return JSON.stringify({
    plateType: setup.plateType,
    samples: setup.samples.map(({ name }) => name),
    genes: setup.genes.map(({ name, role }) => ({ name, role })),
    replicates: setup.replicates,
    layoutPreset: setup.layoutPreset,
  });
}

function migrateSignature(signature: string, setup: ExperimentSetup) {
  if (!signature) return "";
  return signature === legacySignatureV2(setup) ||
    signature === legacySignatureV3(setup)
    ? plannerSessionSignature(setup)
    : signature;
}

function withPlateNames(
  result: PlanResult | null | undefined,
  loadingPattern: LoadingPattern,
  fillDirection: LayoutFillDirection,
) {
  if (!result) return null;
  return {
    ...result,
    loadingPattern: result.loadingPattern ?? loadingPattern,
    fillDirection: result.fillDirection ?? fillDirection,
    plates: result.plates.map((plate) => ({
      ...plate,
      name: plate.name?.trim() || defaultPlateName(plate.plateNumber),
    })),
  };
}

function confirmedPlateNumbers(confirmed: Record<string, boolean> = {}) {
  return Object.entries(confirmed)
    .filter(([, value]) => value)
    .map(([plateNumber]) => Number(plateNumber))
    .filter(Number.isFinite);
}

function inferredLayoutPreset(plan: PlanResult | null | undefined): LayoutPreset {
  return plan?.strategy === "gene-major" ? "gene-major" : "sample-major";
}

function editingSessionFromStored(
  plan: PlanResult | null,
  baseline: PlanResult | null,
  setup: ExperimentSetup,
  confirmed: Iterable<number>,
) {
  if (!plan || !baseline) return null;
  return createPlateEditingSession({
    plan,
    generatedBaseline: baseline,
    planInput: plannerSessionPlanInput(setup),
    confirmedPlateNumbers: confirmed,
  });
}

export function createPlannerSession(
  input: CreatePlannerSessionInput = {},
): PlannerSession {
  const plateType = input.plateType ?? 96;
  return {
    setup: {
      plateType,
      samples: input.samples ?? [],
      genes: input.genes ?? [],
      replicates: input.replicates ?? 3,
      layoutPreset: input.layoutPreset ?? "gene-major",
      loadingPattern:
        input.loadingPattern ?? defaultLoadingPattern(plateType),
      fillDirection: input.fillDirection ?? "vertical",
    },
    plateEditing: null,
    entryHistory: createEntryHistory({
      samples: input.samples ?? [],
      genes: input.genes ?? [],
    }),
    layoutSignature: "",
    generatedAt: "",
    reactionSystem: normalizeReactionSystemInput(
      input.reactionSystem ?? DEFAULT_REACTION_SYSTEM,
    ),
    language: input.language ?? "zh",
  };
}

export function plannerSessionIsStale(session: PlannerSession) {
  return Boolean(
    session.plateEditing &&
      session.layoutSignature !== plannerSessionSignature(session.setup),
  );
}

export function plannerSessionAudit(session: PlannerSession) {
  if (!session.plateEditing) return { valid: false, errors: [] };
  return plannerSessionIsStale(session)
    ? validateLayout(
        session.plateEditing.plan,
        plannerSessionPlanInput(session.setup),
      )
    : session.plateEditing.audit;
}

export function plannerSessionReactionCalculation(session: PlannerSession) {
  const sampleNames = session.setup.samples
    .map((sample) => sample.name.trim())
    .filter(Boolean);
  const blankSampleNames = session.setup.samples
    .filter((sample) => sample.kind === "blank" && sample.name.trim())
    .map((sample) => sample.name.trim());
  const genes = session.setup.genes
    .filter((gene) => gene.name.trim())
    .map((gene) => ({ name: gene.name.trim(), role: gene.role }));
  return calculateReactionRequirements(
    session.plateEditing?.plan ?? null,
    session.reactionSystem,
    sampleNames,
    genes,
    blankSampleNames,
  );
}

export function dispatchPlannerSession(
  session: PlannerSession,
  command: PlannerSessionCommand,
): PlannerSessionTransition {
  if (command.type === "patch-setup") {
    return {
      session: {
        ...session,
        setup: { ...session.setup, ...command.patch },
      },
      outcome: { status: "applied" },
    };
  }
  if (command.type === "commit-entries") {
    const syncedHistory = {
      ...session.entryHistory,
      present: {
        samples: [...session.setup.samples],
        genes: [...session.setup.genes],
      },
    };
    return {
      session: {
        ...session,
        entryHistory: recordEntryState(syncedHistory, {
          samples: command.samples,
          genes: command.genes,
        }),
        setup: {
          ...session.setup,
          samples: command.samples,
          genes: command.genes,
        },
      },
      outcome: { status: "applied" },
    };
  }
  if (command.type === "undo-entries" || command.type === "redo-entries") {
    const syncedHistory = {
      ...session.entryHistory,
      present: {
        samples: [...session.setup.samples],
        genes: [...session.setup.genes],
      },
    };
    const history =
      command.type === "undo-entries"
        ? undoEntryState(syncedHistory)
        : redoEntryState(syncedHistory);
    if (history === syncedHistory) {
      return { session, outcome: { status: "noop" } };
    }
    return {
      session: {
        ...session,
        entryHistory: history,
        setup: {
          ...session.setup,
          samples: history.present.samples,
          genes: history.present.genes,
        },
      },
      outcome: { status: "applied" },
    };
  }
  if (command.type === "set-reaction-system") {
    return {
      session: { ...session, reactionSystem: command.reactionSystem },
      outcome: { status: "applied" },
    };
  }
  if (command.type === "set-language") {
    return {
      session: { ...session, language: command.language },
      outcome: { status: "applied" },
    };
  }
  if (command.type === "generate-layout") {
    try {
      const planInput = plannerSessionPlanInput(session.setup);
      const plan = planPlateLayout(planInput, {
        strategy: session.setup.layoutPreset,
        loadingPattern: session.setup.loadingPattern,
        fillDirection: session.setup.fillDirection,
      });
      return {
        session: {
          ...session,
          plateEditing: createPlateEditingSession({
            plan,
            generatedBaseline: clonePlan(plan),
            planInput,
          }),
          layoutSignature: plannerSessionSignature(session.setup),
          generatedAt: command.generatedAt,
        },
        outcome: { status: "applied" },
      };
    } catch (error) {
      return {
        session,
        outcome: {
          status: "rejected",
          reason: "generation-failed",
          message: error instanceof Error ? error.message : undefined,
        },
      };
    }
  }
  if (command.type === "edit-plate" || command.type === "edit-plate-many") {
    if (!session.plateEditing) {
      return {
        session,
        outcome: { status: "rejected", reason: "no-plate-plan" },
      };
    }
    const result =
      command.type === "edit-plate"
        ? dispatchPlateEdit(session.plateEditing, command.command)
        : dispatchPlateEdits(session.plateEditing, command.commands);
    return {
      session: { ...session, plateEditing: result.session },
      outcome: result.outcome,
    };
  }
  if (command.type === "reset") {
    return {
      session: createPlannerSession({ language: session.language }),
      outcome: { status: "applied" },
    };
  }
  return { session, outcome: { status: "noop" } };
}

export function serializePlannerSession(session: PlannerSession) {
  const payload: StoredPlannerSessionV9 = {
    version: 9,
    setup: session.setup,
    plateEditing: session.plateEditing
      ? {
          plan: session.plateEditing.plan,
          generatedBaseline: session.plateEditing.generatedBaseline,
          confirmedPlateNumbers: [
            ...session.plateEditing.confirmedPlateNumbers,
          ],
        }
      : null,
    generation: {
      layoutSignature: session.layoutSignature,
      generatedAt: session.generatedAt,
    },
    reactionSystem: session.reactionSystem,
    language: session.language,
  };
  return JSON.stringify(payload);
}

function restoreCurrent(
  raw: StoredPlannerSessionV8 | StoredPlannerSessionV9,
): PlannerSession {
  const samples = raw.setup.samples.map((sample) => ({
    ...sample,
    cellLine: sample.cellLine ?? "",
    comparisonGroup: sample.comparisonGroup ?? "",
    isBridge: Boolean(sample.isBridge),
  }));
  const session = createPlannerSession({
    ...raw.setup,
    samples,
    reactionSystem: raw.reactionSystem,
    language: raw.language,
  });
  return {
    ...session,
    plateEditing: raw.plateEditing
      ? editingSessionFromStored(
          raw.plateEditing.plan,
          raw.plateEditing.generatedBaseline,
          session.setup,
          raw.plateEditing.confirmedPlateNumbers,
        )
      : null,
    layoutSignature: raw.generation.layoutSignature,
    generatedAt: raw.generation.generatedAt,
  };
}

function restoreLegacy(
  raw: LegacyStoredPlannerSession,
  options: RestorePlannerSessionOptions,
) {
  const createId = options.createId ?? defaultId;
  const restoredSamples =
    raw.version === 1
      ? (raw.samples as string[]).map((name, index) => ({
          id: createId("sample", index),
          name,
          kind: "sample" as const,
        }))
      : (raw.samples as SampleEntry[]);
  const samples = restoredSamples.map((sample) => ({
    ...sample,
    cellLine: sample.cellLine ?? "",
    comparisonGroup: sample.comparisonGroup ?? "",
    isBridge: Boolean(sample.isBridge),
  }));
  const layoutPreset =
    raw.version <= 2
      ? inferredLayoutPreset(raw.layout)
      : (raw.layoutPreset ?? inferredLayoutPreset(raw.layout));
  const loadingPattern =
    raw.version <= 3
      ? "sequential"
      : raw.plateType === 96
        ? "sequential"
        : (raw.loadingPattern ?? defaultLoadingPattern(raw.plateType));
  const fillDirection =
    raw.version <= 6 ? "vertical" : (raw.fillDirection ?? "vertical");
  const setup: ExperimentSetup = {
    plateType: raw.plateType,
    samples,
    genes: raw.genes,
    replicates: raw.replicates,
    layoutPreset,
    loadingPattern,
    fillDirection,
  };
  const plan = withPlateNames(raw.layout, loadingPattern, fillDirection);
  const baseline = withPlateNames(
    raw.automaticLayout,
    loadingPattern,
    fillDirection,
  );
  const session = createPlannerSession({
    ...setup,
    reactionSystem: raw.reactionSystem,
    language: raw.language ?? "zh",
  });
  return {
    ...session,
    plateEditing: editingSessionFromStored(
      plan,
      baseline,
      setup,
      confirmedPlateNumbers(raw.confirmed),
    ),
    layoutSignature: migrateSignature(raw.layoutSignature ?? "", setup),
    generatedAt: raw.generatedAt ?? "",
  };
}

export function restorePlannerSession(
  serialized: string,
  options: RestorePlannerSessionOptions = {},
): RestorePlannerSessionResult {
  try {
    const raw = JSON.parse(serialized) as
      | StoredPlannerSessionV9
      | StoredPlannerSessionV8
      | LegacyStoredPlannerSession;
    if (!raw || typeof raw !== "object" || !("version" in raw)) {
      throw new Error("Invalid saved planner session");
    }
    if (raw.version === 9 || raw.version === 8) {
      return {
        ok: true,
        session: restoreCurrent(raw),
        migratedFrom: raw.version,
      };
    }
    if (raw.version < 1 || raw.version > 7) {
      throw new Error("Unsupported saved planner session version");
    }
    return {
      ok: true,
      session: restoreLegacy(raw, options),
      migratedFrom: raw.version,
    };
  } catch {
    return { ok: false, session: createPlannerSession(), migratedFrom: null };
  }
}
