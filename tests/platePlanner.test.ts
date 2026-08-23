import assert from "node:assert/strict";
import test from "node:test";
import {
  INTERLEAVED_384_ROW_ORDER,
  PlatePlannerError,
  planPlateLayout,
  refreshPlanDerivedData,
  validateLayout,
} from "../lib/platePlanner";

test("96-well layout avoids splitting samples when it is unnecessary", () => {
  const input = {
    plateType: 96 as const,
    samples: Array.from({ length: 10 }, (_, index) => `S${index + 1}`),
    targetGenes: ["G1", "G2", "G3"],
    referenceGenes: ["GAPDH"],
    replicates: 3,
  };
  const result = planPlateLayout(input, { strategy: "sample-major" });
  assert.equal(result.plates.length, 2);
  assert.equal(result.metrics.usedWells, 120);
  assert.equal(result.metrics.emptyWells, 72);
  assert.equal(result.metrics.splitSamples, 0);
  assert.equal(result.metrics.repeatedReferenceWells, 0);
  assert.deepEqual(result.plates[0].sampleNames, [
    "S1",
    "S2",
    "S3",
    "S4",
    "S5",
    "S6",
    "S7",
    "S8",
  ]);
  assert.equal(validateLayout(result, input).valid, true);
});

test("replicate groups run left-to-right and never wrap a row", () => {
  const input = {
    plateType: 96 as const,
    samples: ["S1", "S2"],
    targetGenes: ["G1", "G2"],
    referenceGenes: ["R1"],
    replicates: 5,
  };
  const result = planPlateLayout(input, { strategy: "sample-major" });
  for (const plate of result.plates) {
    const grouped = new Map<string, typeof plate.wells>();
    for (const well of plate.wells.filter((item) => item.sample && item.gene)) {
      const key = `${well.sample}-${well.gene}`;
      grouped.set(key, [...(grouped.get(key) ?? []), well]);
    }
    for (const wells of grouped.values()) {
      assert.equal(new Set(wells.map((well) => well.row)).size, 1);
      const columns = wells.map((well) => well.column).sort((a, b) => a - b);
      assert.deepEqual(
        columns,
        Array.from({ length: 5 }, (_, index) => columns[0] + index),
      );
    }
  }
});

