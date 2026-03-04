module.exports = {
  apps: [{
    name: "minimart",
    script: "build/index.js",
    cwd: "/Users/minmac.serv/server/minimart",
    interpreter: "node",
    env: {
      NODE_ENV: "production",
    },
    max_memory_restart: "256M",
    error_file: "/Users/minmac.serv/server/logs/minimart/pm2.err.log",
    out_file: "/Users/minmac.serv/server/logs/minimart/pm2.out.log",
  }],
};
