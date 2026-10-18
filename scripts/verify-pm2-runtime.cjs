#!/usr/bin/env node

const { execFileSync } = require("node:child_process");

const expectedMajor = Number(process.argv[2] || 24);
const names = process.argv.slice(3);

if (!Number.isInteger(expectedMajor) || expectedMajor < 1 || names.length === 0) {
  console.error("usage: verify-pm2-runtime.cjs <expected-major> <pm2-name> [...]");
  process.exit(2);
}

const rows = execFileSync("ps", ["-eo", "pid=,ppid=,comm=,args="], { encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), comm: match[3], args: match[4] } : null;
  })
  .filter(Boolean);

function descendants(rootPid) {
  const root = rows.find((row) => row.pid === rootPid);
  const result = root ? [root] : [];
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const row of rows) {
      if (row.ppid === parent && !result.some((item) => item.pid === row.pid)) {
        result.push(row);
        queue.push(row.pid);
      }
    }
  }
  return result;
}

for (const name of names) {
  const pidText = execFileSync("pm2", ["pid", name], { encoding: "utf8" }).trim().split(/\s+/)[0];
  const rootPid = Number(pidText);
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    throw new Error(`PM2 process ${name} has no valid pid`);
  }

  const candidates = descendants(rootPid).filter(
    (row) => row.comm === "node" || /(?:^|\/)node(?:\s|$)/.test(row.args),
  );
  if (candidates.length === 0) {
    throw new Error(`PM2 process ${name} has no Node.js child process`);
  }

  const versions = candidates.map((row) => {
    const executable = execFileSync("readlink", ["-f", `/proc/${row.pid}/exe`], { encoding: "utf8" }).trim();
    const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
    return { pid: row.pid, executable, version };
  });

  for (const candidate of versions) {
    const major = Number(candidate.version.match(/^v(\d+)/)?.[1]);
    if (major !== expectedMajor) {
      throw new Error(`PM2 process ${name} is not running Node ${expectedMajor}.x: ${JSON.stringify(candidate)}`);
    }
  }
  console.log(`PM2 ${name}: ${versions.map((item) => `${item.version} (${item.executable})`).join(", ")}`);
}
