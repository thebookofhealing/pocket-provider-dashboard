const path = require("node:path");
const persistentDbPath = process.env.POCKET_SQLITE_PATH?.trim();

if (!persistentDbPath || !path.isAbsolute(persistentDbPath)) {
  throw new Error("Set POCKET_SQLITE_PATH to an absolute persistent database path before starting PM2");
}

const sharedProductionEnv = {
  NODE_ENV: "production",
  POCKET_SQLITE_PATH: persistentDbPath,
};

module.exports = {
  apps: [
    {
      name: "pocket-dashboard",
      script: "npm",
      args: "run start",
      cwd: __dirname,
      autorestart: true,
      restart_delay: 5_000,
      min_uptime: "10s",
      max_restarts: 20,
      env: {
        ...sharedProductionEnv,
        POCKET_DB_READONLY: "true",
      },
    },
    {
      name: "pocket-indexer",
      script: "npm",
      args: "run indexer",
      cwd: __dirname,
      autorestart: true,
      restart_delay: 5_000,
      min_uptime: "10s",
      max_restarts: 50,
      kill_timeout: 15_000,
      env: {
        ...sharedProductionEnv,
        POCKET_DB_READONLY: "false",
      },
    },
  ],
};
