// pm2 start ecosystem.config.js  (após npm run build)
module.exports = {
  apps: [
    {
      name: "whatsapp-backend",
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      env: { NODE_ENV: "production" },
    },
  ],
};
