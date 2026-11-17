import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.DATA_FILE ?? path.join(__dirname, '..', 'data', 'db.json');

await rm(dataFile, { force: true });
console.log(`已删除 ${dataFile}，下次启动会重新生成账号与两份示例草稿。`);
