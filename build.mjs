// 零开发服务器构建：把 src/main.ts 打成单个 IIFE app.js，
// index.html 直接 file:// 双击即可运行（不走 ES module 的 CORS 限制）。
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'app.js',
  format: 'iife',
  target: ['es2020'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching src/ ...');
} else {
  await esbuild.build(options);
  console.log('built app.js');
}
