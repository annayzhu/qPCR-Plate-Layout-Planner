import { plannerSessionIsStale, plannerSessionReactionCalculation, type PlannerSession } from './plannerSession';
const escapeXml = (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
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
    const images = plan.plates.map(plate => {
        const cell = plate.columns === 24 ? 26 : 48, width = plate.columns * cell + 56, height = plate.rows * cell + 64;
        const labels = Array.from({ length: plate.columns }, (_, i) => `<text x="${46 + i * cell}" y="36" text-anchor="middle">${i + 1}</text>`).join('') + Array.from({ length: plate.rows }, (_, i) => `<text x="12" y="${57 + i * cell}">${String.fromCharCode(65 + i)}</text>`).join('');
        const wells = plate.wells.map(well => `<g><title>${escapeXml(`${well.wellId}: ${well.sample ?? ''} / ${well.gene ?? ''}`)}</title><rect x="${34 + well.column * cell}" y="${44 + well.row * cell}" width="${cell - 3}" height="${cell - 3}" rx="3" fill="${well.sample ? '#eaf1ef' : '#fafbf8'}" stroke="#cadbd6"/><text x="${46 + well.column * cell}" y="${59 + well.row * cell}" text-anchor="middle" font-size="${plate.columns === 24 ? 8 : 11}">${escapeXml(well.sample ? well.wellId : '')}</text></g>`).join('');
        return { caption: `${plate.name} · ${plate.rows * plate.columns} 孔`, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial,sans-serif" font-size="12" fill="#202825"><rect width="100%" height="100%" fill="white"/><text x="12" y="18">${escapeXml(plate.name)}</text>${labels}${wells}</svg>` };
    });
    const fullTable = { headers: ['板', '孔位', '样本', '基因', '复孔'], rows: plan.plates.flatMap(plate => plate.wells.filter(well => well.sample).map(well => [plate.name, well.wellId, well.sample ?? '', well.gene ?? '', String(well.replicateIndex ?? '')])) };
    return { label: '板布局与配液', images, fullTable, table: { headers, rows }, method, mixTsv };
}
