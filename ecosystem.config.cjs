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
      restart_delay: 1000,
      kill_timeout: 10000,
      time: true,
      env: {
        NODE_ENV: "production",
        POCKET_DB_READONLY: "true",
      },
    },
    {
      name: "pocket-indexer",
      cwd,
      script: "npm",
      args: "run indexer",
      autorestart: true,
      restart_delay: 2000,
      kill_timeout: 15000,
      time: true,
      env: {
        NODE_ENV: "production",
        POCKET_DB_READONLY: "false",
      },
    },
  ],
};
