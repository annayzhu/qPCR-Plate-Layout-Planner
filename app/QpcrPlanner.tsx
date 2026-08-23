"use client";

import {
  AlertTriangle,
  Beaker,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Download,
  FlaskConical,
  GripVertical,
  Info,
  Languages,
  Layers3,
  Minus,
  Move,
  Pencil,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  Fragment,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  exportAllPlateExcels,
  exportPlateExcel,
  type ExportContext,
  type ExportablePlate,
} from "@/lib/exportExcel";
import {
  moveEntryById,
  moveEntryByOffset,
  type EntrySnapshot,
} from "@/lib/entryHistory";
import { type ReactionSystemInput } from "@/lib/reactionCalculator";
import {
  generateNumberedEntries,
  MAX_QUICK_ENTRY_COUNT,
  parseQuickEntryCount,
} from "@/lib/quickEntries";
import { type PlateEditCommand } from "@/lib/plateEditingSession";
import {
  clearPlannerDraft,
  loadPlannerDraft,
  savePlannerDraft,
} from "@/lib/plannerDraftStorage";
import {
  createPlannerSession,
  dispatchPlannerSession,
  plannerSessionAudit,
  plannerSessionIsStale,
  plannerSessionReactionCalculation,
  type ExperimentSetup,
  type GeneEntry,
  type GeneRole,
  type PlannerLanguage,
  type PlannerSession,
  type PlannerSessionCommand,
  type SampleEntry,
  type SampleKind,
} from "@/lib/plannerSession";
import {
  formatWellId,
  getPlateDimensions,
  type GeneType,
  type LayoutFillDirection,
  type LayoutPreset,
  type LoadingPattern,
  type PlannerPlate,
  type PlannerWell,
  type PlanResult,
  type PlateType,
} from "@/lib/platePlanner";
import { ReactionCalculator } from "@/app/ReactionCalculator";

type Language = PlannerLanguage;

interface EditorState {
  plateIndex: number;
  wellIds: string[];
  mode: "assay" | "empty";
  sample: string;
  gene: string;
}

interface ToastState {
  tone: "success" | "error" | "neutral";
  message: string;
}

type EntryKind = "sample" | "gene";

interface DraggedEntry {
  kind: EntryKind;
  id: string;
}

interface BoxSelectionState {
  pointerId: number;
  anchorWellId: string;
  endWellId: string;
  baseWellIds: string[];
  mode: "replace" | "add";
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  active: boolean;
}

interface SortableEntryRowProps {
  entry: DraggedEntry;
  name: string;
  index: number;
  count: number;
  draggedEntry: DraggedEntry | null;
  dropTarget: DraggedEntry | null;
  dragLabel: string;
  dragTitle: string;
  moveUpLabel: string;
  moveDownLabel: string;
  onDragStart: (
    entry: DraggedEntry,
    event: ReactDragEvent<HTMLElement>,
  ) => void;
  onDragEnd: () => void;
  onDragOver: (
    entry: DraggedEntry,
    event: ReactDragEvent<HTMLDivElement>,
  ) => void;
  onDrop: (
    entry: DraggedEntry,
    event: ReactDragEvent<HTMLDivElement>,
  ) => void;
  onMove: (entry: DraggedEntry, offset: number) => void;
  children: ReactNode;
}

function SortableEntryRow({
  entry,
  name,
  index,
  count,
  draggedEntry,
  dropTarget,
  dragLabel,
  dragTitle,
  moveUpLabel,
  moveDownLabel,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onMove,
  children,
}: SortableEntryRowProps) {
  const isDragging =
    draggedEntry?.kind === entry.kind && draggedEntry.id === entry.id;
  const isDropTarget =
    dropTarget?.kind === entry.kind && dropTarget.id === entry.id;

  return (
    <div
      className={`sample-row sortable-row ${entry.kind}-entry-row ${
        isDragging ? "is-dragging" : ""
      } ${isDropTarget ? "is-drop-target" : ""}`}
      onDragOver={(event) => onDragOver(entry, event)}
      onDrop={(event) => onDrop(entry, event)}
    >
      <details className="entry-order-menu">
        <summary
          className="entry-drag-handle"
          draggable
          onDragStart={(event) => onDragStart(entry, event)}
          onDragEnd={onDragEnd}
          onKeyDown={(event) => {
            if (!event.altKey) return;
            if (event.key === "ArrowUp") {
              event.preventDefault();
              onMove(entry, -1);
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              onMove(entry, 1);
            }
          }}
          aria-label={dragLabel}
          title={dragTitle}
        >
          <GripVertical size={15} />
        </summary>
        <div className="entry-order-popover" aria-label={name}>
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onMove(entry, -1)}
          >
            <ChevronUp size={14} />
            {moveUpLabel}
          </button>
          <button
            type="button"
            disabled={index === count - 1}
            onClick={() => onMove(entry, 1)}
          >
            <ChevronDown size={14} />
            {moveDownLabel}
          </button>
        </div>
      </details>
      {children}
    </div>
  );
}

const TARGET_PALETTE = [
  { background: "#DDE8F2", text: "#29465E" },
  { background: "#DCEBE8", text: "#26564F" },
  { background: "#E4E2EF", text: "#4C466B" },
  { background: "#DCE7F0", text: "#2C506A" },
  { background: "#E1E9E3", text: "#385542" },
  { background: "#E3E5EC", text: "#454D60" },
];

function makeId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function resolveStateAction<T>(action: SetStateAction<T>, current: T) {
  return typeof action === "function"
    ? (action as (value: T) => T)(current)
    : action;
}

