// Excel and CSV exporters for prompt lists.
import ExcelJS from 'exceljs';
import { INTENTS } from '@promptgen/engine';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2A44' } };

function styleHeader(sheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER_FILL;
  row.height = 20;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

const PROMPT_COLUMNS = [
  { header: '#', key: 'n', width: 6 },
  { header: 'Prompt', key: 'text', width: 70 },
  { header: 'Keyword', key: 'keyword', width: 26 },
  { header: 'Category', key: 'category', width: 14 },
  { header: 'Intent', key: 'intent', width: 15 },
  { header: 'Sentiment', key: 'sentiment', width: 12 },
  { header: 'Quality score', key: 'score', width: 13 },
  { header: 'Grade', key: 'grade', width: 8 },
  { header: 'Flags', key: 'flags', width: 24 },
  { header: 'Topic', key: 'topic', width: 20 },
  { header: 'Location', key: 'location', width: 16 },
  { header: 'Language', key: 'language', width: 12 },
  { header: 'Source', key: 'source', width: 10 },
];

const flat = (p, i) => ({ n: i + 1, ...p, flags: (p.flags || []).join(', ') });

export async function buildWorkbook({ run, prompts }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Prompt Generation Engine';
  wb.created = new Date();
  const s = run?.settings || {};

  const ps = wb.addWorksheet('Prompts');
  ps.columns = PROMPT_COLUMNS;
  prompts.forEach((p, i) => ps.addRow(flat(p, i)));
  styleHeader(ps);
  ps.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: PROMPT_COLUMNS.length } };
  ps.getColumn('text').alignment = { wrapText: true, vertical: 'top' };
  ps.getColumn('score').eachCell((cell, rowNo) => {
    if (rowNo === 1 || typeof cell.value !== 'number') return;
    const argb = cell.value >= 85 ? 'FFD3F9D8' : cell.value >= 70 ? 'FFE7F5FF' : cell.value >= 50 ? 'FFFFF3BF' : 'FFFFE3E3';
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  });

  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ header: 'Group', key: 'g', width: 18 }, { header: 'Value', key: 'v', width: 34 }, { header: 'Prompts', key: 'c', width: 10 }, { header: 'Avg score', key: 'a', width: 11 }];
  const groupBy = (field) => {
    const m = new Map();
    for (const p of prompts) {
      const k = p[field] || '(none)';
      const e = m.get(k) || { c: 0, t: 0 };
      e.c++; e.t += p.score || 0;
      m.set(k, e);
    }
    return [...m].sort((a, b) => b[1].c - a[1].c);
  };
  const avg = prompts.length ? Math.round(prompts.reduce((a, p) => a + (p.score || 0), 0) / prompts.length) : 0;
  sum.addRow({ g: 'Total', v: '', c: prompts.length, a: avg });
  for (const field of ['category', 'intent', 'sentiment', 'grade', 'language', 'keyword']) {
    for (const [v, e] of groupBy(field)) sum.addRow({ g: field[0].toUpperCase() + field.slice(1), v, c: e.c, a: Math.round(e.t / e.c) });
  }
  styleHeader(sum);

  const st = wb.addWorksheet('Settings');
  st.columns = [{ header: 'Setting', key: 'k', width: 24 }, { header: 'Value', key: 'v', width: 90 }];
  const b = s.brand || {};
  [
    ['Run name', run?.name],
    ['Exported at', new Date().toISOString()],
    ['Brand', b.name], ['Brand website', b.website], ['Brand aliases', b.aliases?.join(', ')], ['Competitors', b.competitors?.join(', ')],
    ['Brand mode', s.brandMode === 'mixed' ? `mixed (${s.brandedRatio}% branded)` : s.brandMode],
    ['Intents', (s.intents?.length ? s.intents : Object.keys(INTENTS)).join(', ')],
    ['Sentiment', s.sentiment], ['Topic', s.topic], ['Context', s.context], ['Instruction', s.instruction],
    ['Location', s.location], ['Languages', (s.languages?.length ? s.languages : [s.language]).filter(Boolean).join(', ')], ['Prompts per keyword', s.promptsPerKeyword],
    ['Min quality score', s.minQualityScore], ['Keywords', (run?.keywords || s.keywords || []).length],
    ['Provider / model', run?.provider ? `${run.provider} / ${run.model}` : ''],
    ['LLM calls / tokens', run?.usage ? `${run.usage.calls} calls · ${run.usage.inputTokens} in / ${run.usage.outputTokens} out` : ''],
  ].forEach(([k, v]) => st.addRow({ k, v: v ?? '' }));
  st.getColumn('v').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(st);

  const p = run?.profile;
  if (p) {
    const bp = wb.addWorksheet('Brand profile');
    bp.columns = [{ header: 'Field', key: 'k', width: 18 }, { header: 'Value', key: 'v', width: 90 }];
    [['Name', p.name], ['Industry', p.industry], ['Description', p.description], ['Offerings', p.offerings?.join(', ')],
      ['Audience', p.audience?.join(', ')], ['Location', p.location], ['Competitors', p.competitors?.join(', ')],
      ['Suggested keywords', p.keywords?.join(', ')], ['Source', p.source]]
      .forEach(([k, v]) => bp.addRow({ k, v: v ?? '' }));
    bp.getColumn('v').alignment = { wrapText: true, vertical: 'top' };
    styleHeader(bp);
  }
  return wb;
}

const csvCell = (v) => {
  const s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function toCsv(prompts) {
  const cols = PROMPT_COLUMNS.filter((c) => c.key !== 'n');
  return [cols.map((c) => csvCell(c.header)).join(','), ...prompts.map((p) => cols.map((c) => csvCell(p[c.key])).join(','))].join('\r\n');
}

export const fileName = (name, ext) => `${String(name || 'prompts').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'prompts'}.${ext}`;
