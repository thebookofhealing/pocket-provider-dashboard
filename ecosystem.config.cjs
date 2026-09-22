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
        NODE_ENV: "production",
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
        NODE_ENV: "production",
        POCKET_DB_READONLY: "false",
      },
    },
  ],
};
