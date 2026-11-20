// 重新生成演示数据的入口：node scripts/seed.js
import { seedDemoData } from '../lib/seed.js';
import * as store from '../lib/store.js';

store.load();
const result = await seedDemoData();
console.log('演示数据已重置并生成：', result);
