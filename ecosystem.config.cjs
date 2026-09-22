const path = require("node:path");
const persistentDbPath = process.env.POCKET_SQLITE_PATH?.trim();

if (!persistentDbPath || !path.isAbsolute(persistentDbPath)) {
  throw new Error("Set POCKET_SQLITE_PATH to an absolute persistent database path before starting PM2");
}

const sharedProductionEnv = {
  NODE_ENV: "production",
  POCKET_SQLITE_PATH: persistentDbPath,
};

const deployRoot = process.env.DEPLOY_ROOT || "/srv/pocket-provider-dashboard";
const cwd = `${deployRoot}/current`;

module.exports = {
  apps: [
    {
      name: "pocket-dashboard",
      cwd,
      script: "npm",
      args: "run start",
      autorestart: true,
      restart_delay: 5_000,
      min_uptime: "10s",
      max_restarts: 20,
      kill_timeout: 10000,
      time: true,
      env: {
        ...sharedProductionEnv,
        POCKET_DB_READONLY: "true",
      },
    },
    {
      name: "pocket-indexer",
      cwd,
      script: "npm",
      args: "run indexer",
      autorestart: true,
      restart_delay: 5_000,
      min_uptime: "10s",
      max_restarts: 50,
      kill_timeout: 15000,
      time: true,
      env: {
        ...sharedProductionEnv,
        POCKET_DB_READONLY: "false",
      },
    },
  ],
};
