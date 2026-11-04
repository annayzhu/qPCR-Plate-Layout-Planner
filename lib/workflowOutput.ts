import { plannerSessionIsStale, plannerSessionReactionCalculation, type PlannerSession } from './plannerSession';
const escapeXml = (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
type OutputPlate = NonNullable<NonNullable<PlannerSession['plateEditing']>['plan']>['plates'][number];
// Same colours as the plate in the planner.
const REFERENCE_FILL = '#f3dfc4';
const TARGET_FILLS = ['#dde8f2', '#dcebe8', '#e4e2ef', '#dce7f0', '#e1e9e3', '#e3e5ec'];
const labelUnits = (value: string) => Array.from(value).reduce((total, character) => total + (character.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
/** Names on a plate usually differ at the end, so a long one keeps both ends; the attached well table has it in full. */
function clip(value: string, units: number) {
    if (labelUnits(value) <= units)
        return value;
    const characters = Array.from(value);
    let head = '', tail = '', room = units - 1;
    while (characters.length) {
        const next = tail.length < head.length ? characters.at(-1)! : characters[0];
        const cost = labelUnits(next);
        if (cost > room)
            break;
        room -= cost;
        if (tail.length < head.length) {
            tail = next + tail;
            characters.pop();
        }
        else {
            head += next;
            characters.shift();
        }
    }
    return `${head}…${tail}`;
}
/** A printable, self-contained plate figure: wells carry sample and assay, colours follow the assay. */
function plateFigure(plate: OutputPlate) {
    const dense = plate.columns > 12;
    const cellW = dense ? 30 : 56, cellH = dense ? 22 : 42, left = 28, top = 44;
    const width = left + plate.columns * cellW + 8;
    const genes = [...new Set(plate.wells.filter(well => well.sample && well.gene).map(well => well.gene as string))];
    const targets = genes.filter(gene => !plate.wells.some(well => well.gene === gene && well.geneType === 'reference'));
    const fill = (gene: string) => targets.includes(gene) ? TARGET_FILLS[targets.indexOf(gene) % TARGET_FILLS.length] : REFERENCE_FILL;
    const legendTop = top + plate.rows * cellH + 18;
    let legendX = left;
    let legendY = legendTop;
    const legend = genes.map(gene => {
        const label = clip(gene, 16), itemWidth = 22 + Array.from(label).length * 8 + 14;
        if (legendX + itemWidth > width) {
            legendX = left;
            legendY += 18;
        }
        const item = `<rect x="${legendX}" y="${legendY - 10}" width="12" height="12" rx="2" fill="${fill(gene)}" stroke="#a9b6b0"/><text x="${legendX + 18}" y="${legendY}" font-size="12">${escapeXml(label)}</text>`;
        legendX += itemWidth;
        return item;
    }).join('');
    const height = legendY + 10;
    const labels = Array.from({ length: plate.columns }, (_, i) => `<text x="${left + i * cellW + cellW / 2}" y="${top - 6}" text-anchor="middle" font-size="${dense ? 10 : 12}" fill="#4d5955">${i + 1}</text>`).join('')
        + Array.from({ length: plate.rows }, (_, i) => `<text x="${left - 8}" y="${top + i * cellH + cellH / 2 + 4}" text-anchor="end" font-size="${dense ? 10 : 12}" fill="#4d5955">${String.fromCharCode(65 + i)}</text>`).join('');
    const wells = plate.wells.map(well => {
        const x = left + well.column * cellW, y = top + well.row * cellH, used = Boolean(well.sample && well.gene);
        const text = used && !dense ? `<text x="${x + cellW / 2 - 1}" y="${y + 17}" text-anchor="middle" font-size="10" font-weight="600">${escapeXml(clip(well.sample as string, 9))}</text><text x="${x + cellW / 2 - 1}" y="${y + 31}" text-anchor="middle" font-size="10" fill="#4d5955">${escapeXml(clip(well.gene as string, 9))}</text>` : '';
        return `<g><title>${escapeXml(`${well.wellId}: ${well.sample ?? ''} / ${well.gene ?? ''}`)}</title><rect x="${x}" y="${y}" width="${cellW - 2}" height="${cellH - 2}" rx="3" fill="${used ? fill(well.gene as string) : '#fafbf8'}" stroke="${used ? '#a9b6b0' : '#dfe5e1'}"/>${text}</g>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial,'PingFang SC',sans-serif" font-size="12" fill="#202825"><rect width="100%" height="100%" fill="white"/><text x="${left}" y="18" font-size="13" font-weight="600">${escapeXml(plate.name)}</text>${labels}${wells}${legend}</svg>`;
}
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
    const images = plan.plates.map(plate => ({ caption: `${plate.name} · ${plate.rows * plate.columns} 孔`, svg: plateFigure(plate) }));
    const fullTable = { headers: ['板', '孔位', '样本', '基因', '复孔'], rows: plan.plates.flatMap(plate => plate.wells.filter(well => well.sample).map(well => [plate.name, well.wellId, well.sample ?? '', well.gene ?? '', String(well.replicateIndex ?? '')])) };
    return { label: '板布局与配液', images, fullTable, table: { headers, rows }, method, mixTsv };
}
