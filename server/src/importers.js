// Keyword import from Excel workbooks (.xlsx).
import ExcelJS from 'exceljs';
import { LIMITS } from '@promptgen/engine';

const HEADER = /^(keywords?|search terms?|terms?|quer(y|ies))$/i;

/**
 * Read keywords from the first worksheet that has data. Uses the column whose
 * first-row header is "Keyword" (or similar) when there is one, otherwise the
 * first column. Returns unique keywords (case-insensitive) in sheet order.
 * @param {Buffer} buffer  the .xlsx file
 * @returns {Promise<{keywords:string[], total:number, truncated:boolean, sheet:string|null}>}
 */
export async function readKeywordsFromXlsx(buffer, { max = LIMITS.maxKeywords } = {}) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw Object.assign(new Error('Could not read that file as an Excel workbook (.xlsx).'), { status: 400 });
  }
  const sheet = wb.worksheets.find((ws) => ws.actualRowCount > 0);
  if (!sheet) return { keywords: [], total: 0, truncated: false, sheet: null };

  let column = 1;
  let startRow = 1;
  sheet.getRow(1).eachCell((cell, col) => {
    if (startRow === 1 && HEADER.test(String(cell.text ?? '').trim())) {
      column = col;
      startRow = 2;
    }
  });

  const seen = new Set();
  const keywords = [];
  sheet.eachRow((row, n) => {
    if (n < startRow) return;
    const cell = row.getCell(column);
    if (cell.type === ExcelJS.ValueType.Error) return;
    const text = String(cell.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return;
    seen.add(key);
    if (keywords.length < max) keywords.push(text);
  });
  return { keywords, total: seen.size, truncated: seen.size > keywords.length, sheet: sheet.name };
}
