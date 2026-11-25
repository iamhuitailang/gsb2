#!/usr/bin/env node
/*
 * 地牢编辑器命令行工具（零依赖，Node >= 18）
 *
 * 用法：
 *   node bin/dungeon.js generate --rules examples/rules/small-dungeon.json --seed 42 [--out map.json] [--budget 20000]
 *   node bin/dungeon.js check-rules --rules <rules.json>
 *   node bin/dungeon.js validate --rules <rules.json> --map <map.json> [--locked-reference <map.json>]
 *   node bin/dungeon.js batch --rules <rules.json> --seeds 1..50 [--json]
 *
 * 退出码：0 成功/校验通过；2 生成失败或校验有错误；1 用法/文件错误。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const rulesMod = require('../src/core/rules');
const genMod = require('../src/core/generator');
const validatorMod = require('../src/core/validator');
const projectMod = require('../src/core/project');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(t);
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseSeedRange(spec) {
  // 支持 "1..50"、"a,b,c"、单值
  const seeds = [];
  for (const part of String(spec).split(',')) {
    const m = part.match(/^(-?\d+)\.\.(-?\d+)$/);
    if (m) {
      for (let i = Number(m[1]); i <= Number(m[2]); i++) seeds.push(String(i));
    } else {
      seeds.push(part.trim());
    }
  }
  return seeds;
}

function printConflicts(conflicts) {
  console.error(`生成失败，共 ${conflicts.length} 类冲突条件（按出现次数排序）：`);
  for (const c of conflicts) {
    console.error(`  [${c.code}] x${c.count}  ${c.message}`);
    if (c.detail) console.error(`      detail: ${JSON.stringify(c.detail)}`);
  }
}

function cmdGenerate(args) {
  const rules = readJson(args.rules);
  const seed = args.seed === undefined ? 'default' : String(args.seed);
  const locked = args.locked ? readJson(args.locked) : null;
  const result = genMod.generate(rules, seed, {
    budget: args.budget ? Number(args.budget) : undefined,
    lockedRooms: locked ? locked.rooms.filter((r) => r.locked) : undefined,
  });
  if (!result.ok) {
    printConflicts(result.conflicts);
    if (args.out) fs.writeFileSync(args.out, JSON.stringify({ ok: false, conflicts: result.conflicts, partialMap: result.partialMap }, null, 2));
    return 2;
  }
  const report = validatorMod.validate(result.map, rules);
  const out = result.map;
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    ok: true,
    seed,
    out: args.out ? path.resolve(args.out) : undefined,
    stats: projectMod.mapStats(rules, out),
    validation: { ok: report.ok, errors: report.errors.length, warnings: report.warnings.length },
  }, null, 2));
  if (result.warnings?.length) {
    for (const w of result.warnings) console.error(`[规则警告] ${w.message}`);
  }
  return report.ok ? 0 : 2;
}

function cmdCheckRules(args) {
  const rules = readJson(args.rules);
  const issues = rulesMod.validateRules(rules);
  if (!issues.length) {
    console.log('规则静态检查通过，无问题。');
    return 0;
  }
  let hasError = false;
  for (const i of issues) {
    if (i.severity === 'warning') console.log(`[警告][${i.code}] ${i.message}`);
    else {
      hasError = true;
      console.error(`[错误][${i.code}] ${i.message}`);
    }
  }
  return hasError ? 2 : 0;
}

function cmdValidate(args) {
  const rules = readJson(args.rules);
  const map = readJson(args.map);
  const ref = args['locked-reference'] ? readJson(args['locked-reference']) : null;
  const report = validatorMod.validate(map, rules, ref);
  for (const i of report.issues) {
    const line = `[${i.severity === 'error' ? '错误' : '警告'}][${i.code}] ${i.message}`;
    if (i.severity === 'error') console.error(line);
    else console.log(line);
  }
  console.log(report.ok
    ? `校验通过（${report.warnings.length} 条警告）`
    : `校验失败：${report.errors.length} 个错误，${report.warnings.length} 条警告`);
  return report.ok ? 0 : 2;
}

function cmdBatch(args) {
  const rules = readJson(args.rules);
  const seeds = parseSeedRange(args.seeds || '1..20');
  const rows = [];
  for (const seed of seeds) {
    const result = genMod.generate(rules, seed, { budget: args.budget ? Number(args.budget) : undefined });
    if (result.ok) {
      const report = validatorMod.validate(result.map, rules);
      rows.push({
        seed,
        ok: true,
        valid: report.ok,
        rooms: result.map.rooms.length,
        errors: report.errors.length,
        warnings: report.warnings.length,
        orphanPorts: projectMod.mapStats(rules, result.map).orphanPorts,
      });
    } else {
      rows.push({ seed, ok: false, topConflict: result.conflicts[0]?.code || 'UNKNOWN', conflictCount: result.conflicts.length });
    }
  }
  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log('seed'.padEnd(10), '结果'.padEnd(8), '校验'.padEnd(8), '房间'.padEnd(6), '错误'.padEnd(6), '警告'.padEnd(6), '孤立门'.padEnd(6), '主要冲突');
    for (const r of rows) {
      console.log(
        String(r.seed).padEnd(10),
        (r.ok ? '成功' : '失败').padEnd(8),
        (r.ok ? (r.valid ? '通过' : '不通过') : '-').padEnd(8),
        String(r.rooms ?? '-').padEnd(6),
        String(r.errors ?? '-').padEnd(6),
        String(r.warnings ?? '-').padEnd(6),
        String(r.orphanPorts ?? '-').padEnd(6),
        r.topConflict || ''
      );
    }
    const okCount = rows.filter((r) => r.ok).length;
    console.log(`\n合计 ${rows.length} 个种子：成功 ${okCount}，失败 ${rows.length - okCount}`);
  }
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    if (cmd === 'generate') process.exit(cmdGenerate(args));
    if (cmd === 'check-rules') process.exit(cmdCheckRules(args));
    if (cmd === 'validate') process.exit(cmdValidate(args));
    if (cmd === 'batch') process.exit(cmdBatch(args));
    console.error('用法: node bin/dungeon.js <generate|check-rules|validate|batch> [选项]');
    process.exit(1);
  } catch (err) {
    console.error('错误: ' + err.message);
    process.exit(1);
  }
}

main();
