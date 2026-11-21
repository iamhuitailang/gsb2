import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const SelfTest = require(path.join(here, '..', 'js', 'selftest.js'));

const { results, passed, total } = SelfTest.runAll();
let failed = 0;
for (const r of results) {
  if (!r.pass) {
    failed += 1;
    console.error(`✗ ${r.name}  ${r.detail}`);
  } else {
    console.log(`✓ ${r.name}`);
  }
}
console.log(`\n${passed}/${total} 通过`);
process.exit(failed ? 1 : 0);
