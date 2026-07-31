import assert from "node:assert/strict";
import test from "node:test";

import {
  detectWorkspaceDelimiter,
  parseWorkspaceDelimitedPreview,
} from "./workspace-csv-preview";

test("parses quoted CSV fields and multiline records", () => {
  const preview = parseWorkspaceDelimitedPreview(
    "report.csv",
    'name,notes,value\nAda,"hello, world",1\nGrace,"line one\nline two",2\n',
  );

  assert.equal(preview.delimiter, ",");
  assert.deepEqual(preview.rows, [
    ["name", "notes", "value"],
    ["Ada", "hello, world", "1"],
    ["Grace", "line one\nline two", "2"],
  ]);
  assert.equal(preview.columnCount, 3);
  assert.equal(preview.truncated, false);
});

test("detects TSV and semicolon-delimited exports", () => {
  assert.equal(detectWorkspaceDelimiter("report.tsv", "a\tb\n1\t2"), "\t");
  assert.equal(
    detectWorkspaceDelimiter("report.csv", "name;city;role\nAda;London;Engineer"),
    ";",
  );
});

test("bounds rows, columns, characters and oversized cells", () => {
  const preview = parseWorkspaceDelimitedPreview(
    "large.csv",
    `a,b,c\n1,${"x".repeat(20)},3\n4,5,6`,
    { maxCharacters: 50, maxRows: 2, maxColumns: 2, maxCellCharacters: 5 },
  );

  assert.deepEqual(preview.rows, [
    ["a", "b"],
    ["1", "xxxxx…"],
  ]);
  assert.equal(preview.columnCount, 2);
  assert.equal(preview.truncated, true);
});
