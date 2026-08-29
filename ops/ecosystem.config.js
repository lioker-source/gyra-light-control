module.exports = {
  apps: [{
    name: 'atrium-light-server',
    script: '/opt/lightserver/server.js',
    cwd: '/opt/lightserver',
    autorestart: true,
    restart_delay: 3000,
    max_restarts: 100,
    time: true,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
