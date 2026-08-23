import {
  restorePlannerSession,
  serializePlannerSession,
  type PlannerSession,
  type RestorePlannerSessionOptions,
  type RestorePlannerSessionResult,
} from "./plannerSession";

// This is a stable browser slot identifier, not the payload schema version.
// Keep it unchanged so payload migrations can read drafts saved by older builds.
const PLANNER_DRAFT_STORAGE_KEY = "qpcr-plate-planner:v1";

export interface PlannerDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadPlannerDraft(
  storage: PlannerDraftStorage,
  options: RestorePlannerSessionOptions = {},
): RestorePlannerSessionResult | null {
  const serialized = storage.getItem(PLANNER_DRAFT_STORAGE_KEY);
  return serialized ? restorePlannerSession(serialized, options) : null;
}

export function savePlannerDraft(
  storage: PlannerDraftStorage,
  session: PlannerSession,
) {
  storage.setItem(PLANNER_DRAFT_STORAGE_KEY, serializePlannerSession(session));
}

export function clearPlannerDraft(storage: PlannerDraftStorage) {
  storage.removeItem(PLANNER_DRAFT_STORAGE_KEY);
}
