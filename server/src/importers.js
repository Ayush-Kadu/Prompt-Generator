// Keyword import from Excel workbooks (.xlsx).
import ExcelJS from 'exceljs';
import { LIMITS } from '@promptgen/engine';

const HEADER = /^(keywords?|search terms?|terms?|quer(y|ies))$/i;
const COUNT_HEADER = /^(prompts?|prompts? (count|per keyword)|(no\.?|number) of prompts|count|qty|quantity)$/i;

/**
 * Read keywords from the first worksheet that has data. Uses the column whose
 * first-row header is "Keyword" (or similar) when there is one, otherwise the
 * first column. Returns unique keywords (case-insensitive) in sheet order.
 * When row 1 also has a "Prompts" (or "Count", "Number of prompts"…) column, its
 * whole numbers become per-keyword prompt counts, capped at the engine limit.
 * With `adjacentCounts`, a sheet without a count heading takes counts from the
 * column right after the keywords (for files that are only "keyword | prompts").
 * @param {Buffer} buffer  the .xlsx file
 * @returns {Promise<{keywords:string[], counts:Record<string,number>, total:number, truncated:boolean, sheet:string|null}>}
 */
export async function readKeywordsFromXlsx(buffer, { max = LIMITS.maxKeywords, adjacentCounts = false } = {}) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw Object.assign(new Error('Could not read that file as an Excel workbook (.xlsx).'), { status: 400 });
  }
  const sheet = wb.worksheets.find((ws) => ws.actualRowCount > 0);
  if (!sheet) return { keywords: [], counts: {}, total: 0, truncated: false, sheet: null };

  let column = 1;
  let countColumn = null;
  let startRow = 1;
  sheet.getRow(1).eachCell((cell, col) => {
    const head = String(cell.text ?? '').trim();
    if (startRow === 1 && HEADER.test(head)) {
      column = col;
      startRow = 2;
    } else if (countColumn === null && COUNT_HEADER.test(head)) {
      countColumn = col;
    }
  });
  if (startRow === 1 && countColumn !== null) startRow = 2; // a header row with only a count heading
  if (countColumn === null && adjacentCounts) countColumn = column + 1;

  const seen = new Set();
  const keywords = [];
  const counts = [];
  sheet.eachRow((row, n) => {
    if (n < startRow) return;
    const cell = row.getCell(column);
    if (cell.type === ExcelJS.ValueType.Error) return;
    const text = String(cell.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return;
    seen.add(key);
    if (keywords.length >= max) return;
    keywords.push(text);
    if (countColumn !== null) {
      const count = Number(String(row.getCell(countColumn).text ?? '').trim());
      if (Number.isInteger(count) && count >= 1) counts.push([text, Math.min(count, LIMITS.maxPerKeyword)]);
    }
  });
  // fromEntries defines own properties, so a keyword like "__proto__" stays a plain key.
  return { keywords, counts: Object.fromEntries(counts), total: seen.size, truncated: seen.size > keywords.length, sheet: sheet.name };
}