function parseExcelNames(value: string) {
  return value
    .split(/\t|\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSamplePaste(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => {
      const [name = "", cellLine = "", comparisonGroup = ""] = line
        .split("\t")
        .map((item) => item.trim());
      return { name, cellLine, comparisonGroup };
    })
    .filter((row) => row.name);
}

function normalizedKey(value: string) {
  return value.trim().toLocaleLowerCase();
}

function defaultLoadingPattern(plateType: PlateType): LoadingPattern {
  return plateType === 384 ? "interleaved-8-channel" : "sequential";
}

function strategyLabel(strategy: PlanResult["strategy"]) {
  if (strategy === "sample-major")
    return "按样本排列 / By sample";
  if (strategy === "gene-major")
    return "按基因排列 / By assay";
  return "混合分块 / Hybrid";
}

function targetColor(gene: string, targetGenes: string[]) {
  const index = Math.max(0, targetGenes.indexOf(gene));
  return TARGET_PALETTE[index % TARGET_PALETTE.length];
}

function wellVisual(
  well: PlannerWell,
  targetGenes: string[],
): CSSProperties {
  if (!well.gene || !well.geneType) return {};
  if (well.geneType === "reference") {
    return {
      "--well-bg": "#F3DFC4",
      "--well-ink": "#754A1D",
    } as CSSProperties;
  }
  const color = targetColor(well.gene, targetGenes);
  return {
    "--well-bg": color.background,
    "--well-ink": color.text,
  } as CSSProperties;
}

function shortLabel(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function plateStatus(
  confirmed: boolean,
  warningCount: number,
  stale: boolean,
  language: Language,
) {
  const tr = (zh: string, en: string) => (language === "zh" ? zh : en);
  if (stale)
    return { label: tr("设置已变更", "Stale"), className: "invalid" };
  if (confirmed)
    return { label: tr("已确认", "Confirmed"), className: "confirmed" };
  if (warningCount > 0)
    return { label: tr("有提醒", "Advisory"), className: "warning" };
  return { label: tr("草稿", "Draft"), className: "" };
}

export function QpcrPlanner() {
  const [plannerSession, setPlannerSession] = useState<PlannerSession>(() =>
    createPlannerSession(),
  );
  const plannerSessionRef = useRef(plannerSession);
  useEffect(() => {
    plannerSessionRef.current = plannerSession;
  }, [plannerSession]);
  const [draggedEntry, setDraggedEntry] = useState<DraggedEntry | null>(null);
  const [dropTarget, setDropTarget] = useState<DraggedEntry | null>(null);
  const [sampleInput, setSampleInput] = useState("");
  const [sampleInputKind, setSampleInputKind] =
    useState<SampleKind>("sample");
  const [sampleDraftOpen, setSampleDraftOpen] = useState(false);
  const [geneInput, setGeneInput] = useState("");
  const [geneInputRole, setGeneInputRole] =
    useState<GeneRole>("target");
  const [geneDraftOpen, setGeneDraftOpen] = useState(false);
  const [samplePaste, setSamplePaste] = useState("");
  const [genePaste, setGenePaste] = useState("");
  const [sampleQuickCount, setSampleQuickCount] = useState("");
  const [selectedSampleIds, setSelectedSampleIds] = useState<string[]>([]);
  const [bulkCellLine, setBulkCellLine] = useState("");
  const [bulkComparisonGroup, setBulkComparisonGroup] = useState("");
  const entryEditStartRef = useRef<EntrySnapshot<SampleEntry, GeneEntry> | null>(null);
  const [geneQuickCount, setGeneQuickCount] = useState("");
  const [activePlateIndex, setActivePlateIndex] = useState(0);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [boxSelection, setBoxSelection] =
    useState<BoxSelectionState | null>(null);
  const boxSelectionRef = useRef<BoxSelectionState | null>(null);
  const suppressWellClickRef = useRef(false);
  const [plateZoom, setPlateZoom] = useState(1);
  const [editingPlateName, setEditingPlateName] = useState(false);
  const [plateNameDraft, setPlateNameDraft] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);
  const [savedAt, setSavedAt] = useState("");
  const [dirty, setDirty] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const {
    plateType,
    samples,
    genes,
    replicates,
    layoutPreset,
    loadingPattern,
    fillDirection,
  } = plannerSession.setup;
  const editingSession = plannerSession.plateEditing;
  const generatedAt = plannerSession.generatedAt;
  const reactionSystem = plannerSession.reactionSystem;
  const language = plannerSession.language;
  const entryHistory = plannerSession.entryHistory;
  const layout = editingSession?.plan ?? null;
  const confirmed = useMemo(
    () =>
      Object.fromEntries(
        [...(editingSession?.confirmedPlateNumbers ?? [])].map(
          (plateNumber) => [String(plateNumber), true],
        ),
      ) as Record<string, boolean>,
    [editingSession],
  );
  const selectedWellIds = editingSession?.selection.wellIds ?? [];
  const selectionAnchorId = editingSession?.selection.anchorWellId ?? null;
  const moveMode = editingSession?.moveMode ?? false;
  const wellClipboard = editingSession?.clipboard ?? null;
  const undoStack = editingSession?.undoStack ?? [];
  const redoStack = editingSession?.redoStack ?? [];

  function replacePlannerSession(next: PlannerSession) {
    plannerSessionRef.current = next;
    setPlannerSession(next);
  }

  function applyPlannerCommand(command: PlannerSessionCommand) {
    const result = dispatchPlannerSession(plannerSessionRef.current, command);
    replacePlannerSession(result.session);
    return result;
  }

  function patchPlannerSetup(patch: Partial<ExperimentSetup>) {
    applyPlannerCommand({ type: "patch-setup", patch });
  }

  function setPlateType(action: SetStateAction<PlateType>) {
    patchPlannerSetup({ plateType: resolveStateAction(action, plateType) });
  }

  function setSamples(action: SetStateAction<SampleEntry[]>) {
    patchPlannerSetup({ samples: resolveStateAction(action, samples) });
  }

  function setGenes(action: SetStateAction<GeneEntry[]>) {
    patchPlannerSetup({ genes: resolveStateAction(action, genes) });
  }

  function setReplicates(action: SetStateAction<number>) {
    patchPlannerSetup({ replicates: resolveStateAction(action, replicates) });
  }

  function setLayoutPreset(action: SetStateAction<LayoutPreset>) {
    patchPlannerSetup({
      layoutPreset: resolveStateAction(action, layoutPreset),
    });
  }

  function setLoadingPattern(action: SetStateAction<LoadingPattern>) {
    patchPlannerSetup({
      loadingPattern: resolveStateAction(action, loadingPattern),
    });
  }

  function setFillDirection(action: SetStateAction<LayoutFillDirection>) {
    patchPlannerSetup({
      fillDirection: resolveStateAction(action, fillDirection),
    });
  }

  function setReactionSystem(action: SetStateAction<ReactionSystemInput>) {
    const next = resolveStateAction(action, reactionSystem);
    applyPlannerCommand({
      type: "set-reaction-system",
      reactionSystem: next,
    });
  }

  function setLanguage(language: Language) {
    applyPlannerCommand({ type: "set-language", language });
  }

  const tr = useCallback(
    (zh: string, en: string) => (language === "zh" ? zh : en),
    [language],
  );
  const localizeMessage = (message: string) => {
    const divider = message.lastIndexOf(" / ");
    if (divider < 0) return message;
    return language === "zh"
      ? message.slice(0, divider)
      : message.slice(divider + 3);
  };
  const sampleNames = useMemo(
    () =>
      samples
        .map((sample) => sample.name.trim())
        .filter(Boolean),
    [samples],
  );
  const samplePasteRows = useMemo(
    () => parseSamplePaste(samplePaste),
    [samplePaste],
  );
  const genePasteNames = useMemo(
    () => parseExcelNames(genePaste),
    [genePaste],
  );
  const parsedSampleQuickCount = useMemo(
    () => parseQuickEntryCount(sampleQuickCount),
    [sampleQuickCount],
  );
  const parsedGeneQuickCount = useMemo(
    () => parseQuickEntryCount(geneQuickCount),
    [geneQuickCount],
  );
  const blankSampleNames = useMemo(
    () =>
      samples
        .filter(
          (sample) => sample.kind === "blank" && sample.name.trim(),
        )
        .map((sample) => sample.name.trim()),
    [samples],
  );
  const blankSampleSet = useMemo(
    () => new Set(blankSampleNames),
    [blankSampleNames],
  );
  const dimensions = getPlateDimensions(plateType);
  const completeGenes = useMemo(
    () =>
      genes
        .filter((gene) => gene.name.trim())
        .map((gene) => ({ ...gene, name: gene.name.trim() })),
    [genes],
  );
  const targetGenes = useMemo(
    () =>
      completeGenes
        .filter((gene) => gene.role === "target")
        .map((gene) => gene.name),
    [completeGenes],
  );
  const referenceGenes = useMemo(
    () =>
      completeGenes
        .filter((gene) => gene.role === "reference")
        .map((gene) => gene.name),
    [completeGenes],
  );

  const settingsStale = plannerSessionIsStale(plannerSession);
  const reactionWells =
    sampleNames.length * completeGenes.length * replicates;
  const effectiveBlocks =
    dimensions.rows * Math.floor(dimensions.columns / Math.max(1, replicates));
  const sampleFullRunWells = completeGenes.length * replicates;

  const inputIssues = useMemo(() => {
    const issues: string[] = [];
    if (sampleNames.length === 0)
      issues.push(tr("请至少添加 1 个样本", "Add at least one sample"));
    else if (samples.some((sample) => !sample.name.trim()))
      issues.push(
        tr(
          "请填写所有样本行的名称，或删除空行",
          "Name every sample row or remove empty rows",
        ),
      );
    else if (
      new Set(sampleNames.map((sample) => normalizedKey(sample))).size !==
      sampleNames.length
    )
      issues.push(
        tr(
          "样本名称不能重复，请修改重复名称",
          "Sample names must be unique; rename duplicates",
        ),
      );
    const invalidGroupedSample = samples.find(
      (sample) => sample.comparisonGroup?.trim() && !sample.cellLine?.trim(),
    );
    if (invalidGroupedSample)
      issues.push(
        tr(
          `样本 ${invalidGroupedSample.name || "当前行"} 设置比较组时必须填写细胞系`,
          `Sample ${invalidGroupedSample.name || "in the current row"} needs a cell line before it can join a comparison group`,
        ),
      );
    const invalidBlank = samples.find(
      (sample) =>
        sample.kind === "blank" &&
        (sample.cellLine?.trim() ||
          sample.comparisonGroup?.trim() ||
          sample.isBridge),
    );
    if (invalidBlank)
      issues.push(
        tr(
          `Blank ${invalidBlank.name || "当前行"} 不能设置细胞系、比较组或桥接状态`,
          `Blank ${invalidBlank.name || "in the current row"} cannot have cell-line, comparison-group, or bridge metadata`,
        ),
      );
    if (genes.some((gene) => !gene.name.trim()))
      issues.push(
        tr(
          "请填写所有基因行的名称，或删除空行",
          "Name every assay row or remove empty rows",
        ),
      );
    else if (
      new Set(completeGenes.map((gene) => normalizedKey(gene.name))).size !==
      completeGenes.length
    )
      issues.push(
        tr(
          "基因名称不能重复，请修改重复名称",
          "Assay names must be unique; rename duplicates",
        ),
      );
    if (targetGenes.length === 0)
      issues.push(tr("请至少添加 1 个目的基因", "Add at least one target assay"));
    if (referenceGenes.length === 0)
      issues.push(
        tr(
          "请至少将 1 个基因标记为内参",
          "Mark at least one assay as a reference",
        ),
      );
    if (!Number.isInteger(replicates) || replicates < 1)
      issues.push(
        tr(
          "复孔数必须是正整数",
          "Replicate count must be a positive integer",
        ),
      );
    if (replicates > dimensions.columns)
      issues.push(
        tr(
          `复孔数不能超过单行 ${dimensions.columns} 孔`,
          `Replicates cannot exceed ${dimensions.columns} columns`,
        ),
      );
    if (referenceGenes.length + 1 > effectiveBlocks)
      issues.push(
        tr(
          "全部内参加至少 1 个目的基因的同板配对无法放入当前孔板",
          "One target plus all references cannot fit on this plate",
        ),
      );
    if (
      plateType === 384 &&
      loadingPattern === "interleaved-8-channel" &&
      fillDirection === "vertical" &&
      layoutPreset === "gene-major" &&
      referenceGenes.length + 1 >
        Math.floor(dimensions.columns / Math.max(1, replicates))
    )
      issues.push(
        tr(
          "当前复孔数下，一个 16 行隔行上样列块组无法同时容纳全部内参和至少 1 个目的基因；请减少复孔或内参数量，或切换连续孔位上样",
          "At this replicate count, one 16-row interleaved band cannot hold all references plus one target; reduce replicates or references, or use sequential loading",
        ),
      );
    return issues;
  }, [
    dimensions.columns,
    completeGenes,
    effectiveBlocks,
    fillDirection,
    genes,
    layoutPreset,
    loadingPattern,
    plateType,
    referenceGenes.length,
    replicates,
    samples,
    sampleNames,
    targetGenes.length,
    tr,
  ]);

  const comparisonAdvisories = useMemo(() => {
    const counts = new Map<string, number>();
    const labels = new Map<string, string>();
    const sampleIds = new Map<string, string[]>();
    for (const sample of samples) {
      const cellLine = sample.cellLine?.trim();
      if (
        sample.kind === "blank" ||
        !cellLine ||
        sample.comparisonGroup?.trim()
      ) {
        continue;
      }
      const key = normalizedKey(cellLine);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      labels.set(key, cellLine);
      sampleIds.set(key, [...(sampleIds.get(key) ?? []), sample.id]);
    }
    return Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([key, count]) => ({
        key,
        cellLine: labels.get(key) ?? "",
        sampleIds: sampleIds.get(key) ?? [],
        message: tr(
          `${labels.get(key)} 有 ${count} 个未设置比较组的样本；如需直接比较，请建立比较组。`,
          `${labels.get(key)} has ${count} ungrouped samples; create a comparison group if they will be compared directly.`,
        ),
      }));
  }, [samples, tr]);

  const audit = useMemo(
    () => plannerSessionAudit(plannerSession),
    [plannerSession],
  );
  const reactionCalculation = useMemo(
    () => plannerSessionReactionCalculation(plannerSession),
    [plannerSession],
  );

  const activePlate = layout?.plates[activePlateIndex] ?? null;
  const previewLoadingPattern = layout?.loadingPattern ?? loadingPattern;
  const previewFillDirection = layout?.fillDirection ?? fillDirection;
  const previewIs384 = layout
    ? layout.plates[0]?.rows === 16
    : plateType === 384;
  const activePlateConfirmed = activePlate
    ? Boolean(confirmed[String(activePlate.plateNumber)])
    : false;
  const allConfirmed = Boolean(
    layout &&
      reactionCalculation.valid &&
      !settingsStale &&
      layout.plates.every((plate) => confirmed[String(plate.plateNumber)]),
  );

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        const restored = loadPlannerDraft(window.localStorage);
        if (restored) {
          replacePlannerSession(restored.session);
          if (restored.ok) {
            setSavedAt("restored");
          } else {
            setToast({
              tone: "error",
              message:
                "未能恢复上次保存的方案，但不会影响新建布局。 / The saved plan could not be restored; a new plan can still be created.",
            });
          }
        }
      } catch {
        setToast({
          tone: "error",
          message:
            "未能恢复上次保存的方案，但不会影响新建布局。 / The saved plan could not be restored; a new plan can still be created.",
        });
      } finally {
        setHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3_200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  function markChanged() {
    setDirty(true);
    setSavedAt("");
  }

  function runPlateEdit(command: PlateEditCommand) {
    if (!editingSession) return null;
    const result = applyPlannerCommand({
      type: "edit-plate",
      command,
    });
    if (
      result.outcome.status === "applied" ||
      result.outcome.status === "undone" ||
      result.outcome.status === "redone"
    ) {
      markChanged();
    }
    return result;
  }

  function runPlateEdits(commands: PlateEditCommand[]) {
    if (!editingSession || commands.length === 0) return null;
    const result = applyPlannerCommand({
      type: "edit-plate-many",
      commands,
    });
    if (["applied", "undone", "redone"].includes(result.outcome.status)) {
      markChanged();
    }
    return result;
  }

  function commitEntrySnapshot(
    next: EntrySnapshot<SampleEntry, GeneEntry>,
    previous?: EntrySnapshot<SampleEntry, GeneEntry>,
  ) {
    applyPlannerCommand({
      type: "commit-entries",
      samples: next.samples,
      genes: next.genes,
      previous,
    });
    markChanged();
  }

  function beginEntryTextEdit() {
    entryEditStartRef.current = {
      samples: samples.map((sample) => ({ ...sample })),
      genes: genes.map((gene) => ({ ...gene })),
    };
  }

  function finishEntryTextEdit() {
    const previous = entryEditStartRef.current;
    entryEditStartRef.current = null;
    if (!previous) return;
    const next = { samples, genes };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    commitEntrySnapshot(next, previous);
  }

  function transitionEntries(
    command: "undo-entries" | "redo-entries",
    message: string,
  ) {
    const result = applyPlannerCommand({ type: command });
    if (result.outcome.status === "noop") return false;
    markChanged();
    setToast({
      tone: "neutral",
      message,
    });
    return true;
  }

  function undoEntries() {
    return transitionEntries(
      "undo-entries",
      tr("已撤销上一次参数编辑。", "Undid the last setup edit."),
    );
  }

  function redoEntries() {
    return transitionEntries(
      "redo-entries",
      tr("已重做参数编辑。", "Redid the setup edit."),
    );
  }

  function reorderEntry(kind: EntryKind, activeId: string, targetId: string) {
    if (activeId === targetId) return;
    if (kind === "sample") {
      const nextSamples = moveEntryById(samples, activeId, targetId);
      if (nextSamples.every((entry, index) => entry.id === samples[index]?.id)) {
        return;
      }
      commitEntrySnapshot({ samples: nextSamples, genes });
    } else {
      const nextGenes = moveEntryById(genes, activeId, targetId);
      if (nextGenes.every((entry, index) => entry.id === genes[index]?.id)) {
        return;
      }
      commitEntrySnapshot({ samples, genes: nextGenes });
    }
    setToast({
      tone: "success",
      message: tr("顺序已更新，重新生成后应用到板布局。", "Order updated; regenerate to apply it to the layout."),
    });
  }

  function moveEntryWithKeyboard(
    kind: EntryKind,
    activeId: string,
    offset: number,
  ) {
    const entries = kind === "sample" ? samples : genes;
    const nextEntries = moveEntryByOffset(entries, activeId, offset);
    const nextIndex = nextEntries.findIndex((entry) => entry.id === activeId);
    const currentIndex = entries.findIndex((entry) => entry.id === activeId);
    if (nextIndex === currentIndex || nextIndex < 0) return;
    const displacedEntry = entries[nextIndex];
    if (displacedEntry) reorderEntry(kind, activeId, displacedEntry.id);
  }

  function handleEntryDragStart(
    entry: DraggedEntry,
    event: ReactDragEvent<HTMLElement>,
  ) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", entry.id);
    setDraggedEntry(entry);
  }

  function handleEntryDragOver(
    target: DraggedEntry,
    event: ReactDragEvent<HTMLDivElement>,
  ) {
    if (draggedEntry?.kind !== target.kind) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(target);
  }

  function handleEntryDrop(
    target: DraggedEntry,
    event: ReactDragEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    if (draggedEntry?.kind === target.kind) {
      reorderEntry(target.kind, draggedEntry.id, target.id);
    }
    handleEntryDragEnd();
  }

  function handleEntryDragEnd() {
    setDraggedEntry(null);
    setDropTarget(null);
  }

  function chooseLoadingPattern(nextPattern: LoadingPattern) {
    if (nextPattern === loadingPattern) return;
    setLoadingPattern(nextPattern);
    if (
      nextPattern === "interleaved-8-channel" &&
      layoutPreset !== "gene-major"
    ) {
      setLayoutPreset("gene-major");
      setToast({
        tone: "neutral",
        message: tr(
          "已推荐切换为按基因排列；仍可手动改回按样本排列。",
          "Switched to the recommended assay-major layout; you can still choose sample-major.",
        ),
      });
    }
    markChanged();
  }

  function chooseFillDirection(nextDirection: LayoutFillDirection) {
    if (nextDirection === fillDirection) return;
    setFillDirection(nextDirection);
    markChanged();
  }

  function addSamples(
    values: string[],
    kind: SampleKind = "sample",
  ) {
    const existing = new Set(
      samples.map((sample) => normalizedKey(sample.name)),
    );
    const additions: SampleEntry[] = [];
    const duplicates: string[] = [];
    for (const rawValue of values) {
      const value = rawValue.trim();
      if (!value) continue;
      const key = normalizedKey(value);
      if (existing.has(key)) {
        duplicates.push(value);
        continue;
      }
      existing.add(key);
      additions.push({
        id: makeId("sample"),
        name: value,
        kind,
      });
    }
    if (additions.length > 0) {
      commitEntrySnapshot({
        samples: [...samples, ...additions],
        genes,
      });
    }
    if (duplicates.length > 0) {
      setToast({
        tone: "error",
        message: tr(
          `已跳过 ${duplicates.length} 个重复样本：${duplicates
            .slice(0, 3)
            .join("、")}${duplicates.length > 3 ? "…" : ""}`,
          `Skipped ${duplicates.length} duplicate sample(s): ${duplicates
            .slice(0, 3)
            .join(", ")}${duplicates.length > 3 ? "…" : ""}`,
        ),
      });
    } else if (additions.length > 0) {
      setToast({
        tone: "success",
        message: tr(
          `已添加 ${additions.length} 个样本。`,
          `Added ${additions.length} sample(s).`,
        ),
      });
    }
    return additions.length;
  }

  function addSampleRows(
    rows: Array<{
      name: string;
      cellLine?: string;
      comparisonGroup?: string;
    }>,
  ) {
    const existing = new Set(
      samples.map((sample) => normalizedKey(sample.name)),
    );
    const additions: SampleEntry[] = [];
    const duplicates: string[] = [];
    for (const row of rows) {
      const name = row.name.trim();
      if (!name) continue;
      const key = normalizedKey(name);
      if (existing.has(key)) {
        duplicates.push(name);
        continue;
      }
      existing.add(key);
      additions.push({
        id: makeId("sample"),
        name,
        kind: "sample",
        cellLine: row.cellLine?.trim() ?? "",
        comparisonGroup: row.comparisonGroup?.trim() ?? "",
        isBridge: false,
      });
    }
    if (additions.length > 0) {
      commitEntrySnapshot({ samples: [...samples, ...additions], genes });
    }
    setToast({
      tone: duplicates.length > 0 ? "error" : "success",
      message:
        duplicates.length > 0
          ? tr(
              `已导入 ${additions.length} 个样本，并跳过 ${duplicates.length} 个重复名称。`,
              `Imported ${additions.length} sample(s) and skipped ${duplicates.length} duplicate name(s).`,
            )
          : tr(
              `已导入 ${additions.length} 个样本。`,
              `Imported ${additions.length} sample(s).`,
            ),
    });
    return additions.length;
  }

  function applyBulkSampleMetadata() {
    const selected = new Set(selectedSampleIds);
    const cellLine = bulkCellLine.trim();
    const comparisonGroup = bulkComparisonGroup.trim();
    if (selected.size === 0) return;
    if (comparisonGroup && !cellLine) {
      setToast({
        tone: "error",
        message: tr(
          "批量设置比较组时必须同时填写细胞系。",
          "Bulk comparison-group assignment also requires a cell line.",
        ),
      });
      return;
    }
    commitEntrySnapshot({
      samples: samples.map((sample) =>
        selected.has(sample.id) && sample.kind !== "blank"
          ? {
              ...sample,
              cellLine,
              comparisonGroup,
              isBridge: comparisonGroup ? sample.isBridge : false,
            }
          : sample,
      ),
      genes,
    });
    setSelectedSampleIds([]);
    setBulkCellLine("");
    setBulkComparisonGroup("");
    setToast({
      tone: "success",
      message: tr(
        `已更新 ${selected.size} 个样本的实验分组。`,
        `Updated design metadata for ${selected.size} sample(s).`,
      ),
    });
  }

  function addGenes(
    values: string[],
    role: GeneRole = "target",
  ) {
    const existing = new Set(genes.map((gene) => normalizedKey(gene.name)));
    const additions: GeneEntry[] = [];
    const duplicates: string[] = [];
    for (const rawValue of values) {
      const value = rawValue.trim();
      if (!value) continue;
      const key = normalizedKey(value);
      if (existing.has(key)) {
        duplicates.push(value);
        continue;
      }
      existing.add(key);
      additions.push({ id: makeId("gene"), name: value, role });
    }
    if (additions.length > 0) {
      commitEntrySnapshot({
        samples,
        genes: [...genes, ...additions],
      });
    }
    if (duplicates.length > 0) {
      setToast({
        tone: "error",
        message: tr(
          `已跳过 ${duplicates.length} 个重复基因：${duplicates
            .slice(0, 3)
            .join("、")}${duplicates.length > 3 ? "…" : ""}`,
          `Skipped ${duplicates.length} duplicate assay(s): ${duplicates
            .slice(0, 3)
            .join(", ")}${duplicates.length > 3 ? "…" : ""}`,
        ),
      });
    } else if (additions.length > 0) {
      setToast({
        tone: "success",
        message: tr(
          `已添加 ${additions.length} 个基因；新导入项默认为目的基因。`,
          `Added ${additions.length} assay(s); imported assays default to target.`,
        ),
      });
    }
    return additions.length;
  }

  function submitSample(event: FormEvent) {
    event.preventDefault();
    if (!sampleInput.trim()) return;
    if (addSamples([sampleInput], sampleInputKind) > 0) {
      setSampleInput("");
      setSampleInputKind("sample");
      setSampleDraftOpen(false);
    }
  }

  function submitGene(event: FormEvent) {
    event.preventDefault();
    if (!geneInput.trim()) return;
    if (addGenes([geneInput], geneInputRole) > 0) {
      setGeneInput("");
      setGeneInputRole("target");
      setGeneDraftOpen(false);
    }
  }

  function submitQuickSamples(event: FormEvent) {
    event.preventDefault();
    if (parsedSampleQuickCount === null) return;
    addSamples(generateNumberedEntries("S", parsedSampleQuickCount));
    setSampleQuickCount("");
  }

  function submitQuickGenes(event: FormEvent) {
    event.preventDefault();
    if (parsedGeneQuickCount === null) return;
    addGenes(generateNumberedEntries("T", parsedGeneQuickCount));
    setGeneQuickCount("");
  }

  function loadExample() {
    const exampleSamples: SampleEntry[] = Array.from(
      { length: 8 },
      (_, index) => ({
        id: makeId("sample"),
        name: `Sample_${String(index + 1).padStart(2, "0")}`,
        kind: "sample" as const,
      }),
    );
    const exampleGenes: GeneEntry[] = [
      { id: makeId("gene"), name: "GAPDH", role: "reference" },
      { id: makeId("gene"), name: "FBN2", role: "target" },
      { id: makeId("gene"), name: "ZNF436", role: "target" },
      { id: makeId("gene"), name: "CHMP2A", role: "target" },
    ];
    replacePlannerSession(
      createPlannerSession({
        plateType: 96,
        samples: exampleSamples,
        genes: exampleGenes,
        replicates: 3,
        layoutPreset: "gene-major",
        loadingPattern: "sequential",
        fillDirection: "vertical",
        reactionSystem: plannerSessionRef.current.reactionSystem,
        language: plannerSessionRef.current.language,
      }),
    );
    setSampleInput("");
    setSampleInputKind("sample");
    setSampleDraftOpen(false);
    setGeneInput("");
    setGeneInputRole("target");
    setGeneDraftOpen(false);
    setActivePlateIndex(0);
    markChanged();
    setToast({
      tone: "neutral",
      message: tr(
        "已载入 8 个样本、3 个目的基因和 1 个内参的示例。",
        "Loaded an example with 8 samples, 3 targets, and 1 reference.",
      ),
    });
  }

  function generateLayout() {
    if (inputIssues.length > 0) {
      setToast({ tone: "error", message: inputIssues[0] });
      return;
    }
    if (
      layout?.plates.some((plate) =>
        plate.wells.some((well) => well.source === "manual"),
      ) &&
      !window.confirm(
        tr(
          "重新生成将覆盖当前的手动修改，是否继续？",
          "Regenerating will overwrite manual edits. Continue?",
        ),
      )
    ) {
      return;
    }
    try {
      const result = applyPlannerCommand({
        type: "generate-layout",
        generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      });
      if (result.outcome.status === "rejected") {
        throw new Error(result.outcome.message ?? "Unable to generate layout");
      }
      const plateCount = result.session.plateEditing?.plan.plates.length ?? 0;
      setActivePlateIndex(0);
      markChanged();
      setToast({
        tone: "success",
        message:
          layoutPreset === "gene-major"
            ? tr(
                `已按基因排列生成 ${plateCount} 块 ${plateType} 孔板；每个基因内保持样本输入顺序。`,
                `Generated ${plateCount} ${plateType}-well plate(s) by assay; sample input order is preserved within every assay.`,
              )
            : tr(
                `已按样本排列生成 ${plateCount} 块 ${plateType} 孔板；目的基因跨板时会重新安排该样本的全部内参。`,
                `Generated ${plateCount} ${plateType}-well plate(s) by sample; all references are rerun whenever a sample's targets continue onto another plate.`,
              ),
      });
    } catch (error) {
      setToast({
        tone: "error",
        message:
          error instanceof Error
            ? localizeMessage(error.message)
            : tr("无法生成布局。", "Unable to generate a layout."),
      });
    }
  }

  function undoLayout() {
    runPlateEdit({ type: "undo" });
  }

  function redoLayout() {
    runPlateEdit({ type: "redo" });
  }

  function savePlanner() {
    try {
      savePlannerDraft(window.localStorage, plannerSession);
      const time = new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      setSavedAt(time);
      setDirty(false);
      setToast({
        tone: "success",
        message: tr(
          "方案已保存在本机浏览器。",
          "Plan saved in this browser.",
        ),
      });
    } catch {
      setToast({
        tone: "error",
        message: tr(
          "保存失败。请检查浏览器是否允许本地存储。",
          "Save failed; check whether browser storage is allowed.",
        ),
      });
    }
  }

  function resetPlanner() {
    if (
      !window.confirm(
        tr(
          "这会清除当前页面内容和本机浏览器中保存的样本、基因、板布局及反应体系，且无法撤销。是否继续？",
          "This will permanently clear the current page and the samples, assays, plate layouts, and reaction setup saved in this browser. Continue?",
        ),
      )
    ) {
      return;
    }

    try {
      clearPlannerDraft(window.localStorage);
    } catch {
      setToast({
        tone: "error",
        message: tr(
          "无法清除本机保存记录；当前内容未重置。请检查浏览器是否允许本地存储。",
          "The browser-saved plan could not be cleared, so the current page was not reset. Check whether browser storage is allowed.",
        ),
      });
      return;
    }

    applyPlannerCommand({ type: "reset" });
    setDraggedEntry(null);
    setDropTarget(null);
    setSampleInput("");
    setSampleInputKind("sample");
    setSampleDraftOpen(false);
    setGeneInput("");
    setGeneInputRole("target");
    setGeneDraftOpen(false);
    setSamplePaste("");
    setGenePaste("");
    setSampleQuickCount("");
    setGeneQuickCount("");
    setActivePlateIndex(0);
    setEditor(null);
    setEditingPlateName(false);
    setPlateNameDraft("");
    setSavedAt("");
    setDirty(false);
    setToast({
      tone: "success",
      message: tr(
        "本机保存记录已清除，工具已恢复初始状态。",
        "The browser-saved plan was cleared and the tool was reset.",
      ),
    });
  }

  function openEditorForSelection(
    plateIndex: number,
    plate: PlannerPlate,
    wellIds = selectedWellIds,
  ) {
    if (confirmed[String(plate.plateNumber)] || settingsStale) return;
    const selected = plate.wells.filter((well) =>
      wellIds.includes(well.wellId),
    );
    if (selected.length === 0) return;
    const occupied = selected.find((well) => well.sample && well.gene);
    setEditor({
      plateIndex,
      wellIds,
      mode: occupied ? "assay" : "empty",
      sample: occupied?.sample ?? sampleNames[0] ?? "",
      gene: occupied?.gene ?? completeGenes[0]?.name ?? "",
    });
  }

  function handleWellSelection(
    event: React.MouseEvent<HTMLButtonElement>,
    plateIndex: number,
    plate: PlannerPlate,
    well: PlannerWell,
  ) {
    if (suppressWellClickRef.current) return;
    if (confirmed[String(plate.plateNumber)] || settingsStale) return;
    if (moveMode) {
      moveSelectionTo(plateIndex, plate, well.wellId);
      return;
    }
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey && selectionAnchorId) {
      runPlateEdit({
        type: "select-range",
        plateNumber: plate.plateNumber,
        anchorWellId: selectionAnchorId,
        endWellId: well.wellId,
        mode: additive ? "add" : "replace",
      });
      return;
    }
    runPlateEdit({
      type: "select",
      plateNumber: plate.plateNumber,
      wellIds: [well.wellId],
      mode: additive ? "toggle" : "replace",
      anchorWellId: well.wellId,
    });
  }

  function boxPointerPosition(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const unscaledWidth = bounds.width / plateZoom;
    const unscaledHeight = bounds.height / plateZoom;
    return {
      x: Math.max(
        0,
        Math.min(unscaledWidth, (event.clientX - bounds.left) / plateZoom),
      ),
      y: Math.max(
        0,
        Math.min(unscaledHeight, (event.clientY - bounds.top) / plateZoom),
      ),
    };
  }

  function wellIdAtPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    return element
      ?.closest<HTMLButtonElement>("button[data-well-id]")
      ?.dataset.wellId;
  }

  function beginBoxSelection(
    event: ReactPointerEvent<HTMLDivElement>,
    plate: PlannerPlate,
  ) {
    if (
      event.button !== 0 ||
      moveMode ||
      confirmed[String(plate.plateNumber)] ||
      settingsStale
    ) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchorWellId = target
      .closest<HTMLButtonElement>("button[data-well-id]")
      ?.dataset.wellId;
    if (!anchorWellId) return;

    const position = boxPointerPosition(event);
    const next: BoxSelectionState = {
      pointerId: event.pointerId,
      anchorWellId,
      endWellId: anchorWellId,
      baseWellIds: [...selectedWellIds],
      mode: event.metaKey || event.ctrlKey ? "add" : "replace",
      startX: position.x,
      startY: position.y,
      currentX: position.x,
      currentY: position.y,
      active: false,
    };
    boxSelectionRef.current = next;
    setBoxSelection(next);
  }

  function updateBoxSelection(
    event: ReactPointerEvent<HTMLDivElement>,
    plate: PlannerPlate,
  ) {
    const current = boxSelectionRef.current;
    if (!current || current.pointerId !== event.pointerId) return;

    const position = boxPointerPosition(event);
    const distance = Math.hypot(
      position.x - current.startX,
      position.y - current.startY,
    );
    const active = current.active || distance >= 6;
    if (active && !current.active) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const endWellId = wellIdAtPointer(event) ?? current.endWellId;
    const next = {
      ...current,
      endWellId,
      currentX: position.x,
      currentY: position.y,
      active,
    };
    boxSelectionRef.current = next;
    setBoxSelection(next);
    if (!active) return;

    event.preventDefault();
    runPlateEdit({
      type: "select-range",
      plateNumber: plate.plateNumber,
      anchorWellId: next.anchorWellId,
      endWellId: next.endWellId,
      mode: next.mode,
      baseWellIds: next.baseWellIds,
    });
  }

  function finishBoxSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const current = boxSelectionRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (current.active) {
      suppressWellClickRef.current = true;
      window.setTimeout(() => {
        suppressWellClickRef.current = false;
      }, 0);
    }
    boxSelectionRef.current = null;
    setBoxSelection(null);
  }

  function cancelBoxSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const current = boxSelectionRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    boxSelectionRef.current = null;
    setBoxSelection(null);
  }

  function applyManualEdit() {
    if (!layout || !editor) return;
    if (editor.mode === "assay" && (!editor.sample || !editor.gene)) {
      setToast({
        tone: "error",
        message: tr("请选择样本和基因。", "Select a sample and an assay."),
      });
      return;
    }
    const plate = layout.plates[editor.plateIndex];
    const selectedGene = completeGenes.find(
      (gene) => gene.name === editor.gene,
    );
    runPlateEdits([
      {
        type: "select",
        plateNumber: plate.plateNumber,
        wellIds: editor.wellIds,
        mode: "replace",
      },
      editor.mode === "assay"
        ? {
            type: "assign",
            sample: editor.sample,
            gene: editor.gene,
            geneType: (selectedGene?.role ?? "target") as GeneType,
          }
        : { type: "clear" },
    ]);
    setEditor(null);
    setToast({
      tone: "neutral",
      message: tr(
        `已更新 ${editor.wellIds.length} 个所选孔；布局校验仅作为提醒。`,
        `Updated ${editor.wellIds.length} selected well(s); layout validation is advisory.`,
      ),
    });
  }

  function clearSelectedWells() {
    if (!layout || !activePlate || selectedWellIds.length === 0) return;
    runPlateEdit({ type: "clear" });
    setToast({
      tone: "neutral",
      message: tr(
        `已清空 ${selectedWellIds.length} 个所选孔。`,
        `Cleared ${selectedWellIds.length} selected well(s).`,
      ),
    });
  }

  function copySelection() {
    if (!activePlate || selectedWellIds.length === 0) return false;
    const copied = runPlateEdit({ type: "copy" });
    if (!copied || copied.outcome.status !== "copied") return false;
    setToast({
      tone: "neutral",
      message: tr(
        `已复制 ${selectedWellIds.length} 个孔；选择目标起始孔后粘贴。`,
        `Copied ${selectedWellIds.length} well(s); select a destination anchor to paste.`,
      ),
    });
    return true;
  }

  function pasteSelection() {
    if (
      !layout ||
      !activePlate ||
      !wellClipboard ||
      activePlateConfirmed ||
      settingsStale
    ) {
      return false;
    }
    const destinationWellId = selectionAnchorId ?? selectedWellIds[0];
    if (!destinationWellId) {
      setToast({
        tone: "error",
        message: tr(
          "请先选择粘贴区域的起始孔。",
          "Select the destination anchor well first.",
        ),
      });
      return false;
    }
    let pasted = runPlateEdit({
      type: "paste",
      plateNumber: activePlate.plateNumber,
      destinationWellId,
    });
    if (pasted?.outcome.status === "conflict") {
      const overwrite = window.confirm(
        tr(
          `目标区域已有 ${pasted.outcome.wellIds?.length ?? 0} 个占用孔。是否覆盖？`,
          `The destination contains ${pasted.outcome.wellIds?.length ?? 0} occupied well(s). Overwrite them?`,
        ),
      );
      if (!overwrite) return false;
      pasted = runPlateEdit({
        type: "paste",
        plateNumber: activePlate.plateNumber,
        destinationWellId,
        allowOverwrite: true,
      });
    }
    if (!pasted || pasted.outcome.status !== "applied") {
      setToast({
        tone: "error",
        message: tr(
          "复制区域粘贴后会超出孔板边界。",
          "The copied block would exceed the plate boundary.",
        ),
      });
      return false;
    }
    const pastedCount = pasted.outcome.wellIds?.length ?? 0;
    setToast({
      tone: "neutral",
      message: tr(
        `已粘贴 ${pastedCount} 个孔；用量已按当前布局重算。`,
        `Pasted ${pastedCount} well(s); requirements were recalculated.`,
      ),
    });
    return true;
  }

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement instanceof HTMLSelectElement
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "c" && selectedWellIds.length > 0) {
        event.preventDefault();
        copySelection();
        return;
      }
      if (key === "v" && wellClipboard) {
        event.preventDefault();
        pasteSelection();
        return;
      }
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          if (!redoEntries() && redoStack.length > 0) redoLayout();
        } else if (!undoEntries() && undoStack.length > 0) {
          undoLayout();
        }
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  });

  function restoreSelectedFromAutomatic() {
    if (
      !layout ||
      !activePlate ||
      selectedWellIds.length === 0
    ) {
      return;
    }
    runPlateEdit({ type: "restore-selected" });
    setToast({
      tone: "success",
      message: tr(
        `已恢复 ${selectedWellIds.length} 个所选孔的生成值。`,
        `Restored generated values for ${selectedWellIds.length} selected well(s).`,
      ),
    });
  }

  function moveSelectionTo(
    plateIndex: number,
    plate: PlannerPlate,
    destinationWellId: string,
  ) {
    if (!layout || selectedWellIds.length === 0) return;
    let result = runPlateEdit({
      type: "move",
      plateNumber: plate.plateNumber,
      destinationWellId,
    });
    if (result?.outcome.status === "conflict") {
      const confirmedOverwrite = window.confirm(
        tr(
          `目标区域已有 ${result.outcome.wellIds?.length ?? 0} 个占用孔。是否覆盖？`,
          `The destination contains ${result.outcome.wellIds?.length ?? 0} occupied well(s). Overwrite them?`,
        ),
      );
      if (!confirmedOverwrite) {
        runPlateEdit({ type: "set-move-mode", enabled: false });
        return;
      }
      result = runPlateEdit({
        type: "move",
        plateNumber: plate.plateNumber,
        destinationWellId,
        allowOverwrite: true,
      });
    }
    if (!result || result.outcome.status !== "applied") {
      setToast({
        tone: "error",
        message:
          result?.outcome.reason === "out-of-bounds"
            ? tr(
                "所选孔平移后会超出孔板边界。",
                "The translated selection would exceed the plate boundary.",
              )
            : tr(
                "所选区域没有可移动的检测孔。",
                "The selection has no occupied wells to move.",
              ),
      });
      runPlateEdit({ type: "set-move-mode", enabled: false });
      return;
    }
    setToast({
      tone: "neutral",
      message: tr(
        `已平移 ${result.outcome.wellIds?.length ?? 0} 个孔位。`,
        `Moved ${result.outcome.wellIds?.length ?? 0} well(s).`,
      ),
    });
  }

  function restoreActivePlate() {
    if (!layout || !activePlate) return;
    runPlateEdit({
      type: "restore-plate",
      plateNumber: activePlate.plateNumber,
    });
    setToast({
      tone: "success",
      message: tr(
        `${activePlate.name} 已恢复为自动布局。`,
        `${activePlate.name} was restored to the automatic layout.`,
      ),
    });
  }

  function commitPlateName() {
    if (!layout || !activePlate) return;
    const nextName = plateNameDraft.trim();
    if (!nextName) {
      setToast({
        tone: "error",
        message: tr("板名不能为空。", "Plate name cannot be empty."),
      });
      return;
    }
    const duplicate = layout.plates.some(
      (plate) =>
        plate.id !== activePlate.id &&
        normalizedKey(plate.name) === normalizedKey(nextName),
    );
    if (duplicate) {
      setToast({
        tone: "error",
        message: tr(
          `板名“${nextName}”已存在；同一次生成的板名不能重复。`,
          `Plate name “${nextName}” already exists; names must be unique within a plan.`,
        ),
      });
      return;
    }
    if (nextName !== activePlate.name) {
      runPlateEdit({
        type: "rename-plate",
        plateNumber: activePlate.plateNumber,
        name: nextName,
      });
      setToast({
        tone: "success",
        message: tr(
          `板名已改为“${nextName}”。`,
          `Plate renamed to “${nextName}”.`,
        ),
      });
    }
    setEditingPlateName(false);
  }

  function togglePlateConfirmation() {
    if (!activePlate) return;
    const key = String(activePlate.plateNumber);
    if (confirmed[key]) {
      runPlateEdit({
        type: "set-confirmed",
        plateNumber: activePlate.plateNumber,
        confirmed: false,
      });
      markChanged();
      return;
    }
    if (settingsStale) {
      setToast({
        tone: "error",
        message: tr(
          "实验设置已变更，请重新生成布局。",
          "Experiment settings changed; regenerate the layout.",
        ),
      });
      return;
    }
    runPlateEdit({
      type: "set-confirmed",
      plateNumber: activePlate.plateNumber,
      confirmed: true,
    });
    markChanged();
    const advisoryCount =
      issuesForPlate(activePlate).length + globalIssues.length;
    setToast({
      tone: advisoryCount > 0 ? "neutral" : "success",
      message:
        advisoryCount > 0
          ? tr(
              `${activePlate.name} 已确认；仍有 ${advisoryCount} 项布局提醒，但不限制导出。`,
              `${activePlate.name} confirmed with ${advisoryCount} layout advisory item(s); export remains available.`,
            )
          : tr(
              `${activePlate.name} 已确认并锁定。`,
              `${activePlate.name} confirmed and locked.`,
            ),
    });
  }

  function exportablePlate(plate: PlannerPlate): ExportablePlate {
    return {
      name: plate.name,
      plateNumber: plate.plateNumber,
      rows: plate.rows,
      columns: plate.columns,
      wells: plate.wells,
      confirmed: Boolean(confirmed[String(plate.plateNumber)]),
    };
  }

  function exportContext(validationStatus?: "Valid" | "Warning" | "Invalid"): ExportContext {
    return {
      plateType,
      replicates,
      samples: sampleNames,
      sampleDesigns: samples
        .filter((sample) => sample.name.trim())
        .map((sample) => ({
          name: sample.name.trim(),
          kind: sample.kind,
          cellLine: sample.cellLine?.trim() || undefined,
          comparisonGroup: sample.comparisonGroup?.trim() || undefined,
          isBridge: Boolean(sample.isBridge),
        })),
      blankSamples: blankSampleNames,
      targetGenes,
      referenceGenes,
      strategyLabel: layout ? strategyLabel(layout.strategy) : "",
      layoutStrategy: layout?.strategy,
      loadingPattern: layout?.loadingPattern ?? loadingPattern,
      fillDirection: layout?.fillDirection ?? fillDirection,
      generatedAt,
      validationStatus:
        validationStatus ??
        (settingsStale ? "Invalid" : audit.valid ? "Valid" : "Warning"),
      splitSamples: layout?.metrics.splitSamples ?? 0,
      repeatedReferenceBlocks:
        layout?.metrics.repeatedReferenceBlocks ?? 0,
      repeatedReferenceWells:
        layout?.metrics.repeatedReferenceWells ?? 0,
      reactionSystem,
    };
  }

  async function downloadActivePlate() {
    if (
      !activePlate ||
      !activePlateConfirmed ||
      settingsStale ||
      !reactionCalculation.valid
    ) {
      setToast({
        tone: "error",
        message:
          reactionCalculation.errors[0] ??
          tr(
            "请先确认本板，并确保反应体系体积有效后再导出。",
            "Confirm this plate and ensure the reaction volumes are valid before export.",
          ),
      });
      return;
    }
    try {
      await exportPlateExcel(
        exportablePlate(activePlate),
        exportContext(audit.valid ? "Valid" : "Warning"),
      );
      setToast({
        tone: "success",
        message: tr(
          `${activePlate.name} Excel 已生成。`,
          `${activePlate.name} Excel workbook generated.`,
        ),
      });
    } catch {
      setToast({
        tone: "error",
        message: tr(
          "Excel 生成失败；当前方案仍已保留，请稍后重试。",
          "Excel generation failed; the plan remains saved.",
        ),
      });
    }
  }

  async function downloadAllPlates() {
    if (!layout || !allConfirmed) {
      setToast({
        tone: "error",
        message: tr(
          "请先确认全部孔板，再批量导出。",
          "Confirm every plate before batch export.",
        ),
      });
      return;
    }
    try {
      await exportAllPlateExcels(
        layout.plates.map(exportablePlate),
        exportContext(),
      );
      setToast({
        tone: "success",
        message: tr(
          `已打包 ${layout.plates.length} 个独立 Excel 和总览表。`,
          `Packaged ${layout.plates.length} plate workbooks plus an overview.`,
        ),
      });
    } catch {
      setToast({
        tone: "error",
        message: tr(
          "批量导出失败；当前方案仍已保留，请稍后重试。",
          "Batch export failed; the plan remains saved.",
        ),
      });
    }
  }

  function issuesForPlate(plate: PlannerPlate) {
    return audit.errors.filter(
      (issue) => issue.plateNumber === plate.plateNumber,
    );
  }

  function moveWellFocus(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    plate: PlannerPlate,
    row: number,
    column: number,
  ) {
    const movement: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const delta = movement[event.key];
    if (!delta) return;
    event.preventDefault();
    const nextRow = Math.min(Math.max(0, row + delta[0]), plate.rows - 1);
    const nextColumn = Math.min(
      Math.max(0, column + delta[1]),
      plate.columns - 1,
    );
    document
      .getElementById(
        `plate-${plate.plateNumber}-well-${nextRow}-${nextColumn}`,
      )
      ?.focus();
  }

  const globalIssues = audit.errors.filter(
    (issue) => issue.plateNumber === undefined,
  );
  const activeIssues = activePlate
    ? [...issuesForPlate(activePlate), ...globalIssues]
    : globalIssues;
  const activeInvalid = settingsStale;
  const currentStatus = plateStatus(
    activePlateConfirmed,
    activeIssues.length,
    settingsStale,
    language,
  );
  const selectedOccupiedCount = activePlate
    ? activePlate.wells.filter(
        (well) =>
          selectedWellIds.includes(well.wellId) && well.sample && well.gene,
      ).length
    : 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <FlaskConical size={20} strokeWidth={1.8} />
          </div>
          <div className="brand-copy">
            <p className="brand-title">
              {tr(
                "qPCR 板布局规划工具",
                "qPCR Plate Layout Planner",
              )}
            </p>
            <p className="brand-subtitle">
              {tr(
                "96 / 384 孔 · 排板与反应用量",
                "96 / 384 wells · Layout & reaction planning",
              )}
            </p>
          </div>
        </div>
        <div className="topbar-actions">
          <div
            className="language-switch"
            role="group"
            aria-label={tr("界面语言", "Interface language")}
          >
            <Languages size={14} aria-hidden="true" />
            <button
              type="button"
              className={language === "zh" ? "active" : ""}
              aria-pressed={language === "zh"}
              onClick={() => setLanguage("zh")}
            >
              中文
            </button>
            <button
              type="button"
              className={language === "en" ? "active" : ""}
              aria-pressed={language === "en"}
              onClick={() => setLanguage("en")}
            >
              EN
            </button>
          </div>
          <span className={`save-status ${dirty ? "unsaved" : ""}`}>
            {dirty
              ? tr("有未保存更改", "Unsaved changes")
              : savedAt === "restored"
                ? tr("已恢复", "Restored")
                : savedAt
                  ? tr(`已保存 ${savedAt}`, `Saved ${savedAt}`)
                  : hydrated
                    ? tr("本地就绪", "Ready")
                    : tr("载入中", "Loading")}
          </span>
          <button
            className="button button-clear"
            type="button"
            onClick={resetPlanner}
            disabled={!hydrated}
            title={tr(
              "清除本机保存记录并恢复初始状态",
              "Clear the browser-saved plan and restore defaults",
            )}
            aria-label={tr(
              "重置工具并清除本机保存记录",
              "Reset the tool and clear the browser-saved plan",
            )}
          >
            <RotateCcw size={15} />
            <span>{tr("重置工具", "Reset tool")}</span>
          </button>
          <button className="button" type="button" onClick={savePlanner}>
            <Save size={15} />
            <span>{tr("保存", "Save")}</span>
          </button>
          <button
            className="button button-primary"
            type="button"
            onClick={downloadAllPlates}
            disabled={!allConfirmed}
            title={
              allConfirmed
                ? tr("导出全部孔板", "Export all plates")
                : tr(
                    "确认全部孔板后可批量导出",
                    "Confirm all plates before batch export",
                  )
            }
          >
            <Download size={15} />
            <span>
              {tr("全部导出", "Export all")}
              {layout ? `（${layout.plates.length}）` : ""}
            </span>
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside
          className="sidebar"
          data-scroll-region="setup"
          aria-label={tr("实验设置", "Experiment setup")}
        >
          <div
            className="setup-history-bar"
            role="toolbar"
            aria-label={tr("参数编辑历史", "Setup edit history")}
          >
            <span>
              {tr("参数编辑", "Setup edits")}
              <small>
                {tr(
                  "⌘/Ctrl+Z 撤销 · 列表可拖动排序",
                  "⌘/Ctrl+Z undo · Lists can be dragged to reorder",
                )}
              </small>
            </span>
            <div>
              <button
                className="icon-button"
                type="button"
                onClick={undoEntries}
                disabled={!entryHistory.canUndo}
                aria-label={tr("撤销参数编辑", "Undo setup edit")}
                title={tr("撤销参数编辑", "Undo setup edit")}
              >
                <Undo2 size={14} />
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={redoEntries}
                disabled={!entryHistory.canRedo}
                aria-label={tr("重做参数编辑", "Redo setup edit")}
                title={tr("重做参数编辑", "Redo setup edit")}
              >
                <Redo2 size={14} />
              </button>
            </div>
          </div>
          <section className="panel">
            <div className="panel-heading">
              <div className="heading-with-index">
                <span className="section-index">01</span>
                <div>
                  <h2 className="panel-title">
                    {tr("选择孔板", "Plate format")}
                  </h2>
                  <p className="panel-description">
                    {tr("选择本次上机板型", "Select the plate type")}
                  </p>
                </div>
              </div>
            </div>
            <div className="plate-picker">
              {([96, 384] as const).map((type) => {
                const size = getPlateDimensions(type);
                return (
                  <button
                    key={type}
                    className={`plate-choice ${
                      plateType === type ? "selected" : ""
                    }`}
                    type="button"
                    onClick={() => {
                      if (type === plateType) return;
                      setPlateType(type);
                      const nextLoadingPattern = defaultLoadingPattern(type);
                      setLoadingPattern(nextLoadingPattern);
                      setFillDirection("vertical");
                      if (nextLoadingPattern === "interleaved-8-channel") {
                        setLayoutPreset("gene-major");
                      }
                      if (replicates > size.columns) setReplicates(size.columns);
                      markChanged();
                    }}
                    aria-pressed={plateType === type}
                  >
                    <span>
                      <span className="plate-choice-name">
                        {tr(`${type} 孔板`, `${type}-well plate`)}
                      </span>
                      <span className="plate-choice-meta">
                        {tr(
                          `${size.rows} 行 × ${size.columns} 列`,
                          `${size.rows} rows × ${size.columns} columns`,
                        )}
                      </span>
                    </span>
                    <span className="plate-mini" aria-hidden="true">
                      {Array.from({ length: 12 }).map((_, index) => (
                        <span key={index} />
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div className="heading-with-index">
                <span className="section-index">02</span>
                <div>
                  <h2 className="panel-title">
                    {tr("样本与对照", "Samples & controls")}
                  </h2>
                  <p className="panel-description">
                    {tr(
                      "逐行设置名称与类型；细胞系和比较组可选",
                      "Set name and type; cell line and comparison group are optional",
                    )}
                  </p>
                </div>
              </div>
              {samples.length > 0 && (
                <button
                  className="button button-clear"
                  type="button"
                  onClick={() => {
                    commitEntrySnapshot({ samples: [], genes });
                    setSampleInput("");
                    setSampleInputKind("sample");
                    setSampleDraftOpen(false);
                    setSampleQuickCount("");
                    setSelectedSampleIds([]);
                  }}
                >
                  {tr("清空", "Clear")}
                </button>
              )}
            </div>
            <div className="entry-stack">
              <div className="sample-import-area">
                <textarea
                  className="batch-box sample-batch-box"
                  value={samplePaste}
                  onChange={(event) => setSamplePaste(event.target.value)}
                  placeholder={tr(
                    "从 Excel 粘贴：样本名，或样本名 + 细胞系 + 比较组（3 列）…",
                    "Paste from Excel: sample name, or name + cell line + comparison group (3 columns)…",
                  )}
                  aria-label={tr("批量粘贴样本", "Paste samples in bulk")}
                />
                <button
                  className="button button-soft sample-import-button"
                  type="button"
                  disabled={samplePasteRows.length === 0}
                  onClick={() => {
                    addSampleRows(samplePasteRows);
                    setSamplePaste("");
                  }}
                >
                  <Plus size={15} />
                  {tr(
                    `导入 ${samplePasteRows.length} 个样本名称`,
                    `Import ${samplePasteRows.length} sample ${
                      samplePasteRows.length === 1 ? "name" : "names"
                    }`,
                  )}
                </button>
                <form className="quick-fill-row" onSubmit={submitQuickSamples}>
                  <input
                    className="quick-fill-input"
                    type="number"
                    min={1}
                    max={MAX_QUICK_ENTRY_COUNT}
                    step={1}
                    inputMode="numeric"
                    value={sampleQuickCount}
                    onChange={(event) => setSampleQuickCount(event.target.value)}
                    placeholder={tr("样本数量（1–999）", "Sample count (1–999)")}
                    aria-label={tr("快速输入样本数量", "Quick sample count")}
                  />
                  <button
                    className="button button-soft quick-fill-button"
                    type="submit"
                    disabled={parsedSampleQuickCount === null}
                    aria-label={tr(
                      "快速添加编号样本",
                      "Quickly add numbered samples",
                    )}
                  >
                    <Sparkles size={15} />
                    {tr("快速添加", "Quick add")}
                  </button>
                </form>
              </div>
              {samples.length > 0 && (
                <div
                  className="sample-list"
                  aria-label={tr("已添加样本", "Added samples")}
                >
                  <p className="entry-order-help">
                    <GripVertical size={12} />
                    {tr(
                      "拖动排序；第二行依次为细胞系、比较组、桥接；⌘/Ctrl+Z 撤销",
                      "Drag to reorder; row 2 is cell line, comparison group, bridge; ⌘/Ctrl+Z to undo",
                    )}
                  </p>
                  {selectedSampleIds.length > 0 && (
                    <div className="sample-bulk-metadata" role="group">
                      <strong>
                        {tr(
                          `已选 ${selectedSampleIds.length} 个样本`,
                          `${selectedSampleIds.length} sample(s) selected`,
                        )}
                      </strong>
                      <input
                        value={bulkCellLine}
                        onChange={(event) => setBulkCellLine(event.target.value)}
                        placeholder={tr("批量细胞系", "Bulk cell line")}
                        aria-label={tr("批量设置细胞系", "Set cell line in bulk")}
                      />
                      <input
                        value={bulkComparisonGroup}
                        onChange={(event) => setBulkComparisonGroup(event.target.value)}
                        placeholder={tr("批量比较组", "Bulk comparison group")}
                        aria-label={tr("批量设置比较组", "Set comparison group in bulk")}
                      />
                      <button type="button" onClick={applyBulkSampleMetadata}>
                        {tr("应用", "Apply")}
                      </button>
                    </div>
                  )}
                  {samples.map((sample, index) => (
                    <SortableEntryRow
                      key={sample.id}
                      entry={{ kind: "sample", id: sample.id }}
                      name={sample.name}
                      index={index}
                      count={samples.length}
                      draggedEntry={draggedEntry}
                      dropTarget={dropTarget}
                      dragLabel={tr(
                        `拖动调整样本 ${sample.name || "当前行"} 顺序；点击可选择上移或下移`,
                        `Drag to reorder sample ${sample.name || "this row"}; click for move up or move down controls`,
                      )}
                      dragTitle={tr(
                        "拖动排序，或点击选择上移/下移",
                        "Drag to reorder, or click for move controls",
                      )}
                      moveUpLabel={tr("上移", "Move up")}
                      moveDownLabel={tr("下移", "Move down")}
                      onDragStart={handleEntryDragStart}
                      onDragEnd={handleEntryDragEnd}
                      onDragOver={handleEntryDragOver}
                      onDrop={handleEntryDrop}
                      onMove={(entry, offset) =>
                        moveEntryWithKeyboard(entry.kind, entry.id, offset)
                      }
                    >
                      <input
                        className="sample-name-input"
                        value={sample.name}
                        onChange={(event) => {
                          const nextName = event.target.value;
                          setSamples((current) =>
                            current.map((item) =>
                              item.id === sample.id
                                ? { ...item, name: nextName }
                                : item,
                            ),
                          );
                          markChanged();
                        }}
                        onBlur={(event) => {
                          const trimmedName = event.target.value.trim();
                          if (trimmedName === event.target.value) return;
                          setSamples((current) =>
                            current.map((item) =>
                              item.id === sample.id
                                ? { ...item, name: trimmedName }
                                : item,
                            ),
                          );
                        }}
                        placeholder={tr("样本名称", "Sample name")}
                        aria-label={tr(
                          `样本名称：${sample.name || "未填写"}`,
                          `Sample name: ${sample.name || "empty"}`,
                        )}
                      />
                      <button
                        className={`entry-type-toggle ${
                          sample.kind === "blank" ? "is-blank" : ""
                        }`}
                        type="button"
                        onClick={() => {
                          if (sample.kind === "sample") {
                            setSelectedSampleIds((current) =>
                              current.filter((id) => id !== sample.id),
                            );
                          }
                          commitEntrySnapshot({
                            samples: samples.map((item) =>
                              item.id === sample.id
                                ? {
                                    ...item,
                                    kind:
                                      item.kind === "sample"
                                        ? "blank"
                                        : "sample",
                                    ...(item.kind === "sample"
                                      ? {
                                          cellLine: "",
                                          comparisonGroup: "",
                                          isBridge: false,
                                        }
                                      : {}),
                                  }
                                : item,
                            ),
                            genes,
                          });
                        }}
                        aria-pressed={sample.kind === "blank"}
                        aria-label={tr(
                          `将 ${sample.name || "当前行"}切换为${
                            sample.kind === "sample" ? "Blank" : "样本"
                          }`,
                          `Change ${sample.name || "this row"} to ${
                            sample.kind === "sample" ? "Blank" : "Sample"
                          }`,
                        )}
                      >
                        {sample.kind === "blank"
                          ? "Blank"
                          : tr("样本", "Sample")}
                      </button>
                      <button
                        className="sample-delete-button"
                        type="button"
                        onClick={() => {
                          setSelectedSampleIds((current) =>
                            current.filter((id) => id !== sample.id),
                          );
                          commitEntrySnapshot({
                            samples: samples.filter(
                              (item) => item.id !== sample.id,
                            ),
                            genes,
                          });
                        }}
                        aria-label={tr(
                          `删除样本 ${sample.name}`,
                          `Remove sample ${sample.name}`,
                        )}
                      >
                        <Trash2 size={15} />
                      </button>
                      <div className="sample-metadata-row">
                        <button
                          className={`sample-select-toggle ${
                            selectedSampleIds.includes(sample.id) ? "is-active" : ""
                          }`}
                          type="button"
                          disabled={sample.kind === "blank"}
                          onClick={() =>
                            setSelectedSampleIds((current) =>
                              current.includes(sample.id)
                                ? current.filter((id) => id !== sample.id)
                                : [...current, sample.id],
                            )
                          }
                          aria-pressed={selectedSampleIds.includes(sample.id)}
                          aria-label={tr(
                            `选择样本 ${sample.name || "当前行"}进行批量设置`,
                            `Select ${sample.name || "this sample"} for bulk assignment`,
                          )}
                          title={tr("选择后批量设置分组", "Select for bulk assignment")}
                        >
                          {selectedSampleIds.includes(sample.id) && <Check size={12} />}
                        </button>
                        <input
                          className="sample-metadata-input"
                          value={sample.cellLine ?? ""}
                          disabled={sample.kind === "blank"}
                          onFocus={beginEntryTextEdit}
                          onChange={(event) => {
                            const cellLine = event.target.value;
                            setSamples((current) =>
                              current.map((item) =>
                                item.id === sample.id
                                  ? { ...item, cellLine }
                                  : item,
                              ),
                            );
                            markChanged();
                          }}
                          onBlur={finishEntryTextEdit}
                          placeholder={tr("细胞系（可选）", "Cell line (optional)")}
                          aria-label={tr(
                            `${sample.name || "当前样本"}的细胞系`,
                            `Cell line for ${sample.name || "this sample"}`,
                          )}
                        />
                        <input
                          className="sample-metadata-input"
                          value={sample.comparisonGroup ?? ""}
                          disabled={sample.kind === "blank"}
                          onFocus={beginEntryTextEdit}
                          onChange={(event) => {
                            const comparisonGroup = event.target.value;
                            setSamples((current) =>
                              current.map((item) =>
                                item.id === sample.id
                                  ? { ...item, comparisonGroup }
                                  : item,
                              ),
                            );
                            markChanged();
                          }}
                          onBlur={finishEntryTextEdit}
                          placeholder={tr("比较组（可选）", "Comparison group (optional)")}
                          aria-label={tr(
                            `${sample.name || "当前样本"}的比较组`,
                            `Comparison group for ${sample.name || "this sample"}`,
                          )}
                        />
                        <button
                          className={`bridge-toggle ${sample.isBridge ? "is-active" : ""}`}
                          type="button"
                          disabled={
                            sample.kind === "blank" ||
                            !sample.cellLine?.trim() ||
                            !sample.comparisonGroup?.trim()
                          }
                          onClick={() => {
                            commitEntrySnapshot({
                              samples: samples.map((item) =>
                                item.id === sample.id
                                  ? { ...item, isBridge: !item.isBridge }
                                  : item,
                              ),
                              genes,
                            });
                          }}
                          aria-pressed={Boolean(sample.isBridge)}
                          title={tr(
                            "超大比较单元跨板时，桥接样本会在每块板重复检测目的基因及全部内参",
                            "When an oversized comparison unit spans plates, a bridge sample repeats the target and all references on every plate",
                          )}
                        >
                          {tr("桥接", "Bridge")}
                        </button>
                      </div>
                    </SortableEntryRow>
                  ))}
                  {comparisonAdvisories.map((advisory) => (
                    <p className="comparison-advisory" key={advisory.key}>
                      <Info size={12} />
                      <span>{advisory.message}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSampleIds(advisory.sampleIds);
                          setBulkCellLine(advisory.cellLine);
                          setBulkComparisonGroup("");
                        }}
                      >
                        {tr("设置比较组", "Assign group")}
                      </button>
                    </p>
                  ))}
                </div>
              )}
              {samples.length === 0 && !sampleDraftOpen && (
                <p className="microcopy">
                  {tr("尚未添加样本", "No samples added")}
                </p>
              )}
              {sampleDraftOpen ? (
                <form
                  className="sample-row sample-draft-row"
                  onSubmit={submitSample}
                >
                  <input
                    className="sample-name-input"
                    value={sampleInput}
                    onChange={(event) => setSampleInput(event.target.value)}
                    placeholder={tr("输入样本名称", "Enter sample name")}
                    aria-label={tr("新样本名称", "New sample name")}
                    autoFocus
                  />
                  <button
                    className={`entry-type-toggle ${
                      sampleInputKind === "blank" ? "is-blank" : ""
                    }`}
                    type="button"
                    onClick={() =>
                      setSampleInputKind((current) =>
                        current === "sample" ? "blank" : "sample",
                      )
                    }
                    aria-pressed={sampleInputKind === "blank"}
                    aria-label={tr(
                      `将新样本切换为${
                        sampleInputKind === "sample" ? "Blank" : "样本"
                      }`,
                      `Change new sample to ${
                        sampleInputKind === "sample" ? "Blank" : "Sample"
                      }`,
                    )}
                  >
                    {sampleInputKind === "blank"
                      ? "Blank"
                      : tr("样本", "Sample")}
                  </button>
                  <div className="sample-draft-actions">
                    <button
                      className="sample-delete-button"
                      type="submit"
                      disabled={!sampleInput.trim()}
                      aria-label={tr("确认添加此行", "Add this row")}
                    >
                      <Check size={15} />
                    </button>
                    <button
                      className="sample-delete-button"
                      type="button"
                      onClick={() => {
                        setSampleInput("");
                        setSampleInputKind("sample");
                        setSampleDraftOpen(false);
                      }}
                      aria-label={tr("取消添加此行", "Cancel this row")}
                    >
                      <X size={15} />
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  className="sample-add-row"
                  type="button"
                  onClick={() => setSampleDraftOpen(true)}
                >
                  <Plus size={16} />
                  {tr("添加一行", "Add row")}
                </button>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div className="heading-with-index">
                <span className="section-index">03</span>
                <div>
                  <h2 className="panel-title">
                    {tr("添加检测基因", "Assays")}
                  </h2>
                  <p className="panel-description">
                    {tr(
                      "逐行设置名称及目的/内参类型",
                      "Set a name and target/reference type for each row",
                    )}
                  </p>
                </div>
              </div>
              {genes.length > 0 && (
                <button
                  className="button button-clear"
                  type="button"
                  onClick={() => {
                    commitEntrySnapshot({ samples, genes: [] });
                    setGeneInput("");
                    setGeneInputRole("target");
                    setGeneDraftOpen(false);
                    setGeneQuickCount("");
                  }}
                >
                  {tr("清空", "Clear")}
                </button>
              )}
            </div>
            <div className="entry-stack">
              <div className="sample-import-area">
                <textarea
                  className="batch-box sample-batch-box"
                  value={genePaste}
                  onChange={(event) => setGenePaste(event.target.value)}
                  placeholder={tr(
                    "从 Excel 粘贴基因名称，每行一个…",
                    "Paste assay names from Excel, one per line…",
                  )}
                  aria-label={tr("批量粘贴基因", "Paste assays in bulk")}
                />
                <button
                  className="button button-soft sample-import-button"
                  type="button"
                  disabled={genePasteNames.length === 0}
                  onClick={() => {
                    addGenes(genePasteNames);
                    setGenePaste("");
                  }}
                >
                  <Plus size={15} />
                  {tr(
                    `导入 ${genePasteNames.length} 个基因名称`,
                    `Import ${genePasteNames.length} assay ${
                      genePasteNames.length === 1 ? "name" : "names"
                    }`,
                  )}
                </button>
                <form className="quick-fill-row" onSubmit={submitQuickGenes}>
                  <input
                    className="quick-fill-input"
                    type="number"
                    min={1}
                    max={MAX_QUICK_ENTRY_COUNT}
                    step={1}
                    inputMode="numeric"
                    value={geneQuickCount}
                    onChange={(event) => setGeneQuickCount(event.target.value)}
                    placeholder={tr("基因数量（1–999）", "Assay count (1–999)")}
                    aria-label={tr("快速输入基因数量", "Quick assay count")}
                  />
                  <button
                    className="button button-soft quick-fill-button"
                    type="submit"
                    disabled={parsedGeneQuickCount === null}
                    aria-label={tr(
                      "快速添加编号检测基因",
                      "Quickly add numbered assays",
                    )}
                  >
                    <Sparkles size={15} />
                    {tr("快速添加", "Quick add")}
                  </button>
                </form>
              </div>
              {genes.length > 0 && (
                <div
                  className="gene-list"
                  aria-label={tr("已添加基因", "Added assays")}
                >
                  <p className="entry-order-help">
                    <GripVertical size={12} />
                    {tr(
                      "拖动排序，点按手柄可上移/下移；⌘/Ctrl+Z 撤销",
                      "Drag to reorder, or tap the handle for move controls; ⌘/Ctrl+Z to undo",
                    )}
                  </p>
                  {genes.map((gene, index) => (
                    <SortableEntryRow
                      key={gene.id}
                      entry={{ kind: "gene", id: gene.id }}
                      name={gene.name}
                      index={index}
                      count={genes.length}
                      draggedEntry={draggedEntry}
                      dropTarget={dropTarget}
                      dragLabel={tr(
                        `拖动调整基因 ${gene.name || "当前行"} 顺序；点击可选择上移或下移`,
                        `Drag to reorder assay ${gene.name || "this row"}; click for move up or move down controls`,
                      )}
                      dragTitle={tr(
                        "拖动排序，或点击选择上移/下移",
                        "Drag to reorder, or click for move controls",
                      )}
                      moveUpLabel={tr("上移", "Move up")}
                      moveDownLabel={tr("下移", "Move down")}
                      onDragStart={handleEntryDragStart}
                      onDragEnd={handleEntryDragEnd}
                      onDragOver={handleEntryDragOver}
                      onDrop={handleEntryDrop}
                      onMove={(entry, offset) =>
                        moveEntryWithKeyboard(entry.kind, entry.id, offset)
                      }
                    >
                      <input
                        className="sample-name-input"
                        value={gene.name}
                        onChange={(event) => {
                          const nextName = event.target.value;
                          setGenes((current) =>
                            current.map((item) =>
                              item.id === gene.id
                                ? { ...item, name: nextName }
                                : item,
                            ),
                          );
                          markChanged();
                        }}
                        onBlur={(event) => {
                          const trimmedName = event.target.value.trim();
                          if (trimmedName === event.target.value) return;
                          setGenes((current) =>
                            current.map((item) =>
                              item.id === gene.id
                                ? { ...item, name: trimmedName }
                                : item,
                            ),
                          );
                        }}
                        placeholder={tr("基因名称", "Assay name")}
                        aria-label={tr(
                          `基因名称：${gene.name || "未填写"}`,
                          `Assay name: ${gene.name || "empty"}`,
                        )}
                      />
                      <button
                        className={`entry-type-toggle ${
                          gene.role === "reference" ? "is-reference" : ""
                        }`}
                        type="button"
                        onClick={() => {
                          commitEntrySnapshot({
                            samples,
                            genes: genes.map((item) =>
                              item.id === gene.id
                                ? {
                                    ...item,
                                    role:
                                      item.role === "target"
                                        ? "reference"
                                        : "target",
                                  }
                                : item,
                            ),
                          });
                        }}
                        aria-pressed={gene.role === "reference"}
                        aria-label={tr(
                          `将 ${gene.name || "当前行"}切换为${
                            gene.role === "target" ? "内参" : "目的基因"
                          }`,
                          `Change ${gene.name || "this row"} to ${
                            gene.role === "target" ? "reference" : "target"
                          }`,
                        )}
                      >
                        {gene.role === "reference"
                          ? tr("内参", "Reference")
                          : tr("目的基因", "Target")}
                      </button>
                      <button
                        className="sample-delete-button"
                        type="button"
                        onClick={() => {
                          commitEntrySnapshot({
                            samples,
                            genes: genes.filter((item) => item.id !== gene.id),
                          });
                        }}
                        aria-label={tr(
                          `删除基因 ${gene.name}`,
                          `Remove assay ${gene.name}`,
                        )}
                      >
                        <Trash2 size={15} />
                      </button>
                    </SortableEntryRow>
                  ))}
                </div>
              )}
              {genes.length === 0 && !geneDraftOpen && (
                <p className="microcopy">
                  {tr("尚未添加检测基因", "No assays added")}
                </p>
              )}
              {geneDraftOpen ? (
                <form
                  className="sample-row sample-draft-row"
                  onSubmit={submitGene}
                >
                  <input
                    className="sample-name-input"
                    value={geneInput}
                    onChange={(event) => setGeneInput(event.target.value)}
                    placeholder={tr("输入基因名称", "Enter assay name")}
                    aria-label={tr("新基因名称", "New assay name")}
                    autoFocus
                  />
                  <button
                    className={`entry-type-toggle ${
                      geneInputRole === "reference" ? "is-reference" : ""
                    }`}
                    type="button"
                    onClick={() =>
                      setGeneInputRole((current) =>
                        current === "target" ? "reference" : "target",
                      )
                    }
                    aria-pressed={geneInputRole === "reference"}
                    aria-label={tr(
                      `将新基因切换为${
                        geneInputRole === "target" ? "内参" : "目的基因"
                      }`,
                      `Change new assay to ${
                        geneInputRole === "target" ? "reference" : "target"
                      }`,
                    )}
                  >
                    {geneInputRole === "reference"
                      ? tr("内参", "Reference")
                      : tr("目的基因", "Target")}
                  </button>
                  <div className="sample-draft-actions">
                    <button
                      className="sample-delete-button"
                      type="submit"
                      disabled={!geneInput.trim()}
                      aria-label={tr("确认添加此行", "Add this row")}
                    >
                      <Check size={15} />
                    </button>
                    <button
                      className="sample-delete-button"
                      type="button"
                      onClick={() => {
                        setGeneInput("");
                        setGeneInputRole("target");
                        setGeneDraftOpen(false);
                      }}
                      aria-label={tr("取消添加此行", "Cancel this row")}
                    >
                      <X size={15} />
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  className="sample-add-row"
                  type="button"
                  onClick={() => setGeneDraftOpen(true)}
                >
                  <Plus size={16} />
                  {tr("添加一行", "Add row")}
                </button>
              )}
              {referenceGenes.length === 0 && (
                <div className="notice notice-warning">
                  <AlertTriangle size={15} />
                  <span>
                    {tr(
                      "尚未设置内参；请至少将 1 个基因标记为“内参”，数量不限。",
                      "No reference selected. Mark at least one assay as a reference; multiple references are supported.",
                    )}
                  </span>
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div className="heading-with-index">
                <span className="section-index">04</span>
                <div>
                  <h2 className="panel-title">
                    {tr("技术复孔", "Technical replicates")}
                  </h2>
                  <p className="panel-description">
                    {tr(
                      "同行从左到右连续",
                      "Contiguous left-to-right within a row",
                    )}
                  </p>
                </div>
              </div>
            </div>
            <div className="replicate-control">
              <div className="stepper">
                <button
                  type="button"
                  onClick={() => {
                    setReplicates((value) => Math.max(1, value - 1));
                    markChanged();
                  }}
                  aria-label={tr("减少复孔数", "Decrease replicates")}
                >
                  <Minus size={14} />
                </button>
                <input
                  value={replicates}
                  type="number"
                  min={1}
                  max={dimensions.columns}
                  onChange={(event) => {
                    setReplicates(Number(event.target.value));
                    markChanged();
                  }}
                  aria-label={tr("技术复孔数", "Technical replicate count")}
                />
                <button
                  type="button"
                  onClick={() => {
                    setReplicates((value) =>
                      Math.min(dimensions.columns, value + 1),
                    );
                    markChanged();
                  }}
                  aria-label={tr("增加复孔数", "Increase replicates")}
                >
                  <Plus size={14} />
                </button>
              </div>
              <span className="microcopy">
                {tr(
                  "例如 3 复孔：A1–A3；下一组从 A4 开始",
                  "Example, 3 replicates: A1–A3; the next block starts at A4",
                )}
              </span>
            </div>
            <div className="layout-preset">
              <div className="layout-preset-heading">
                <span className="field-label">
                  {tr("排布方式", "Layout mode")}
                </span>
                <div
                  className="segmented layout-direction-toggle"
                  role="group"
                  aria-label={tr("选择填充方向", "Choose fill direction")}
                >
                  <button
                    className={fillDirection === "vertical" ? "active" : ""}
                    type="button"
                    aria-pressed={fillDirection === "vertical"}
                    onClick={() => chooseFillDirection("vertical")}
                  >
                    {tr("纵向优先", "Vertical first")}
                  </button>
                  <button
                    className={
                      fillDirection === "horizontal" ? "active" : ""
                    }
                    type="button"
                    aria-pressed={fillDirection === "horizontal"}
                    onClick={() => chooseFillDirection("horizontal")}
                  >
                    {tr("横向优先", "Horizontal first")}
                  </button>
                </div>
              </div>
              <div
                className="segmented layout-preset-toggle"
                role="group"
                aria-label={tr("选择排布方式", "Choose layout mode")}
              >
                <button
                  className={
                    layoutPreset === "sample-major" ? "active" : ""
                  }
                  type="button"
                  aria-pressed={layoutPreset === "sample-major"}
                  onClick={() => {
                    setLayoutPreset("sample-major");
                    markChanged();
                  }}
                >
                  {tr("按样本排列", "By sample")}
                </button>
                <button
                  className={
                    layoutPreset === "gene-major" ? "active" : ""
                  }
                  type="button"
                  aria-pressed={layoutPreset === "gene-major"}
                  onClick={() => {
                    setLayoutPreset("gene-major");
                    markChanged();
                  }}
                >
                  {tr("按基因排列", "By assay")}
                </button>
              </div>
              <p className="microcopy layout-preset-help">
                {plateType === 384 &&
                loadingPattern === "interleaved-8-channel"
                  ? layoutPreset === "sample-major"
                    ? fillDirection === "horizontal"
                      ? tr(
                          "同一样本的全部基因优先相邻；检测块先向右铺开，再按隔行上样行序下移。",
                          "Keep one sample's assays together; fill rightward first, then move down the interleaved row order.",
                        )
                      : tr(
                          "同一样本的全部基因优先相邻；检测块按两次隔行上样路径纵向填充，再向右换列。",
                          "Keep one sample's assays together; fill the two interleaved passes vertically before moving right.",
                        )
                    : fillDirection === "horizontal"
                      ? tr(
                          "同一基因的全部样本优先相邻；样本按输入顺序先向右铺开，再按隔行上样行序下移。",
                          "Keep one assay's samples together; follow sample order rightward first, then move down the interleaved row order.",
                        )
                      : tr(
                          "同一基因的全部样本优先相邻；样本按两次隔行上样路径纵向填充，再向右换列。",
                          "Keep one assay's samples together; fill the two interleaved passes vertically before moving right.",
                        )
                  : layoutPreset === "sample-major"
                    ? fillDirection === "horizontal"
                      ? tr(
                          "同一样本的全部基因优先相邻；检测块从左到右，再从上到下。",
                          "Keep all assays for one sample together; fill blocks left-to-right, then top-to-bottom.",
                        )
                      : tr(
                          "同一样本的全部基因优先相邻；检测块从上到下，再从左到右。",
                          "Keep all assays for one sample together; fill blocks top-to-bottom, then left-to-right.",
                        )
                    : fillDirection === "horizontal"
                      ? tr(
                          "同一基因的全部样本优先相邻；样本按输入顺序从左到右，再从上到下。",
                          "Keep all samples for one assay together; follow sample order left-to-right, then top-to-bottom.",
                        )
                      : tr(
                          "同一基因的全部样本优先相邻；样本按输入顺序从上到下，再从左到右。",
                          "Keep all samples for one assay together; follow sample order top-to-bottom, then left-to-right.",
                        )}
              </p>
            </div>
            {plateType === 384 && (
              <div className="loading-pattern">
                <div className="loading-pattern-heading">
                  <span className="field-label">
                    {tr("384 孔上样方式", "384-well loading pattern")}
                  </span>
                  <span className="loading-pattern-badge">
                    {tr("物理孔位映射", "Physical mapping")}
                  </span>
                </div>
                <div
                  className="loading-pattern-options"
                  role="radiogroup"
                  aria-label={tr(
                    "选择 384 孔上样方式",
                    "Choose the 384-well loading pattern",
                  )}
                >
                  <button
                    className={`loading-pattern-option ${
                      loadingPattern === "interleaved-8-channel"
                        ? "selected"
                        : ""
                    }`}
                    type="button"
                    role="radio"
                    aria-checked={
                      loadingPattern === "interleaved-8-channel"
                    }
                    onClick={() =>
                      chooseLoadingPattern("interleaved-8-channel")
                    }
                  >
                    <span
                      className="loading-pattern-radio"
                      aria-hidden="true"
                    />
                    <span>
                      <strong>
                        {tr(
                          "八道排枪隔行上样",
                          "Interleaved 8-channel loading",
                        )}
                      </strong>
                      <small>
                        {tr(
                          "固定 9 mm · 推荐",
                          "Fixed 9 mm · Recommended",
                        )}
                      </small>
                    </span>
                  </button>
                  <button
                    className={`loading-pattern-option ${
                      loadingPattern === "sequential" ? "selected" : ""
                    }`}
                    type="button"
                    role="radio"
                    aria-checked={loadingPattern === "sequential"}
                    onClick={() => chooseLoadingPattern("sequential")}
                  >
                    <span
                      className="loading-pattern-radio"
                      aria-hidden="true"
                    />
                    <span>
                      <strong>
                        {tr(
                          "连续孔位上样",
                          "Sequential well loading",
                        )}
                      </strong>
                      <small>
                        {tr(
                          "4.5 mm / 自动化 / 单道",
                          "4.5 mm / automation / single-channel",
                        )}
                      </small>
                    </span>
                  </button>
                </div>
                {loadingPattern === "interleaved-8-channel" && (
                  <div
                    className={`loading-pattern-advisory ${
                      layoutPreset === "sample-major" ||
                      fillDirection === "horizontal"
                        ? "attention"
                        : ""
                    }`}
                  >
                    <Info size={13} aria-hidden="true" />
                    <span>
                      {layoutPreset === "sample-major"
                        ? tr(
                            "按基因排列才会生成固定 A–H 来源板映射；当前仍可按样本生成，但来源板需人工规划。",
                            "Assay-major generates the fixed A–H source-plate map. Sample-major remains available, but its source plate must be planned manually.",
                          )
                        : fillDirection === "horizontal"
                          ? tr(
                              "横向优先会先沿列块铺开，不生成固定 A–H 来源板映射；如需八道排枪直接转移，建议使用纵向优先。",
                              "Horizontal-first fills across column blocks and does not generate a fixed A–H source-plate map; use vertical-first for direct 8-channel transfer.",
                            )
                        : tr(
                            "默认样本源板按输入顺序 A–H 向下、再到下一列；每个基因先排 A/C/E/G/I/K/M/O，再排 B/D/F/H/J/L/N/P。",
                            "The source plate follows input order down A–H, then advances one column; each assay uses A/C/E/G/I/K/M/O, then B/D/F/H/J/L/N/P.",
                          )}
                    </span>
                  </div>
                )}
              </div>
            )}
            <div className="setup-summary">
              <strong>
                {tr(
                  `${sampleNames.length} 样本 × ${completeGenes.length} 基因 × ${
                    replicates || 0
                  } 复孔`,
                  `${sampleNames.length} samples × ${completeGenes.length} assays × ${
                    replicates || 0
                  } replicates`,
                )}
              </strong>
              <span>
                {tr(
                  `基础反应孔 ${reactionWells} 个（未计跨板内参重做）· 单样本全部基因需 ${sampleFullRunWells} 孔 · ${referenceGenes.length} 个内参`,
                  `${reactionWells} base wells before cross-plate reference reruns · ${sampleFullRunWells} wells per complete sample assay set · ${referenceGenes.length} reference assay(s)`,
                )}
              </span>
            </div>
            {inputIssues.length > 0 && (
              <div className="notice notice-warning">
                <AlertTriangle size={15} />
                <span>{inputIssues[0]}</span>
              </div>
            )}
            <button
              className="button button-primary generate-button"
              type="button"
              onClick={generateLayout}
              disabled={inputIssues.length > 0}
            >
              <Sparkles size={16} />
              {layout
                ? tr("重新生成布局", "Regenerate layout")
                : tr("生成布局", "Generate layout")}
            </button>
          </section>
        </aside>

        <main
          className="main-area"
          data-scroll-region="plate-preview"
          aria-label={tr("板布局工作区", "Plate layout workspace")}
        >
          <section className="hero-strip" aria-labelledby="planner-title">
            <div>
              <p className="eyebrow">
                <ShieldCheck size={13} />
                {tr("版布局预览", "Layout preview")}
              </p>
              <h1 className="hero-title" id="planner-title">
                {layout
                  ? tr(
                      `已生成 ${layout.plates.length} 块实验板`,
                      `${layout.plates.length} plate(s) generated`,
                    )
                  : tr(
                      "先设置样本、基因与复孔",
                      "Set samples, assays, and replicates",
                    )}
              </h1>
              <p className="hero-copy">
                {previewIs384 &&
                previewLoadingPattern === "interleaved-8-channel"
                  ? (layout?.strategy ?? layoutPreset) === "gene-major"
                    ? previewFillDirection === "horizontal"
                      ? tr(
                          "按基因排列：同一基因下的样本按输入顺序先向右铺开，再按隔行上样行序下移；复孔同行横向连续。样本目的基因跨板时，新板会重新安排该样本的全部内参。",
                          "By assay: samples follow input order rightward first, then move down the interleaved row order; replicates stay contiguous within a row. When a sample continues onto another plate, all references are rerun there.",
                        )
                      : tr(
                          "按基因排列：同一基因下的样本先填充 A/C/E/G/I/K/M/O，再填充 B/D/F/H/J/L/N/P；复孔同行横向连续。样本目的基因跨板时，新板会重新安排该样本的全部内参。",
                          "By assay: samples fill A/C/E/G/I/K/M/O first, then B/D/F/H/J/L/N/P; replicates stay contiguous within a row. When a sample continues onto another plate, all references are rerun there.",
                        )
                    : previewFillDirection === "horizontal"
                      ? tr(
                          "按样本排列：同一样本的全部基因优先成组，检测块先向右铺开，再按隔行上样行序下移；复孔同行横向连续。样本目的基因跨板时，新板会重新安排该样本的全部内参。",
                          "By sample: one sample's assays stay grouped, fill rightward first, then move down the interleaved row order; replicates remain contiguous within a row. When a sample continues onto another plate, all references are rerun there.",
                        )
                      : tr(
                          "按样本排列：同一样本的全部基因优先成组，并按两次隔行上样路径纵向填充；复孔同行横向连续。样本目的基因跨板时，新板会重新安排该样本的全部内参。按基因排列通常更适合八道排枪直接转移。",
                          "By sample: one sample's assays stay grouped and fill the two interleaved loading passes vertically; replicates remain contiguous within a row. When a sample continues onto another plate, all references are rerun there. Assay-major is usually better for direct 8-channel transfer.",
                        )
                  : (layout?.strategy ?? layoutPreset) === "gene-major"
                    ? previewFillDirection === "horizontal"
                      ? tr(
                          "按基因排列：同一基因下的样本按输入顺序从左到右、再从上到下；复孔同行横向连续。样本目的基因跨板时，新板会重新安排该样本的全部内参。",
                          "By assay: samples follow input order left-to-right, then top-to-bottom; replicates stay contiguous within a row. When a sample continues onto another plate, all references are rerun there.",
                        )
                      : tr(
                          "按基因排列：同一基因下的样本按输入顺序从上到下、再从左到右；复孔同行横向连续。样本目的基因跨板时，新板会重新安排该样本的全部内参。",
                          "By assay: samples follow input order top-to-bottom, then left-to-right; replicates stay contiguous within a row. When a sample continues onto another plate, all references are rerun there.",
                        )
                    : previewFillDirection === "horizontal"
                      ? tr(
                          "按样本排列：同一样本的全部基因优先成组，从左到右、再从上到下；复孔同行横向连续。样本目的基因跨板时，新板会重新安排该样本的全部内参。",
                          "By sample: all assays for one sample stay grouped left-to-right, then top-to-bottom; replicates remain contiguous within a row. When a sample continues onto another plate, all references are rerun there.",
                        )
                      : tr(
                          "按样本排列：同一样本的全部基因优先成组，从上到下、再从左到右；复孔同行横向连续。样本目的基因跨板时，新板会重新安排该样本的全部内参。",
                          "By sample: all assays for one sample stay grouped top-to-bottom, then left-to-right; replicates remain contiguous within a row. When a sample continues onto another plate, all references are rerun there.",
                        )}
              </p>
            </div>
            <div
              className="summary-grid"
              aria-label={tr("布局摘要", "Layout summary")}
            >
              <div className="metric">
                <span className="metric-label">
                  {tr("预计孔板", "Plates")}
                </span>
                <strong className="metric-value">
                  {layout ? layout.metrics.plateCount : "—"}
                </strong>
                <span className="metric-detail">
                  {layout
                    ? tr(`${plateType} 孔板`, `${plateType}-well`)
                    : tr("等待输入", "Waiting")}
                </span>
              </div>
              <div className="metric">
                <span className="metric-label">
                  {tr("反应孔", "Reactions")}
                </span>
                <strong className="metric-value">
                  {layout ? layout.metrics.usedWells : reactionWells || "—"}
                </strong>
                <span className="metric-detail">
                  {layout
                    ? tr(
                        `含跨板重做内参 ${layout.metrics.repeatedReferenceWells} 孔`,
                        `${layout.metrics.repeatedReferenceWells} rerun reference wells included`,
                      )
                    : tr(
                        "生成后计入跨板重做内参",
                        "Reference reruns are counted after planning",
                      )}
                </span>
              </div>
              <div className="metric">
                <span className="metric-label">
                  {tr("利用率", "Utilization")}
                </span>
                <strong className="metric-value">
                  {layout
                    ? `${(layout.metrics.utilization * 100).toFixed(1)}%`
                    : "—"}
                </strong>
                <span className="metric-detail">
                  {layout
                    ? tr(
                        `${layout.metrics.emptyWells} 个空孔`,
                        `${layout.metrics.emptyWells} empty wells`,
                      )
                    : "—"}
                </span>
              </div>
              <div className="metric">
                <span className="metric-label">
                  {tr("排布方式", "Layout mode")}
                </span>
                <strong className="metric-value" style={{ fontSize: 17 }}>
                  {layout
                    ? layout.strategy === "sample-major"
                      ? tr("按样本", "Sample-major")
                      : layout.strategy === "gene-major"
                        ? tr("按基因", "Assay-major")
                        : tr("混合", "Hybrid")
                    : "—"}
                </strong>
                <span className="metric-detail">
                  {layout
                    ? tr(
                        `样本切换 ${layout.metrics.sampleSwitches} 次 · 引物切换 ${layout.metrics.primerSwitches} 次`,
                        `${layout.metrics.sampleSwitches} sample switches · ${layout.metrics.primerSwitches} assay switches`,
                      )
                    : tr("等待生成", "Waiting")}
                </span>
              </div>
              {layout && (
                <p className="rationale">
                  {layout.strategy === "gene-major"
                    ? tr(
                        `先优化板数与跨板内参重做，再按基因分组${layout.fillDirection === "horizontal" ? "横向" : "纵向"}填充；空余孔位保留。`,
                        `Plate count and reference reruns are optimized first, then assay groups fill ${layout.fillDirection === "horizontal" ? "horizontally" : "vertically"}; unused wells remain empty.`,
                      )
                    : tr(
                        `先优化板数与跨板内参重做，再按样本分组${layout.fillDirection === "horizontal" ? "横向" : "纵向"}填充；空余孔位保留。`,
                        `Plate count and reference reruns are optimized first, then sample groups fill ${layout.fillDirection === "horizontal" ? "horizontally" : "vertically"}; unused wells remain empty.`,
                      )}
                </p>
              )}
            </div>
          </section>

          {!layout ? (
            <section className="empty-state">
              <div className="empty-state-inner">
                <div className="ghost-plate" aria-hidden="true">
                  {Array.from({ length: 96 }).map((_, index) => (
                    <span className="ghost-well" key={index} />
                  ))}
                </div>
                <h2>{tr("先添加样本和检测基因", "Add samples and assays")}</h2>
                <p>
                  {tr(
                    "系统会计算孔板数，并生成可点选、移动和编辑的布局。",
                    "The planner calculates plate count and creates a selectable, movable, editable layout.",
                  )}
                </p>
                <button
                  className="button button-soft"
                  type="button"
                  onClick={loadExample}
                  style={{ marginTop: 18 }}
                >
                  <Beaker size={15} />
                  {tr("载入示例", "Load example")}
                </button>
              </div>
            </section>
          ) : (
            <>
              {settingsStale && (
                <div className="notice notice-error" style={{ marginBottom: 12 }}>
                  <AlertTriangle size={16} />
                  <span>
                    {tr(
                      "实验设置或排布方式已在生成后改变。当前布局仍保留用于对照，但需重新生成后才能确认和导出。",
                      "Experiment settings or layout mode changed after generation. The current layout is retained for reference; regenerate it before confirmation or export.",
                    )}
                  </span>
                </div>
              )}

              <nav
                className="plate-nav"
                aria-label={tr("孔板列表", "Plate list")}
              >
                {layout.plates.map((plate, index) => {
                  const isConfirmed = Boolean(
                    confirmed[String(plate.plateNumber)],
                  );
                  return (
                    <button
                      className={`plate-tab ${
                        activePlateIndex === index ? "active" : ""
                      }`}
                      type="button"
                      key={plate.id}
                      onClick={() => {
                        setActivePlateIndex(index);
                        runPlateEdits([
                          {
                            type: "select",
                            plateNumber: plate.plateNumber,
                            wellIds: [],
                            mode: "replace",
                          },
                          { type: "set-move-mode", enabled: false },
                        ]);
                        setEditingPlateName(false);
                      }}
                      aria-current={activePlateIndex === index ? "page" : undefined}
                    >
                      <span>
                        <span className="plate-tab-title">
                          {plate.name}
                        </span>
                        <span className="plate-tab-meta">
                          {tr(
                            `${plate.sampleNames.length} 样本`,
                            `${plate.sampleNames.length} samples`,
                          )}{" "}
                          ·{" "}
                          {
                            plate.wells.filter((well) => well.sample && well.gene)
                              .length
                          }{" "}
                          {tr("孔", "wells")}
                        </span>
                      </span>
                      <span
                        className={`plate-tab-state ${
                          settingsStale
                            ? "invalid"
                            : isConfirmed
                              ? "confirmed"
                              : ""
                        }`}
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
              </nav>

              {activePlate && (
                <div className="layout-workbench">
                  <section className="plate-card">
                  <div className="plate-card-heading">
                    <div>
                      <div className="plate-title-row">
                        {editingPlateName ? (
                          <input
                            className="plate-name-input"
                            value={plateNameDraft}
                            autoFocus
                            maxLength={80}
                            aria-label={tr("编辑板名", "Edit plate name")}
                            onChange={(event) =>
                              setPlateNameDraft(event.target.value)
                            }
                            onBlur={commitPlateName}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitPlateName();
                              }
                              if (event.key === "Escape") {
                                setEditingPlateName(false);
                                setPlateNameDraft(activePlate.name);
                              }
                            }}
                          />
                        ) : (
                          <button
                            className="plate-name-button"
                            type="button"
                            disabled={activePlateConfirmed}
                            onClick={() => {
                              setPlateNameDraft(activePlate.name);
                              setEditingPlateName(true);
                            }}
                            title={tr("修改板名", "Rename plate")}
                          >
                            <span className="plate-title">
                              {activePlate.name}
                            </span>
                            <Pencil size={13} aria-hidden="true" />
                          </button>
                        )}
                        <span
                          className={`status-pill ${currentStatus.className}`}
                        >
                          {currentStatus.className === "confirmed" && (
                            <Check size={12} />
                          )}
                          {currentStatus.label}
                        </span>
                      </div>
                      <div className="plate-subtitle">
                        <span>
                          {tr(
                            `板号 ${String(activePlate.plateNumber).padStart(
                              2,
                              "0",
                            )} · ${plateType} 孔 · 已使用 ${
                              activePlate.wells.filter(
                                (well) => well.sample && well.gene,
                              ).length
                            } / ${plateType} · ${activePlate.sampleNames.length} 个样本`,
                            `Plate ID ${String(activePlate.plateNumber).padStart(
                              2,
                              "0",
                            )} · ${plateType}-well · ${
                              activePlate.wells.filter(
                                (well) => well.sample && well.gene,
                              ).length
                            } / ${plateType} used · ${activePlate.sampleNames.length} samples`,
                          )}
                        </span>
                        {activePlate.sampleNames.length > 0 && (
                          <details className="plate-sample-details">
                            <summary>
                              {tr("查看样本", "View samples")}
                            </summary>
                            <span>
                              {activePlate.sampleNames.join(
                                language === "zh" ? "、" : ", ",
                              )}
                            </span>
                          </details>
                        )}
                      </div>
                    </div>
                    <div className="plate-actions">
                      <button
                        className="button button-quiet"
                        type="button"
                        onClick={restoreActivePlate}
                        disabled={
                          activePlateConfirmed ||
                          !activePlate.wells.some(
                            (well) => well.source === "manual",
                          )
                        }
                      >
                        <RotateCcw size={14} />
                        {tr("恢复生成布局", "Restore")}
                      </button>
                      <button
                        className={`button ${
                          activePlateConfirmed ? "button-soft" : ""
                        }`}
                        type="button"
                        onClick={togglePlateConfirmation}
                      >
                        <ShieldCheck size={14} />
                        {activePlateConfirmed
                          ? tr("解除确认", "Unlock")
                          : tr("确认本板", "Confirm")}
                      </button>
                      <button
                        className="button button-primary"
                        type="button"
                        onClick={downloadActivePlate}
                        disabled={
                          !activePlateConfirmed ||
                          !reactionCalculation.valid ||
                          settingsStale
                        }
                      >
                        <Download size={14} />
                        {tr("导出 Excel", "Export Excel")}
                      </button>
                    </div>
                  </div>

                  <div className="plate-context">
                    <div
                      className="legend"
                      aria-label={tr("颜色图例", "Color legend")}
                    >
                      {completeGenes.map((gene) => {
                        const color =
                          gene.role === "reference"
                            ? "#F3DFC4"
                            : targetColor(gene.name, targetGenes).background;
                        return (
                          <span className="legend-item" key={gene.id}>
                            <span
                              className="legend-dot"
                              style={
                                {
                                  "--legend-color": color,
                                } as CSSProperties
                              }
                            />
                            <span>
                              {gene.name}
                              {gene.role === "reference"
                                ? tr(" · 内参", " · Reference")
                                : ""}
                            </span>
                          </span>
                        );
                      })}
                      <span className="legend-item">
                        <span className="legend-dot manual" />
                        <span>{tr("手动修改", "Manual")}</span>
                      </span>
                      {blankSampleNames.length > 0 && (
                        <span className="legend-item">
                          <span className="legend-dot blank" />
                          <span>Blank</span>
                        </span>
                      )}
                    </div>
                    <span className="plate-hint">
                      {tr(
                        "单击选择 · Shift 连选 · 拖动框选 · Ctrl/⌘ 增减 · 双击编辑",
                        "Click · Shift range · Drag to box-select · Ctrl/⌘ toggle · Double-click to edit",
                      )}
                    </span>
                  </div>

                  {activePlate.rows === 16 &&
                    previewLoadingPattern === "interleaved-8-channel" && (
                      <div
                        className="loading-route-guide"
                        aria-label={tr(
                          "八道排枪隔行上样路径",
                          "Interleaved 8-channel loading route",
                        )}
                      >
                        <span className="loading-route-guide-title">
                          {tr("上样路径", "Loading route")}
                        </span>
                        <span className="loading-route-pass pass-one">
                          <b aria-hidden="true">①</b>
                          <span>
                            {tr("第 1 次", "Pass 1")} · A/C/E/G/I/K/M/O
                          </span>
                        </span>
                        <span className="loading-route-pass pass-two">
                          <b aria-hidden="true">②</b>
                          <span>
                            {tr("第 2 次", "Pass 2")} · B/D/F/H/J/L/N/P
                          </span>
                        </span>
                        <span className="loading-route-note">
                          {tr(
                            "孔板仍按真实 A–P 顺序显示",
                            "Plate remains in physical A–P order",
                          )}
                        </span>
                      </div>
                    )}

                  <div className="selection-toolbar" aria-live="polite">
                    <span>
                      {selectedWellIds.length > 0
                        ? tr(
                            `已选 ${selectedWellIds.length} 孔（其中 ${selectedOccupiedCount} 个检测孔）`,
                            `${selectedWellIds.length} selected (${selectedOccupiedCount} occupied)`,
                          )
                        : tr(
                            "选择一个或多个孔后可编辑或平移",
                            "Select one or more wells to edit or move",
                          )}
                    </span>
                    <div className="selection-actions">
                      <button
                        className="button button-quiet"
                        type="button"
                        onClick={copySelection}
                        disabled={selectedWellIds.length === 0}
                        title={tr(
                          "复制所选孔（⌘/Ctrl + C）",
                          "Copy selected wells (⌘/Ctrl + C)",
                        )}
                      >
                        <Copy size={13} />
                        {tr("复制", "Copy")}
                      </button>
                      <button
                        className="button button-quiet"
                        type="button"
                        onClick={pasteSelection}
                        disabled={
                          !wellClipboard ||
                          selectedWellIds.length === 0 ||
                          activePlateConfirmed ||
                          settingsStale
                        }
                        title={tr(
                          "粘贴到所选起始孔（⌘/Ctrl + V）",
                          "Paste at selected anchor (⌘/Ctrl + V)",
                        )}
                      >
                        <ClipboardPaste size={13} />
                        {tr("粘贴", "Paste")}
                      </button>
                      <button
                        className="button button-quiet"
                        type="button"
                        onClick={undoLayout}
                        disabled={undoStack.length === 0}
                        title={tr(
                          "撤回手动编辑（⌘/Ctrl + Z）",
                          "Undo manual edit (⌘/Ctrl + Z)",
                        )}
                      >
                        <Undo2 size={13} />
                        {tr("撤回", "Undo")}
                      </button>
                      <button
                        className="button button-quiet"
                        type="button"
                        onClick={redoLayout}
                        disabled={redoStack.length === 0}
                        title={tr(
                          "重做手动编辑（⇧ + ⌘/Ctrl + Z）",
                          "Redo manual edit (⇧ + ⌘/Ctrl + Z)",
                        )}
                      >
                        <Redo2 size={13} />
                        {tr("重做", "Redo")}
                      </button>
                      <button
                        className="button button-quiet"
                        type="button"
                        disabled={
                          selectedWellIds.length === 0 ||
                          activePlateConfirmed ||
                          settingsStale
                        }
                        onClick={() =>
                          openEditorForSelection(
                            activePlateIndex,
                            activePlate,
                            selectedWellIds,
                          )
                        }
                      >
                        <Pencil size={13} />
                        {tr("编辑", "Edit")}
                      </button>
                      <button
                        className="button button-quiet"
                        type="button"
                        disabled={
                          selectedWellIds.length === 0 ||
                          activePlateConfirmed ||
                          settingsStale ||
                          !selectedWellIds.some(
                            (wellId) =>
                              activePlate.wells.find(
                                (well) => well.wellId === wellId,
                              )?.source === "manual",
                          )
                        }
                        onClick={restoreSelectedFromAutomatic}
                      >
                        <RotateCcw size={13} />
                        {tr("恢复所选", "Restore selected")}
                      </button>
                      <button
                        className={`button button-quiet ${
                          moveMode ? "active" : ""
                        }`}
                        type="button"
                        disabled={
                          selectedOccupiedCount === 0 ||
                          activePlateConfirmed ||
                          settingsStale
                        }
                        onClick={() =>
                          runPlateEdit({
                            type: "set-move-mode",
                            enabled: !moveMode,
                          })
                        }
                      >
                        <Move size={13} />
                        {moveMode
                          ? tr("点选目标孔", "Choose destination")
                          : tr("平移", "Move")}
                      </button>
                      <button
                        className="button button-clear"
                        type="button"
                        disabled={
                          selectedWellIds.length === 0 ||
                          activePlateConfirmed ||
                          settingsStale
                        }
                        onClick={clearSelectedWells}
                      >
                        <Trash2 size={13} />
                        {tr("清空孔", "Clear wells")}
                      </button>
                      {selectedWellIds.length > 0 && (
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => {
                            runPlateEdits([
                              {
                                type: "select",
                                plateNumber: activePlate.plateNumber,
                                wellIds: [],
                                mode: "replace",
                              },
                              { type: "set-move-mode", enabled: false },
                            ]);
                          }}
                          aria-label={tr("取消选择", "Clear selection")}
                        >
                          <X size={14} />
                        </button>
                      )}
                      <span
                        className="zoom-controls"
                        role="group"
                        aria-label={tr("孔板视图缩放", "Plate view zoom")}
                      >
                        <button
                          className="icon-button"
                          type="button"
                          disabled={plateZoom <= 0.5}
                          onClick={() =>
                            setPlateZoom((value) =>
                              Math.max(
                                0.5,
                                Number((value - 0.1).toFixed(1)),
                              ),
                            )
                          }
                          aria-label={tr("缩小孔板", "Zoom out")}
                        >
                          <ZoomOut size={14} />
                        </button>
                        <button
                          className="zoom-value"
                          type="button"
                          onClick={() => setPlateZoom(1)}
                          title={tr("恢复 100%", "Reset to 100%")}
                        >
                          {Math.round(plateZoom * 100)}%
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          disabled={plateZoom >= 1.3}
                          onClick={() =>
                            setPlateZoom((value) =>
                              Math.min(
                                1.3,
                                Number((value + 0.1).toFixed(1)),
                              ),
                            )
                          }
                          aria-label={tr("放大孔板", "Zoom in")}
                        >
                          <ZoomIn size={14} />
                        </button>
                      </span>
                    </div>
                  </div>

                  <div className="plate-scroll">
                    <div
                      className={`plate-grid ${
                        activePlate.rows === 16 ? "plate-384" : ""
                      } ${moveMode ? "move-mode" : ""} ${
                        boxSelection?.active ? "is-box-selecting" : ""
                      }`}
                      style={
                        {
                          "--plate-columns": activePlate.columns,
                          zoom: plateZoom,
                        } as CSSProperties
                      }
                      role="grid"
                      onPointerDown={(event) =>
                        beginBoxSelection(event, activePlate)
                      }
                      onPointerMove={(event) =>
                        updateBoxSelection(event, activePlate)
                      }
                      onPointerUp={finishBoxSelection}
                      onPointerCancel={cancelBoxSelection}
                      aria-label={tr(
                        `${activePlate.name} 孔板布局`,
                        `${activePlate.name} plate layout`,
                      )}
                    >
                      {boxSelection?.active && (
                        <span
                          className="well-selection-box"
                          aria-hidden="true"
                          style={{
                            left: Math.min(
                              boxSelection.startX,
                              boxSelection.currentX,
                            ),
                            top: Math.min(
                              boxSelection.startY,
                              boxSelection.currentY,
                            ),
                            width: Math.abs(
                              boxSelection.currentX - boxSelection.startX,
                            ),
                            height: Math.abs(
                              boxSelection.currentY - boxSelection.startY,
                            ),
                          }}
                        />
                      )}
                      <span className="grid-corner" aria-hidden="true" />
                      {Array.from({ length: activePlate.columns }).map(
                        (_, column) => (
                          <span
                            className="column-header"
                            role="columnheader"
                            key={`column-${column}`}
                          >
                            {column + 1}
                          </span>
                        ),
                      )}
                      {Array.from({ length: activePlate.rows }).map((_, row) => (
                        <Fragment key={`row-${row}`}>
                          <span
                            className={`row-header ${
                              activePlate.rows === 16 &&
                              previewLoadingPattern ===
                                "interleaved-8-channel"
                                ? "with-route"
                                : ""
                            }`}
                            role="rowheader"
                          >
                            <span>
                              {formatWellId(row, 0).replace(/\d+$/, "")}
                            </span>
                            {activePlate.rows === 16 &&
                              previewLoadingPattern ===
                                "interleaved-8-channel" && (
                                <span
                                  className={`row-route-marker ${
                                    row % 2 === 0
                                      ? "pass-one"
                                      : "pass-two"
                                  }`}
                                  title={
                                    row % 2 === 0
                                      ? tr("第 1 次上样", "Pass 1")
                                      : tr("第 2 次上样", "Pass 2")
                                  }
                                  aria-label={
                                    row % 2 === 0
                                      ? tr("第 1 次上样", "Pass 1")
                                      : tr("第 2 次上样", "Pass 2")
                                  }
                                >
                                  {row % 2 === 0 ? "①" : "②"}
                                </span>
                              )}
                          </span>
                          {activePlate.wells
                            .filter((well) => well.row === row)
                            .sort((left, right) => left.column - right.column)
                            .map((well) => {
                              const empty = !well.sample || !well.gene;
                              const manual = well.source === "manual";
                              const bridge = Boolean(well.isBridge);
                              const selected = selectedWellIds.includes(
                                well.wellId,
                              );
                              const blank = Boolean(
                                well.sample && blankSampleSet.has(well.sample),
                              );
                              const wellClass = [
                                "well",
                                well.geneType === "reference"
                                  ? "well-reference"
                                  : "",
                                empty ? "well-empty" : "",
                                blank ? "well-blank" : "",
                                bridge ? "well-bridge" : "",
                                manual ? "well-manual" : "",
                                selected ? "well-selected" : "",
                              ]
                                .filter(Boolean)
                                .join(" ");
                              const description = empty
                                ? tr(
                                    `${well.wellId}，空孔${
                                      manual ? "，手动修改" : ""
                                    }`,
                                    `${well.wellId}, empty${
                                      manual ? ", manually edited" : ""
                                    }`,
                                  )
                                : tr(
                                    `${well.wellId}，${
                                      blank ? "Blank" : "样本"
                                    } ${well.sample}，基因 ${well.gene}，${
                                      well.geneType === "reference"
                                        ? "内参"
                                        : "目的基因"
                                    }，复孔 ${well.replicateIndex ?? "—"}${
                                      manual ? "，手动修改" : ""
                                    }${bridge ? "，桥接样本" : ""}`,
                                    `${well.wellId}, ${
                                      blank ? "Blank" : "sample"
                                    } ${well.sample}, assay ${well.gene}, ${
                                      well.geneType === "reference"
                                        ? "reference"
                                        : "target"
                                    }, replicate ${well.replicateIndex ?? "—"}${
                                      manual ? ", manually edited" : ""
                                    }${bridge ? ", bridge sample" : ""}`,
                                  );
                              return (
                                <button
                                  id={`plate-${activePlate.plateNumber}-well-${well.row}-${well.column}`}
                                  className={wellClass}
                                  style={wellVisual(well, targetGenes)}
                                  type="button"
                                  role="gridcell"
                                  data-well-id={well.wellId}
                                  key={well.wellId}
                                  title={description}
                                  aria-label={description}
                                  disabled={activePlateConfirmed || settingsStale}
                                  onClick={(event) =>
                                    handleWellSelection(
                                      event,
                                      activePlateIndex,
                                      activePlate,
                                      well,
                                    )
                                  }
                                  onDoubleClick={() => {
                                    runPlateEdit({
                                      type: "select",
                                      plateNumber: activePlate.plateNumber,
                                      wellIds: [well.wellId],
                                      mode: "replace",
                                      anchorWellId: well.wellId,
                                    });
                                    openEditorForSelection(
                                      activePlateIndex,
                                      activePlate,
                                      [well.wellId],
                                    );
                                  }}
                                  onKeyDown={(event) =>
                                    moveWellFocus(
                                      event,
                                      activePlate,
                                      well.row,
                                      well.column,
                                    )
                                  }
                                >
                                  {manual && (
                                    <span
                                      className="manual-marker"
                                      aria-hidden="true"
                                    />
                                  )}
                                  {bridge && !empty && (
                                    <span
                                      className="bridge-marker"
                                      aria-hidden="true"
                                    >
                                      B
                                    </span>
                                  )}
                                  {!empty && (
                                    <span>
                                      <span className="well-label">
                                        {shortLabel(
                                          well.sample ?? "",
                                          activePlate.rows === 16 ? 4 : 7,
                                        )}
                                      </span>
                                      <span className="well-sub">
                                        {shortLabel(well.gene ?? "", 7)}
                                      </span>
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                        </Fragment>
                      ))}
                    </div>
                  </div>

                  <div
                    className={`validation-bar ${
                      activeInvalid
                        ? "invalid"
                        : activeIssues.length > 0
                          ? "warning"
                          : ""
                    }`}
                    role="status"
                  >
                    {activeInvalid || activeIssues.length > 0 ? (
                      <AlertTriangle size={15} />
                    ) : (
                      <Check size={15} />
                    )}
                    <div>
                      {settingsStale ? (
                        <strong>
                          {tr(
                            "实验设置已变更，请重新生成布局。",
                            "Settings changed; regenerate the layout.",
                          )}
                        </strong>
                      ) : activeIssues.length > 0 ? (
                        <>
                          <strong>
                            {tr(
                              `当前有 ${activeIssues.length} 项布局提醒；不会限制确认、保存或导出。`,
                              `${activeIssues.length} layout advisory item(s); confirmation, saving, and export remain available.`,
                            )}
                          </strong>
                          <ul className="validation-list">
                            {activeIssues.slice(0, 3).map((issue, index) => (
                              <li key={`${issue.code}-${index}`}>
                                {localizeMessage(issue.message)}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <strong>
                          {tr(
                            "自动布局核查通过；仍请在上机前人工确认。",
                            "Automatic layout checks passed; verify the plate before the run.",
                          )}
                        </strong>
                      )}
                    </div>
                  </div>
                  </section>
                  <ReactionCalculator
                    layout={layout}
                    samples={samples.filter((sample) => sample.name.trim())}
                    genes={completeGenes.map((gene) => ({
                      name: gene.name,
                      role: gene.role,
                    }))}
                    value={reactionSystem}
                    language={language}
                    onChange={(nextValue) => {
                      setReactionSystem(nextValue);
                      markChanged();
                    }}
                  />
                </div>
              )}

              <div className="method-note">
                <Info size={16} />
                <div>
                  <strong>{tr("特别说明", "Special note")}</strong>
                  {tr(
                    "手动调整可能打破推荐的复孔或内参结构；系统会显示提醒，但不限制保存、确认或导出。请在上机前按本地 SOP 人工核对。NTC、no-RT、阳性模板和板间校准样本不会自动添加。",
                    "Manual edits may break the recommended replicate or reference structure. The planner shows advisory messages without blocking save, confirmation, or export. Verify the final plate against the local SOP before the run. NTC, no-RT, positive-template controls, and inter-plate calibrators are not added automatically.",
                  )}
                </div>
              </div>
            </>
          )}

          <div className="footer-note">
            <span>
              {tr(
                "仅供科研使用（RUO）· 请核对本地 SOP",
                "Research use only (RUO) · Verify against the local SOP",
              )}
            </span>
            <span>
              {tr(
                "浏览器本地处理 · 不上传样本名称",
                "Processed in the browser · Sample names are not uploaded",
              )}
            </span>
          </div>
        </main>
      </div>

      {editor && layout && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setEditor(null);
          }}
        >
          <section
            className="edit-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-title"
          >
            <div className="modal-heading">
              <div>
                <h2 className="modal-title" id="edit-title">
                  {tr(
                    `编辑所选 ${editor.wellIds.length} 个孔`,
                    `Edit ${editor.wellIds.length} selected well(s)`,
                  )}
                </h2>
                <p className="modal-description">
                  {tr(
                    "只修改当前选中的孔，并用紫色轮廓标记。",
                    "Only the selected wells are changed and marked with a purple outline.",
                  )}
                </p>
              </div>
              <button
                className="icon-button modal-close"
                type="button"
                onClick={() => setEditor(null)}
                aria-label={tr("关闭编辑", "Close editor")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-form">
              <div className="field">
                <span className="field-label">
                  {tr("孔位状态", "Well status")}
                </span>
                <div className="segmented">
                  <button
                    className={editor.mode === "assay" ? "active" : ""}
                    type="button"
                    onClick={() =>
                      setEditor((current) =>
                        current ? { ...current, mode: "assay" } : current,
                      )
                    }
                  >
                    {tr("检测孔", "Assay")}
                  </button>
                  <button
                    className={editor.mode === "empty" ? "active" : ""}
                    type="button"
                    onClick={() =>
                      setEditor((current) =>
                        current ? { ...current, mode: "empty" } : current,
                      )
                    }
                  >
                    {tr("空孔", "Empty")}
                  </button>
                </div>
              </div>
              {editor.mode === "assay" && (
                <>
                  <label className="field">
                    <span className="field-label">
                      {tr("样本", "Sample")}
                    </span>
                    <select
                      className="select"
                      value={editor.sample}
                      onChange={(event) =>
                        setEditor((current) =>
                          current
                            ? { ...current, sample: event.target.value }
                            : current,
                        )
                      }
                    >
                      {samples
                        .filter((sample) => sample.name.trim())
                        .map((sample) => (
                          <option value={sample.name} key={sample.id}>
                            {sample.name}
                            {sample.kind === "blank" ? " · Blank" : ""}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">
                      {tr("基因", "Assay")}
                    </span>
                    <select
                      className="select"
                      value={editor.gene}
                      onChange={(event) =>
                        setEditor((current) =>
                          current
                            ? { ...current, gene: event.target.value }
                            : current,
                        )
                      }
                    >
                      {completeGenes.map((gene) => (
                        <option value={gene.name} key={gene.id}>
                          {gene.name} ·{" "}
                          {gene.role === "reference"
                            ? tr("内参", "Reference")
                            : tr("目的", "Target")}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <div className="notice">
                <Layers3 size={15} />
                <span>
                  {tr(
                    "手动修改可自由保存和导出。若出现内参缺失、重复或遗漏，系统只显示提醒，请自行核对。",
                    "Manual edits can be saved and exported freely. Missing references, duplicates, or omissions are shown as advisory messages for review.",
                  )}
                </span>
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setEditor(null)}
              >
                {tr("取消", "Cancel")}
              </button>
              <button
                className={
                  editor.mode === "empty"
                    ? "button button-danger"
                    : "button button-primary"
                }
                type="button"
                onClick={applyManualEdit}
              >
                {editor.mode === "empty" && <Trash2 size={14} />}
                {editor.mode === "empty"
                  ? tr("清空所选孔", "Clear selected")
                  : tr("应用修改", "Apply")}
              </button>
            </div>
          </section>
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.tone}`} role="status">
          {toast.tone === "success" ? (
            <Check size={15} />
          ) : toast.tone === "error" ? (
            <AlertTriangle size={15} />
          ) : (
            <Info size={15} />
          )}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}
