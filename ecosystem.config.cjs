module.exports = {
  apps: [{
    name: "mini-mart",
    script: "build/index.js",
    cwd: "/Users/minmac.serv/server/mini_cp_server",
    interpreter: "node",
    env: {
      NODE_ENV: "production",
    },
    max_memory_restart: "256M",
    error_file: "/Users/minmac.serv/server/logs/mini-mart/pm2.err.log",
    out_file: "/Users/minmac.serv/server/logs/mini-mart/pm2.out.log",
  }],
};
