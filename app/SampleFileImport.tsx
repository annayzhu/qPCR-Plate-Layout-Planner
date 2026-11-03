import { useState } from 'react';
import XLSX from 'xlsx-js-style';
export function SampleFileImport({ onImport }: {
    onImport: (names: string[]) => void;
}) {
    const [rows, setRows] = useState<string[][]>([]), [column, setColumn] = useState(0), [header, setHeader] = useState(true), [error, setError] = useState('');
    const names = rows.slice(header ? 1 : 0).map(row => row[column]?.trim()).filter(Boolean);
    return <details className="workflow-sample-file"><summary>从文件导入样本</summary><input type="file" accept=".csv,.tsv,.txt,.xlsx" aria-label="样本名单文件" onChange={async (event) => { const file = event.target.files?.[0]; if (!file)
        return; try {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        setRows(XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' }).map(row => row.map(String)));
        setColumn(0);
        setError('');
    }
    catch {
        setError('文件无法读取，请选择 CSV、TSV 或 XLSX');
    } }}/>{rows.length ? <><label><input type="checkbox" checked={header} onChange={event => setHeader(event.target.checked)}/>第一行为标题</label><label>样本名称列<select value={column} onChange={event => setColumn(Number(event.target.value))}>{rows[0].map((name, index) => <option key={index} value={index}>{index + 1} · {name}</option>)}</select></label><p>{names.length} 个样本 · {names.slice(0, 3).join('、')}</p><button type="button" className="button button-soft" disabled={!names.length} onClick={() => { onImport(names); setRows([]); }}>载入样本名称</button></> : null}{error ? <p role="alert">{error}</p> : null}</details>;
}
