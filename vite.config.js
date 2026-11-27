const threePath = process.env.THREE_PATH;

/** @type {import('vite').UserConfig} */
const config = {
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
};

if (threePath) {
  config.resolve = {
    alias: [
      { find: /^three\/addons\/(.*)$/, replacement: `${threePath}/examples/jsm/$1` },
      { find: /^three\/(.*)$/, replacement: `${threePath}/$1` },
      { find: /^three$/, replacement: threePath },
    ],
  };
}

export default config;
