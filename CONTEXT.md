# qPCR Plate Planning

This context describes a qPCR experiment from assay and sample inputs through generated plate layouts, manual correction, reagent requirements, and export.

## Language

**Plate Plan**:
The complete generated set of qPCR plates and wells for one experiment, including the rules and derived quantities needed to review and export it.
_Avoid_: Layout data, plate state

**Plate Editing Session**:
The editable state of a Plate Plan, including the current well selection, clipboard, movement intent, and undo/redo history. View preferences and user-facing messages are not part of this concept.
_Avoid_: Manual layout helpers, editor state

**Generated Baseline**:
The unchanged Plate Plan produced by automatic planning and used as the source of truth when selected wells or a complete plate are restored.
_Avoid_: Original layout, backup layout

**Manual Well**:
A well whose assignment or empty state was explicitly changed within a Plate Editing Session. It remains manual until restored from the Generated Baseline.
_Avoid_: Custom hole, edited cell

**Manual Well Patch**:
The smallest reversible change recorded for manual editing: only the affected well assignments and plate names, together with their before and after values. Derived counts and validation results are recalculated rather than stored in the patch.
_Avoid_: Full plan snapshot, backup plate

**Planner Session**:
One in-progress qPCR planning workspace, including the experiment setup, current Plate Editing Session, reaction setup, language preference, and layout generation provenance. Transient view controls are not part of it.
_Avoid_: App state, stored state, planner payload

**Saved Planner Draft**:
The durable projection of a Planner Session that preserves the experiment setup, current Plate Plan, Generated Baseline, confirmations, reaction setup, and generation provenance. Well selection, clipboard contents, movement intent, and undo/redo history are intentionally not durable.
_Avoid_: Full session snapshot, localStorage state