test("places sample-major replicate blocks top-to-bottom before moving right", () => {
  const input = {
    plateType: 96 as const,
    samples: ["S1", "S2"],
    targetGenes: ["G1", "G2"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input, { strategy: "sample-major" });
  const plate = result.plates[0];
  const occupiedBlocks = plate.wells
    .filter((well) => well.replicateIndex === 1)
    .sort(
      (left, right) =>
        Math.floor(left.column / input.replicates) -
          Math.floor(right.column / input.replicates) ||
        left.row - right.row,
    )
    .map((well) => `${well.wellId}:${well.sample}/${well.gene}`);

  assert.equal(result.strategy, "sample-major");
  assert.deepEqual(occupiedBlocks, [
    "A1:S1/R1",
    "B1:S1/G1",
    "C1:S1/G2",
    "D1:S2/R1",
    "E1:S2/G1",
    "F1:S2/G2",
  ]);

  const refreshed = refreshPlanDerivedData(result, input);
  assert.equal(refreshed.metrics.sampleSwitches, 1);
  assert.equal(refreshed.metrics.primerSwitches, 5);
});

test("supports horizontal-first filling while keeping replicate blocks contiguous", () => {
  const input = {
    plateType: 96 as const,
    samples: ["S1", "S2"],
    targetGenes: ["G1", "G2"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input, {
    strategy: "sample-major",
    fillDirection: "horizontal",
  });
  const plate = result.plates[0];
  const occupiedBlocks = plate.wells
    .filter((well) => well.replicateIndex === 1)
    .sort(
      (left, right) =>
        left.row - right.row ||
        Math.floor(left.column / input.replicates) -
          Math.floor(right.column / input.replicates),
    )
    .map((well) => `${well.wellId}:${well.sample}/${well.gene}`);

  assert.equal(result.fillDirection, "horizontal");
  assert.deepEqual(occupiedBlocks, [
    "A1:S1/R1",
    "A4:S1/G1",
    "A7:S1/G2",
    "A10:S2/R1",
    "B1:S2/G1",
    "B4:S2/G2",
  ]);
  assert.equal(validateLayout(result, input).valid, true);
});

test("places gene-major blocks by assay while preserving sample order", () => {
  const input = {
    plateType: 96 as const,
    samples: ["S1", "S2"],
    targetGenes: ["G1", "G2"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input, { strategy: "gene-major" });
  const plate = result.plates[0];
  const occupiedBlocks = plate.wells
    .filter((well) => well.replicateIndex === 1)
    .sort(
      (left, right) =>
        Math.floor(left.column / input.replicates) -
          Math.floor(right.column / input.replicates) ||
        left.row - right.row,
    )
    .map((well) => `${well.wellId}:${well.sample}/${well.gene}`);

  assert.equal(result.strategy, "gene-major");
  assert.deepEqual(occupiedBlocks, [
    "A1:S1/R1",
    "B1:S2/R1",
    "C1:S1/G1",
    "D1:S2/G1",
    "E1:S1/G2",
    "F1:S2/G2",
  ]);

  const refreshed = refreshPlanDerivedData(result, input);
  assert.equal(refreshed.metrics.sampleSwitches, 5);
  assert.equal(refreshed.metrics.primerSwitches, 2);
});

test("96-well layouts normalize the 384-only interleaved option to sequential", () => {
  const input = {
    plateType: 96 as const,
    samples: ["S1", "S2"],
    targetGenes: ["G1", "G2"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const sequential = planPlateLayout(input, {
    strategy: "gene-major",
    loadingPattern: "sequential",
  });
  const requestedInterleaved = planPlateLayout(input, {
    strategy: "gene-major",
    loadingPattern: "interleaved-8-channel",
  });

  assert.equal(requestedInterleaved.loadingPattern, "sequential");
  assert.deepEqual(requestedInterleaved, sequential);
});

test("384-well sequential loading retains natural A-to-P row traversal", () => {
  const input = {
    plateType: 384 as const,
    samples: ["S1", "S2"],
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input, {
    strategy: "gene-major",
    loadingPattern: "sequential",
  });
  const firstReplicates = result.plates[0].wells
    .filter((well) => well.replicateIndex === 1)
    .sort((left, right) => left.row - right.row)
    .map((well) => `${well.wellId}:${well.sample}/${well.gene}`);

  assert.equal(result.loadingPattern, "sequential");
  assert.deepEqual(firstReplicates, [
    "A1:S1/R1",
    "B1:S2/R1",
    "C1:S1/G1",
    "D1:S2/G1",
  ]);
  assert.equal(validateLayout(result, input).valid, true);
});

test("384-well planning defaults to the interleaved assay-major workflow", () => {
  const result = planPlateLayout({
    plateType: 384,
    samples: ["S1", "S2"],
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  });

  assert.equal(result.loadingPattern, "interleaved-8-channel");
  assert.equal(result.strategy, "gene-major");
  assert.equal(
    result.plates[0].wells.find(
      (well) =>
        well.sample === "S2" &&
        well.gene === "R1" &&
        well.replicateIndex === 1,
    )?.wellId,
    "C1",
  );
});

test("384-well interleaved horizontal-first fills across block columns first", () => {
  const input = {
    plateType: 384 as const,
    samples: ["S1", "S2", "S3", "S4"],
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input, {
    strategy: "gene-major",
    loadingPattern: "interleaved-8-channel",
    fillDirection: "horizontal",
  });
  const plate = result.plates[0];
  const occupiedBlocks = plate.wells
    .filter((well) => well.replicateIndex === 1)
    .sort(
      (left, right) =>
        left.row - right.row ||
        Math.floor(left.column / input.replicates) -
          Math.floor(right.column / input.replicates),
    )
    .map((well) => `${well.wellId}:${well.sample}/${well.gene}`);

  assert.equal(result.loadingPattern, "interleaved-8-channel");
  assert.equal(result.fillDirection, "horizontal");
  assert.deepEqual(occupiedBlocks, [
    "A1:S1/R1",
    "A4:S2/R1",
    "A7:S3/R1",
    "A10:S4/R1",
    "A13:S1/G1",
    "A16:S2/G1",
    "A19:S3/G1",
    "A22:S4/G1",
  ]);
  assert.equal(validateLayout(result, input).valid, true);
});

test("384-well interleaved gene layout follows both 8-channel passes and starts each assay in a new column block", () => {
  const samples = Array.from(
    { length: 16 },
    (_, index) => `S${index + 1}`,
  );
  const input = {
    plateType: 384 as const,
    samples,
    targetGenes: ["G1", "G2"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input, {
    strategy: "gene-major",
    loadingPattern: "interleaved-8-channel",
  });
  const plate = result.plates[0];
  const expectedRows = [
    0, 2, 4, 6, 8, 10, 12, 14, 1, 3, 5, 7, 9, 11, 13, 15,
  ];

  assert.equal(result.loadingPattern, "interleaved-8-channel");
  for (const [gene, startColumn] of [
    ["R1", 0],
    ["G1", 3],
    ["G2", 6],
  ] as const) {
    const firstReplicates = samples.map((sample) => {
      const well = plate.wells.find(
        (item) =>
          item.sample === sample &&
          item.gene === gene &&
          item.replicateIndex === 1,
      );
      assert.ok(well);
      return well;
    });
    assert.deepEqual(
      firstReplicates.map((well) => well.row),
      expectedRows,
    );
    assert.deepEqual(
      firstReplicates.map((well) => well.column),
      Array(samples.length).fill(startColumn),
    );
  }
  assert.equal(validateLayout(result, input).valid, true);
});

test("384-well interleaved gene capacity includes structural 16-row padding", () => {
  const input = {
    plateType: 384 as const,
    samples: Array.from(
      { length: 20 },
      (_, index) => `S${index + 1}`,
    ),
    targetGenes: ["G1", "G2", "G3", "G4"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input, {
    strategy: "gene-major",
    loadingPattern: "interleaved-8-channel",
  });

  assert.equal(result.plates.length, 2);
  assert.deepEqual(
    result.plates.map((plate) => plate.sampleNames.length),
    [16, 4],
  );
  assert.equal(result.metrics.splitSamples, 0);
  assert.equal(result.metrics.usedWells, 300);
  assert.equal(result.metrics.emptyWells, 468);
  assert.equal(result.metrics.structuralEmptyWells, 468);
  assert.ok(
    result.plates.every((plate) =>
      plate.wells
        .filter((well) => well.sample && well.gene)
        .every((well) => well.column < 24),
    ),
  );
  assert.equal(validateLayout(result, input).valid, true);
});

test("384-well interleaved gene splits rerun every reference on each involved plate", () => {
  const input = {
    plateType: 384 as const,
    samples: ["S1"],
    targetGenes: Array.from(
      { length: 10 },
      (_, index) => `G${index + 1}`,
    ),
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input, {
    strategy: "gene-major",
    loadingPattern: "interleaved-8-channel",
  });

  assert.equal(result.plates.length, 2);
  assert.equal(result.metrics.splitSamples, 1);
  assert.equal(result.metrics.repeatedReferenceBlocks, 1);
  assert.equal(result.metrics.repeatedReferenceWells, 3);
  assert.equal(result.metrics.usedWells, 36);
  for (const plate of result.plates) {
    assert.equal(
      plate.wells.filter(
        (well) => well.sample === "S1" && well.gene === "R1",
      ).length,
      3,
    );
  }
  assert.equal(validateLayout(result, input).valid, true);
});

test("384-well interleaved layouts preserve every global sample slot across assays and plates", () => {
  const samples = Array.from(
    { length: 17 },
    (_, index) => `S${index + 1}`,
  );
  const input = {
    plateType: 384 as const,
    samples,
    targetGenes: Array.from(
      { length: 8 },
      (_, index) => `G${index + 1}`,
    ),
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input, {
    strategy: "gene-major",
    loadingPattern: "interleaved-8-channel",
  });

  samples.forEach((sample, globalIndex) => {
    const expectedRow =
      INTERLEAVED_384_ROW_ORDER[globalIndex % 16];
    const firstReplicates = result.plates.flatMap((plate) =>
      plate.wells.filter(
        (well) =>
          well.sample === sample && well.replicateIndex === 1,
      ),
    );
    assert.ok(firstReplicates.length > 0);
    assert.deepEqual(
      new Set(firstReplicates.map((well) => well.row)),
      new Set([expectedRow]),
    );

    const targetPlateNumbers = result.plates
      .filter((plate) =>
        plate.wells.some(
          (well) =>
            well.sample === sample && well.geneType === "target",
        ),
      )
      .map((plate) => plate.plateNumber);
    assert.ok(targetPlateNumbers.length > 1);
  });
  assert.equal(validateLayout(result, input).valid, true);
});

test("384-well interleaved global-slot invariant survives deterministic fuzz cases", () => {
  let state = 0x3848cafe;
  const nextInteger = (maximum: number) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % maximum;
  };

  for (let caseIndex = 0; caseIndex < 24; caseIndex += 1) {
    const sampleCount = 1 + nextInteger(40);
    const targetCount = 1 + nextInteger(12);
    const referenceCount = 1 + nextInteger(2);
    const replicates = 1 + nextInteger(6);
    const samples = Array.from(
      { length: sampleCount },
      (_, index) => `C${caseIndex + 1}_S${index + 1}`,
    );
    const input = {
      plateType: 384 as const,
      samples,
      targetGenes: Array.from(
        { length: targetCount },
        (_, index) => `T${index + 1}`,
      ),
      referenceGenes: Array.from(
        { length: referenceCount },
        (_, index) => `R${index + 1}`,
      ),
      replicates,
    };
    const result = planPlateLayout(input, {
      strategy: "gene-major",
      loadingPattern: "interleaved-8-channel",
    });

    assert.equal(validateLayout(result, input).valid, true);
    samples.forEach((sample, globalIndex) => {
      const expectedRow =
        INTERLEAVED_384_ROW_ORDER[globalIndex % 16];
      const assignedRows = result.plates.flatMap((plate) =>
        plate.wells
          .filter(
            (well) =>
              well.sample === sample && well.replicateIndex === 1,
          )
          .map((well) => well.row),
      );
      assert.ok(assignedRows.length > 0);
      assert.ok(assignedRows.every((row) => row === expectedRow));
    });
  }
});

test("sample and gene presets keep the same plate and reference requirements", () => {
  const input = {
    plateType: 96 as const,
    samples: Array.from({ length: 10 }, (_, index) => `S${index + 1}`),
    targetGenes: ["G1", "G2", "G3"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const sampleMajor = planPlateLayout(input, {
    strategy: "sample-major",
  });
  const geneMajor = planPlateLayout(input, {
    strategy: "gene-major",
  });

  assert.equal(sampleMajor.strategy, "sample-major");
  assert.equal(geneMajor.strategy, "gene-major");
  assert.equal(geneMajor.metrics.plateCount, sampleMajor.metrics.plateCount);
  assert.equal(geneMajor.metrics.usedWells, sampleMajor.metrics.usedWells);
  assert.equal(
    geneMajor.metrics.repeatedReferenceWells,
    sampleMajor.metrics.repeatedReferenceWells,
  );
  assert.equal(validateLayout(sampleMajor, input).valid, true);
  assert.equal(validateLayout(geneMajor, input).valid, true);
});

test("fills a 96-well plate exactly for 8 samples, 4 genes, triplicates", () => {
  const result = planPlateLayout({
    plateType: 96,
    samples: Array.from({ length: 8 }, (_, index) => `S${index + 1}`),
    targetGenes: ["G1", "G2", "G3"],
    referenceGenes: ["R1"],
    replicates: 3,
  });
  assert.equal(result.plates.length, 1);
  assert.equal(result.metrics.usedWells, 96);
  assert.equal(result.metrics.emptyWells, 0);
});

test("supports multiple reference genes", () => {
  const input = {
    plateType: 384 as const,
    samples: ["A", "B", "C"],
    targetGenes: ["FBN2"],
    referenceGenes: ["TBP", "HPRT1", "RPLP0"],
    replicates: 2,
  };
  const result = planPlateLayout(input);
  const audit = validateLayout(result, input);
  assert.equal(audit.valid, true);
  for (const sample of input.samples) {
    for (const reference of input.referenceGenes) {
      assert.equal(
        result.plates[0].wells.filter(
          (well) => well.sample === sample && well.gene === reference,
        ).length,
        2,
      );
    }
  }
});

test("rejects a replicate group wider than one row", () => {
  assert.throws(
    () =>
      planPlateLayout({
        plateType: 96,
        samples: ["S1"],
        targetGenes: ["G1"],
        referenceGenes: ["R1"],
        replicates: 13,
      }),
    (error) =>
      error instanceof PlatePlannerError &&
      error.code === "E_REPLICATE_WIDER_THAN_ROW",
  );
});

test("splits one sample's target genes and repeats all references on the next plate", () => {
  const input = {
    plateType: 96 as const,
    samples: ["S1"],
    targetGenes: Array.from({ length: 31 }, (_, index) => `G${index + 1}`),
    referenceGenes: ["R1", "R2"],
    replicates: 3,
  };
  const result = planPlateLayout(input);
  assert.equal(result.plates.length, 2);
  assert.equal(result.metrics.splitSamples, 1);
  assert.equal(result.metrics.repeatedReferenceBlocks, 2);
  assert.equal(result.metrics.repeatedReferenceWells, 6);
  assert.equal(result.metrics.usedWells, 105);
  for (const plate of result.plates) {
    for (const reference of input.referenceGenes) {
      assert.equal(
        plate.wells.filter(
          (well) => well.sample === "S1" && well.gene === reference,
        ).length,
        input.replicates,
      );
    }
  }
  assert.equal(validateLayout(result, input).valid, true);
});

test("uses two plates by splitting a sample and rerunning its reference", () => {
  const input = {
    plateType: 96 as const,
    samples: ["S1", "S2", "S3"],
    targetGenes: Array.from({ length: 16 }, (_, index) => `G${index + 1}`),
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input);
  assert.equal(result.plates.length, 2);
  assert.equal(result.metrics.splitSamples, 1);
  assert.equal(result.metrics.repeatedReferenceBlocks, 1);
  assert.equal(result.metrics.usedWells, 156);

  const splitSample = input.samples.find(
    (sample) =>
      result.plates.filter((plate) =>
        plate.wells.some(
          (well) => well.sample === sample && well.geneType === "target",
        ),
      ).length === 2,
  );
  assert.ok(splitSample);
  for (const plate of result.plates) {
    if (
      plate.wells.some(
        (well) =>
          well.sample === splitSample && well.geneType === "target",
      )
    ) {
      assert.equal(
        plate.wells.filter(
          (well) => well.sample === splitSample && well.gene === "R1",
        ).length,
        input.replicates,
      );
    }
  }
  assert.equal(validateLayout(result, input).valid, true);
});

test("minimizes reference reruns within the same three-plate solution", () => {
  const input = {
    plateType: 96 as const,
    samples: ["S1", "S2", "S3", "S4"],
    targetGenes: Array.from({ length: 16 }, (_, index) => `G${index + 1}`),
    referenceGenes: ["R1", "R2"],
    replicates: 3,
  };
  const result = planPlateLayout(input);
  assert.equal(result.plates.length, 3);
  assert.equal(result.metrics.samplePlateAppearances, 5);
  assert.equal(result.metrics.splitSamples, 1);
  assert.equal(result.metrics.repeatedReferenceBlocks, 2);
  assert.equal(result.metrics.repeatedReferenceWells, 6);
  assert.equal(validateLayout(result, input).valid, true);
});

test("keeps every feasible comparison-group assay unit on one plate even when that adds a plate", () => {
  const samples = Array.from({ length: 15 }, (_, index) => `S${index + 1}`);
  const input = {
    plateType: 96 as const,
    samples,
    sampleDesigns: samples.map((name, index) => ({
      name,
      cellLine: `Cell-${Math.floor(index / 5) + 1}`,
      comparisonGroup: "Treatment",
    })),
    targetGenes: ["G1", "G2", "G3"],
    referenceGenes: ["R1"],
    replicates: 3,
  };

  const legacy = planPlateLayout({ ...input, sampleDesigns: undefined });
  const grouped = planPlateLayout(input);

  assert.equal(legacy.plates.length, 2);
  assert.equal(grouped.plates.length, 3);
  for (const cellLine of ["Cell-1", "Cell-2", "Cell-3"]) {
    const groupSamples = input.sampleDesigns
      .filter((sample) => sample.cellLine === cellLine)
      .map((sample) => sample.name);
    for (const gene of input.targetGenes) {
      const plateNumbers = grouped.plates
        .filter((plate) =>
          plate.wells.some(
            (well) =>
              well.gene === gene &&
              well.geneType === "target" &&
              groupSamples.includes(well.sample ?? ""),
          ),
        )
        .map((plate) => plate.plateNumber);
      assert.equal(new Set(plateNumbers).size, 1);
    }
  }
  assert.equal(validateLayout(grouped, input).valid, true);
});

test("rejects an oversized comparison unit until an explicit bridge sample is selected", () => {
  const samples = Array.from({ length: 17 }, (_, index) => `S${index + 1}`);
  const baseInput = {
    plateType: 96 as const,
    samples,
    sampleDesigns: samples.map((name) => ({
      name,
      cellLine: "A549",
      comparisonGroup: "FBN2 knockdown",
    })),
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  };

  assert.throws(
    () => planPlateLayout(baseInput),
    (error) =>
      error instanceof PlatePlannerError &&
      error.code === "E_COMPARISON_UNIT_TOO_LARGE",
  );

  const input = {
    ...baseInput,
    sampleDesigns: baseInput.sampleDesigns.map((sample, index) => ({
      ...sample,
      isBridge: index === 0,
    })),
  };
  const result = planPlateLayout(input);
  assert.equal(result.plates.length, 2);
  for (const plate of result.plates) {
    assert.equal(
      plate.wells.filter(
        (well) => well.sample === "S1" && well.gene === "G1",
      ).length,
      3,
    );
    assert.equal(
      plate.wells.filter(
        (well) => well.sample === "S1" && well.gene === "R1",
      ).length,
      3,
    );
  }
  assert.equal(validateLayout(result, input).valid, true);
});

test("rejects ambiguous comparison metadata and bridge assignments", () => {
  const common = {
    plateType: 96 as const,
    samples: ["S1"],
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  assert.throws(
    () =>
      planPlateLayout({
        ...common,
        sampleDesigns: [{ name: "S1", comparisonGroup: "KD" }],
      }),
    (error) =>
      error instanceof PlatePlannerError &&
      error.code === "E_COMPARISON_GROUP_REQUIRES_CELL_LINE",
  );
  assert.throws(
    () =>
      planPlateLayout({
        ...common,
        sampleDesigns: [{ name: "S1", isBridge: true }],
      }),
    (error) =>
      error instanceof PlatePlannerError &&
      error.code === "E_BRIDGE_REQUIRES_COMPARISON_GROUP",
  );
  assert.throws(
    () =>
      planPlateLayout({
        ...common,
        sampleDesigns: [
          { name: "S1", kind: "blank" as const, cellLine: "A549" },
        ],
      }),
    (error) =>
      error instanceof PlatePlannerError &&
      error.code === "E_BLANK_COMPARISON_METADATA",
  );
});

test("comparison units remain intact in both 384-well loading patterns", () => {
  const samples = Array.from({ length: 70 }, (_, index) => `S${index + 1}`);
  const input = {
    plateType: 384 as const,
    samples,
    sampleDesigns: samples.map((name, index) => ({
      name,
      cellLine: `Cell-${Math.floor(index / 10) + 1}`,
      comparisonGroup: "Control-vs-treatment",
    })),
    targetGenes: ["G1", "G2", "G3", "G4"],
    referenceGenes: ["R1"],
    replicates: 3,
  };

  for (const loadingPattern of [
    "sequential",
    "interleaved-8-channel",
  ] as const) {
    const result = planPlateLayout(input, {
      strategy: "gene-major",
      loadingPattern,
    });
    assert.ok(result.plates.length > 1);
    for (let group = 1; group <= 7; group += 1) {
      const groupSamples = samples.slice((group - 1) * 10, group * 10);
      for (const gene of input.targetGenes) {
        const plates = result.plates.filter((plate) =>
          plate.wells.some(
            (well) =>
              well.gene === gene && groupSamples.includes(well.sample ?? ""),
          ),
        );
        assert.equal(plates.length, 1);
      }
    }
    assert.equal(validateLayout(result, input).valid, true);
  }
});

test("validation catches a missing same-plate reference block", () => {
  const input = {
    plateType: 96 as const,
    samples: ["S1"],
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input);
  result.plates[0].wells = result.plates[0].wells.map((well) =>
    well.gene === "R1"
      ? {
          ...well,
          sample: null,
          gene: null,
          geneType: null,
          replicateIndex: null,
          source: "manual" as const,
        }
      : well,
  );
  const audit = validateLayout(result, input);
  assert.equal(audit.valid, false);
  assert.ok(
    audit.errors.some((issue) => issue.code === "E_REFERENCE_COHERENCE"),
  );
});

test("validation catches a gene role mismatch", () => {
  const input = {
    plateType: 96 as const,
    samples: ["S1"],
    targetGenes: ["G1"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input);
  result.plates[0].wells = result.plates[0].wells.map((well) =>
    well.gene === "R1"
      ? { ...well, geneType: "target" as const, source: "manual" as const }
      : well,
  );
  const audit = validateLayout(result, input);
  assert.equal(audit.valid, false);
  assert.ok(
    audit.errors.some((issue) => issue.code === "E_GENE_TYPE_MISMATCH"),
  );
});

test("validation reports a completely removed target assay as a global error", () => {
  const input = {
    plateType: 96 as const,
    samples: ["S1"],
    targetGenes: ["G1", "G2"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input);
  result.plates[0].wells = result.plates[0].wells.map((well) =>
    well.sample === "S1" && well.gene === "G2"
      ? {
          ...well,
          sample: null,
          gene: null,
          geneType: null,
          replicateIndex: null,
          source: "manual" as const,
        }
      : well,
  );
  const audit = validateLayout(result, input);
  const missing = audit.errors.find(
    (issue) => issue.code === "E_REQUIRED_ASSAY_MISSING",
  );
  assert.equal(audit.valid, false);
  assert.equal(missing?.plateNumber, undefined);
});

test("validation rejects duplicate plate names case-insensitively", () => {
  const input = {
    plateType: 96 as const,
    samples: Array.from({ length: 10 }, (_, index) => `S${index + 1}`),
    targetGenes: ["G1", "G2", "G3"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  const result = planPlateLayout(input);
  assert.equal(result.plates.length, 2);
  result.plates[0].name = "Run A";
  result.plates[1].name = "  run a  ";

  const audit = validateLayout(result, input);
  assert.equal(audit.valid, false);
  assert.ok(
    audit.errors.some(
      (issue) => issue.code === "E_DUPLICATE_PLATE_NAME",
    ),
  );
});

test("layout is deterministic", () => {
  const input = {
    plateType: 96 as const,
    samples: ["S1", "S2", "S3", "S4"],
    targetGenes: ["G1", "G2"],
    referenceGenes: ["R1"],
    replicates: 3,
  };
  assert.deepEqual(planPlateLayout(input), planPlateLayout(input));
});
