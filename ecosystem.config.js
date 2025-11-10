module.exports = {
  apps: [
    {
      name: 'swap-api',
      script: 'dist/index.js',
      args: '--monitor false',
      cwd: '/root/swap-api',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
        PORT: 5551
      },
      error_file: '/root/swap-api/logs/swap-api-error.log',
      out_file: '/root/swap-api/logs/swap-api-out.log',
      log_file: '/root/swap-api/logs/swap-api-combined.log',
      time: true
    }
  ]
};