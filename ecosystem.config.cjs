module.exports = {
  apps: [
    {
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
    },
    {
      name: "minimart_express",
      script: "build/index-express.js",
      cwd: "/Users/minmac.serv/server/minimart",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        MINIMART_FILE_WORKSPACE: "/Users/minmac.serv/server/agent/ollama",
      },
      max_memory_restart: "128M",
      error_file: "/Users/minmac.serv/server/logs/minimart_express/pm2.err.log",
      out_file: "/Users/minmac.serv/server/logs/minimart_express/pm2.out.log",
    },
  ],
};
