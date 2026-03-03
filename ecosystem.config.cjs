module.exports = {
  apps: [{
    name: "sewon-ops-mcp",
    script: "build/index.js",
    cwd: "/Users/minmac.serv/server/sewon-ops-mcp",
    interpreter: "node",
    env: {
      NODE_ENV: "production",
    },
    max_memory_restart: "256M",
    error_file: "/Users/minmac.serv/server/logs/sewon-ops-mcp/pm2.err.log",
    out_file: "/Users/minmac.serv/server/logs/sewon-ops-mcp/pm2.out.log",
  }],
};
