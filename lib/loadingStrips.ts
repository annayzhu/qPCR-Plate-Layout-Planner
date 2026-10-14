/** Physical source strips are independent of biological comparison groups. */
export interface LoadingStrip {
  index: number;
  group: string;
  groupStripIndex: number;
  samples: string[];
}

export function buildLoadingStrips(
  samples: string[],
  designs: { name: string; loadingGroup?: string }[] = [],
): LoadingStrip[] {
  const labels = new Map(designs.map((sample) => [sample.name, sample.loadingGroup?.trim() ?? ""]));
  const groups = new Map<string, { label: string; samples: string[] }>();
  for (const sample of samples) {
    const label = labels.get(sample) ?? "";
    const key = label.toLocaleLowerCase();
    if (!groups.has(key)) groups.set(key, { label, samples: [] });
    groups.get(key)!.samples.push(sample);
  }
  const strips: LoadingStrip[] = [];
  for (const { label, samples: members } of groups.values()) {
    for (let start = 0; start < members.length; start += 8) {
      strips.push({ index: strips.length, group: label, groupStripIndex: start / 8, samples: members.slice(start, start + 8) });
    }
  }
  return strips;
}

export function loadingStripSlots(strips: LoadingStrip[]) {
  return new Map(strips.flatMap((strip) => strip.samples.map((sample, channel) => [sample, strip.index * 8 + channel] as const)));
}

/** N walks strip lanes before moving right; Z walks right before the next lane.
 * A tile always contains eight source channels × horizontal technical replicates.
 */
export function loadingTilePosition(index: number, lanes: number, columns: number, direction: "vertical" | "horizontal") {
  return direction === "vertical"
    ? { lane: index % lanes, column: Math.floor(index / lanes) }
    : { lane: Math.floor(index / columns), column: index % columns };
}
