import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync(new URL("./", import.meta.url))
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => new URL(f, import.meta.url).pathname);

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file.split("/").pop()} ===`);
  const result = spawnSync(process.execPath, ["--test", file], { stdio: "inherit" });
  if (result.status !== 0) failed += 1;
}
process.exit(failed ? 1 : 0);
