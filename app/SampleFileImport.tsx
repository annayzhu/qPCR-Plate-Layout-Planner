import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import XLSX from 'xlsx-js-style';

export function SampleFileImport({ onImport, language }: {
    onImport: (names: string[]) => void;
    language: 'zh' | 'en';
}) {
    const input = useRef<HTMLInputElement>(null);
    const [rows, setRows] = useState<string[][]>([]);
    const [column, setColumn] = useState(0);
    const [header, setHeader] = useState(true);
    const [error, setError] = useState('');
    const [filename, setFilename] = useState('');
    const tr = (zh: string, en: string) => language === 'zh' ? zh : en;
    const names = rows.slice(header ? 1 : 0).map(row => row[column]?.trim()).filter(Boolean);

    return <details className="workflow-sample-file">
      <summary>{tr('从文件导入样本', 'Import samples from a file')}</summary>
      <input ref={input} type="file" hidden accept=".csv,.tsv,.txt,.xlsx" aria-label={tr('样本名单文件', 'Sample list file')} onChange={async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
            const values = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' }).map(row => row.map(String));
            setRows(values);
            setColumn(0);
            setFilename(file.name);
            setError('');
        } catch {
            setRows([]);
            setError(tr('文件无法读取，请选择 CSV、TSV 或 XLSX。', 'Unable to read the file. Choose CSV, TSV or XLSX.'));
        }
        event.target.value = '';
      }} />
      <button type="button" className="button button-soft" onClick={() => input.current?.click()}><Upload size={14} aria-hidden />{tr('选择文件', 'Choose file')}</button>
      {filename && <p className="sample-import-filename">{filename}</p>}
      {rows.length > 0 && <div className="sample-import-fields">
        <label className="sample-import-header"><input type="checkbox" checked={header} onChange={event => setHeader(event.target.checked)} />{tr('第一行为标题', 'First row is a header')}</label>
        <label>{tr('样本名称列', 'Sample name column')}<select className="select" value={column} onChange={event => setColumn(Number(event.target.value))}>{rows[0].map((name, index) => <option key={index} value={index}>{index + 1} · {name}</option>)}</select></label>
        <p className="sample-import-preview">{names.slice(0, 3).join(' · ')}</p>
        <button type="button" className="button button-soft" disabled={!names.length} onClick={() => { onImport(names); setRows([]); setFilename(''); }}>{tr(`导入 ${names.length} 个样本`, `Import ${names.length} samples`)}</button>
      </div>}
      {error && <p role="alert">{error}</p>}
    </details>;
}
