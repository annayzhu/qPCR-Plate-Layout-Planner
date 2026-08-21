# Plate editor productivity

Fixed point: `c0307d74c58191c2d801f324de55bbc2b049627f`

## Requirements

1. Copy selected wells with Command/Ctrl+C and paste them from a selected destination anchor with Command/Ctrl+V. Pasting duplicates the copied relative arrangement and marks pasted occupied or empty wells as manual edits.
2. Pasted occupied wells participate immediately in all reaction and reagent requirement calculations.
3. A selected well or group of wells can be assigned a sample and assay without replicate coupling. Manual wells are visibly marked.
4. Selected manual wells can be restored individually from the generated automatic layout; whole-plate restore remains available.
5. Pointer dragging over the plate selects a rectangular range; Command/Ctrl modifies the range selection additively.
6. Plate editing controls remain reachable while the user scrolls through a large plate.
7. The plate view offers explicit zoom-out, zoom-in, and reset controls without changing plate data.

## Advisory boundary

Manual edits, including copies that overwrite occupied destinations or disrupt replicate/reference structure, remain allowed. Validation is advisory and export continues to use the current visible layout.
