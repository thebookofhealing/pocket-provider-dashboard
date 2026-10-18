#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pocket-node24-sqlite-"));
const dbPath = path.join(tempDir, "smoke.sqlite");

try {
  const first = new Database(dbPath);
  first.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  const insert = first.prepare("INSERT INTO smoke (value) VALUES (?)");
  const insertTransaction = first.transaction((values) => {
    for (const value of values) insert.run(value);
  });
  insertTransaction(["first", "second"]);
  assert.equal(first.prepare("SELECT COUNT(*) AS count FROM smoke").get().count, 2);
  first.close();

  const reopened = new Database(dbPath);
  assert.deepEqual(
    reopened.prepare("SELECT value FROM smoke ORDER BY id").all(),
    [{ value: "first" }, { value: "second" }],
  );
  reopened.close();
  console.log("better-sqlite3 Node 24 native smoke test passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
