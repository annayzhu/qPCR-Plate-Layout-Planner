import { plannerSessionIsStale, plannerSessionReactionCalculation, type PlannerSession } from './plannerSession';
export function plannerWorkflowOutput(session: PlannerSession) {
    const plan = session.plateEditing?.plan;
    if (!plan || plannerSessionIsStale(session))
        throw new Error('请先更新排布');
    const calculation = plannerSessionReactionCalculation(session);
    if (!calculation.valid)
        throw new Error(calculation.errors[0]);
    const system = session.reactionSystem;
    const number = (value: number) => String(Math.round(value * 1000) / 1000);
    const headers = ['基因', '实际反应数', '其中空白孔', '预混液 / µL', 'Master mix / µL', 'F primer / µL', 'R primer / µL', 'Water / µL'];
    const rows = calculation.geneRequirements.map(g => [g.gene, String(g.wellCount), String(g.blankWellCount), number(g.mixExcludingCdnaUl), number(g.masterMixUl), number(g.forwardPrimerUl), number(g.reversePrimerUl), number(g.waterUl)]);
    const method = `全部 ${plan.plates.length} 板 · ${calculation.totalWells} 反应 · 每反应 ${system.totalPerWellUl} µL · 余量 ${system.overagePercent}%（已计入备液量）；模板单独加入，每孔 ${system.cdnaPerWellUl} µL。`;
    const perWell = [['组分', '每反应 / µL'], ...calculation.perWellRows.map(row => [row.key, number(row.volumeUl)])];
    const templates = [['样本', '实际反应数', '模板备液 / µL', '空白替代水 / µL'], ...calculation.sampleRequirements.map(row => [row.sample, String(row.wellCount), number(row.recommendedCdnaUl), number(row.replacementWaterUl)])];
    const mixTsv = [method, perWell.map(row => row.join('\t')).join('\n'), [headers, ...rows].map(row => row.join('\t')).join('\n'), templates.map(row => row.join('\t')).join('\n')].join('\n\n');
    const zh = session.language !== 'en';
    const sampleIds = new Map(session.setup.samples.map(sample => [sample.name, sample.id]));
    // The host keeps a sample link only for samples it knows; the rest stay as names.
    const plates = plan.plates.map(plate => ({
        id: `plate-${plate.plateNumber}`, name: plate.name.slice(0, 80), plateSize: plate.rows * plate.columns,
        fields: [{ id: 'sample', name: zh ? '样本' : 'Sample' }, { id: 'gene', name: zh ? '基因' : 'Target' }, { id: 'replicate', name: zh ? '复孔' : 'Replicate' }],
        colorField: 'gene',
        wells: Object.fromEntries(plate.wells.filter(well => well.sample && well.gene).map(well => {
            const label = (well.sample as string).slice(0, 200), sampleId = sampleIds.get(well.sample as string);
            return [well.wellId, { sample: sampleId ? { sampleId: sampleId.slice(0, 64), label } : label, gene: (well.gene as string).slice(0, 200), ...(well.replicateIndex ? { replicate: String(well.replicateIndex) } : {}) }];
        })),
    }));
    const fullTable = { headers: ['板', '孔位', '样本', '基因', '复孔'], rows: plan.plates.flatMap(plate => plate.wells.filter(well => well.sample).map(well => [plate.name, well.wellId, well.sample ?? '', well.gene ?? '', String(well.replicateIndex ?? '')])) };
    return { label: '板布局与配液', images: [], plates, fullTable, table: { headers, rows }, method, mixTsv };
}
