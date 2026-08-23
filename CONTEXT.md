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
