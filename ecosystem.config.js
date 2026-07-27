module.exports = {
  apps: [
    {
      name: "sports-card-backend",
      script: "index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "customdev",
      },
    },
  ],
};