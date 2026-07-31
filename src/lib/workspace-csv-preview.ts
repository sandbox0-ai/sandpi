export interface WorkspaceDelimitedPreview {
  delimiter: "," | ";" | "\t";
  rows: string[][];
  columnCount: number;
  truncated: boolean;
}

export interface WorkspaceDelimitedPreviewOptions {
  maxCharacters?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCellCharacters?: number;
}

const DEFAULT_MAX_CHARACTERS = 1_000_000;
const DEFAULT_MAX_ROWS = 1_000;
const DEFAULT_MAX_COLUMNS = 100;
const DEFAULT_MAX_CELL_CHARACTERS = 10_000;

function delimiterScore(content: string, delimiter: "," | ";" | "\t") {
  const sampleEnd = Math.min(content.length, 16_384);
  const counts: number[] = [];
  let count = 0;
  let quoted = false;
  for (let index = 0; index < sampleEnd && counts.length < 12; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === delimiter) {
      count += 1;
    } else if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      if (count > 0) counts.push(count);
      count = 0;
    }
  }
  if (count > 0) counts.push(count);
  if (counts.length === 0) return 0;
  const average = counts.reduce((sum, value) => sum + value, 0) / counts.length;
  const variance = counts.reduce(
    (sum, value) => sum + Math.abs(value - average),
    0,
  );
  return counts.length * 100 + average * 10 - variance;
}

export function detectWorkspaceDelimiter(fileName: string, content: string) {
  if (fileName.toLowerCase().endsWith(".tsv")) return "\t" as const;
  const candidates = [",", ";", "\t"] as const;
  return candidates.reduce((best, candidate) =>
    delimiterScore(content, candidate) > delimiterScore(content, best)
      ? candidate
      : best,
  );
}

export function parseWorkspaceDelimitedPreview(
  fileName: string,
  content: string,
  options: WorkspaceDelimitedPreviewOptions = {},
): WorkspaceDelimitedPreview {
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxColumns = options.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const maxCellCharacters =
    options.maxCellCharacters ?? DEFAULT_MAX_CELL_CHARACTERS;
  const delimiter = detectWorkspaceDelimiter(fileName, content);
  const scanEnd = Math.min(content.length, maxCharacters);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellTruncated = false;
  let columnsTruncated = false;
  let index = 0;

  const append = (value: string) => {
    if (cell.length >= maxCellCharacters) {
      cellTruncated = true;
      return;
    }
    const remaining = maxCellCharacters - cell.length;
    cell += value.slice(0, remaining);
    if (value.length > remaining) cellTruncated = true;
  };
  const finishCell = () => {
    if (row.length < maxColumns) {
      row.push(cellTruncated ? `${cell}…` : cell);
    } else {
      columnsTruncated = true;
    }
    cell = "";
    cellTruncated = false;
  };
  const finishRow = () => {
    finishCell();
    rows.push(row);
    row = [];
  };

  while (index < scanEnd && rows.length < maxRows) {
    const character = content[index] ?? "";
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        append('"');
        index += 2;
        continue;
      }
      if (character === '"') {
        quoted = false;
      } else {
        append(character);
      }
      index += 1;
      continue;
    }

    if (character === '"' && cell.length === 0) {
      quoted = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      finishCell();
      index += 1;
      continue;
    }
    if (character === "\n" || character === "\r") {
      finishRow();
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      index += 1;
      continue;
    }
    append(character);
    index += 1;
  }

  if (rows.length < maxRows && (cell.length > 0 || row.length > 0)) finishRow();
  return {
    delimiter,
    rows,
    columnCount: rows.reduce((maximum, candidate) =>
      Math.max(maximum, candidate.length),
    0),
    truncated: index < content.length || columnsTruncated,
  };
}
