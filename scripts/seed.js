#!/usr/bin/env node
// 初始化数据（用户 + 两张工单 + 两个应用的独立凭据），可重复执行。
// 注意：会把 data/clients.json 写入本地；不会进入仓库（.gitignore）。
import path from 'node:path';
import { bootstrap } from '../src/server.js';

const dataDir = process.env.GSB_DATA_DIR || path.join(process.cwd(), 'data');
const ctx = await bootstrap({ dataDir, persist: true });
const state = ctx.store.state;

console.log('已初始化演示数据：');
console.log(`  用户：${state.users.map((u) => u.username).join(', ')}（密码 ticket-demo-pass）`);
console.log(`  工单：${state.tickets.map((t) => `${t.id} [${t.team}] ${t.title}`).join(' / ')}`);
console.log(`  应用：${state.clients.map((c) => c.clientId).join(', ')}`);
console.log(`  凭据文件：${ctx.paths.clients}`);
console.log('（凭据文件已被 .gitignore 排除，不会进入仓库。）');
