/*
 * parser.js — 文本点云解析器(纯逻辑,无 DOM 依赖)
 *
 * 支持格式:
 *  - XYZ / TXT: 每行 x y z [r g b] [nx ny nz],空白或逗号分隔; # 开头为注释
 *  - CSV: 逗号分隔,可含表头(含 x/y/z 列名),颜色列可名为 r/g/b、red/green/blue
 *  - PTS: 首行为点数,之后每行 x y z [intensity] [r g b]
 *  - PLY(ascii): 解析 header 中的 element vertex / property,支持 uchar/char/
 *    ushort/short/uint/int/float/double 属性
 *  - PCD(ascii): 解析 header 中的 FIELDS / SIZE / TYPE / COUNT,按字段顺序取
 *    x y z 与 rgb
 *
 * 设计原则: 坏行不致命 —— 记录行号与原因,其余有效点照常返回。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PCParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function splitLine(line) {
    // 同时支持空白分隔与逗号分隔
    return line.trim().split(/[\s,]+/).filter(function (t) { return t.length > 0; });
  }

  // 颜色归一化到 0..255;输入可能是 0..255 整数或 0..1 浮点
  function normalizeColor(channels) {
    const rgb = [0, 0, 0];
    let allFraction = true;
    for (let k = 0; k < 3; k++) {
      let v = channels[k];
      if (!isFiniteNumber(v)) v = 0;
      if (v < 0) v = 0;
      if (v > 1.0001) allFraction = false;
      rgb[k] = v;
    }
    if (allFraction) {
      for (let k = 0; k < 3; k++) rgb[k] = Math.round(rgb[k] * 255);
    } else {
      for (let k = 0; k < 3; k++) rgb[k] = Math.round(Math.min(255, rgb[k]));
    }
    return rgb;
  }

  // ---- PLY ----
  function parsePly(lines, errors) {
    let i = 0;
    let headerEnd = -1;
    let vertexCount = 0;
    const props = [];
    for (; i < lines.length; i++) {
      const t = splitLine(lines[i]);
      if (t[0] === 'end_header') { headerEnd = i; break; }
      if (t[0] === 'element' && t[1] === 'vertex') vertexCount = parseInt(t[2], 10) || 0;
      if (t[0] === 'property' && t.length >= 3) {
        props.push({ type: t[1], name: t[2] });
      }
    }
    if (headerEnd < 0) {
      errors.push({ line: 1, reason: 'PLY 缺少 end_header' });
      return { points: [], colors: null };
    }
    const idx = { x: -1, y: -1, z: -1, r: -1, g: -1, b: -1 };
    props.forEach(function (p, k) {
      if (p.name === 'x') idx.x = k;
      else if (p.name === 'y') idx.y = k;
      else if (p.name === 'z') idx.z = k;
      else if (p.name === 'red' || p.name === 'r') idx.r = k;
      else if (p.name === 'green' || p.name === 'g') idx.g = k;
      else if (p.name === 'blue' || p.name === 'b') idx.b = k;
    });
    if (idx.x < 0 || idx.y < 0 || idx.z < 0) {
      errors.push({ line: headerEnd + 1, reason: 'PLY vertex 属性中找不到 x/y/z' });
      return { points: [], colors: null };
    }
    const points = [];
    let colors = null;
    if (idx.r >= 0 && idx.g >= 0 && idx.b >= 0) colors = [];
    const end = vertexCount > 0 ? Math.min(lines.length, headerEnd + 1 + vertexCount) : lines.length;
    for (i = headerEnd + 1; i < end; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      const t = splitLine(raw);
      if (t.length < props.length) {
        errors.push({ line: i + 1, reason: '字段数不足(期望 ' + props.length + ',实际 ' + t.length + ')' });
        continue;
      }
      const nums = t.map(Number);
      if (nums.some(function (v) { return !isFiniteNumber(v); })) {
        errors.push({ line: i + 1, reason: '存在无法解析为数字的字段' });
        continue;
      }
      points.push([nums[idx.x], nums[idx.y], nums[idx.z]]);
      if (colors) colors.push(normalizeColor([nums[idx.r], nums[idx.g], nums[idx.b]]));
    }
    return { points: points, colors: colors };
  }

  // ---- PCD ----
  function parsePcd(lines, errors) {
    let dataLine = -1;
    let fields = [];
    for (let i = 0; i < lines.length; i++) {
      const t = splitLine(lines[i]);
      if (t[0] === 'FIELDS') fields = t.slice(1);
      if (t[0] === 'DATA') {
        if (t[1] !== 'ascii') {
          errors.push({ line: i + 1, reason: 'PCD 仅支持 ascii 数据,当前为 ' + t[1] });
          return { points: [], colors: null };
        }
        dataLine = i;
        break;
      }
    }
    if (dataLine < 0) {
      errors.push({ line: 1, reason: 'PCD 缺少 DATA ascii 段' });
      return { points: [], colors: null };
    }
    const ix = fields.indexOf('x'), iy = fields.indexOf('y'), iz = fields.indexOf('z');
    let ir = fields.indexOf('rgb');
    const irSep = ir >= 0 ? -1 : fields.indexOf('r');
    if (ix < 0 || iy < 0 || iz < 0) {
      errors.push({ line: 1, reason: 'PCD FIELDS 中找不到 x/y/z' });
      return { points: [], colors: null };
    }
    const points = [], colors = [];
    const packedRgb = ir >= 0;
    for (let i = dataLine + 1; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      const t = splitLine(raw);
      if (t.length < fields.length) {
        errors.push({ line: i + 1, reason: '字段数不足(期望 ' + fields.length + ',实际 ' + t.length + ')' });
        continue;
      }
      const nums = t.map(Number);
      if (!isFiniteNumber(nums[ix]) || !isFiniteNumber(nums[iy]) || !isFiniteNumber(nums[iz])) {
        errors.push({ line: i + 1, reason: 'x/y/z 不是有效数字' });
        continue;
      }
      points.push([nums[ix], nums[iy], nums[iz]]);
      if (packedRgb) {
        // PCD 常见做法: rgb 字段为打包成 float 的 0xRRGGBB 整数
        const packed = t[ir];
        const intVal = /[eE.]/.test(packed) ? null : parseInt(packed, 10);
        if (intVal !== null && Number.isFinite(intVal) && intVal > 0) {
          colors.push([(intVal >> 16) & 255, (intVal >> 8) & 255, intVal & 255]);
        } else colors.push([180, 180, 180]);
      } else if (irSep >= 0) {
        colors.push(normalizeColor([nums[irSep], nums[fields.indexOf('g')], nums[fields.indexOf('b')]]));
      }
    }
    return { points: points, colors: colors.length === points.length ? colors : null };
  }

  // 通用列布局推断: 根据每行 token 数量找最常见的模式
  function inferColumns(lines, startIndex, opts) {
    const countVotes = new Map();
    const commaVotes = { comma: 0, space: 0 };
    for (let i = startIndex; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      const n = splitLine(raw).length;
      countVotes.set(n, (countVotes.get(n) || 0) + 1);
      if (raw.includes(',')) commaVotes.comma++;
      else commaVotes.space++;
    }
    let best = 0, bestN = 0;
    countVotes.forEach(function (v, k) { if (v > best) { best = v; bestN = k; } });
    let layout;
    if (opts.pts) {
      // PTS 常见列序: x y z [intensity] [r g b]
      if (bestN >= 7) layout = { x: 0, y: 1, z: 2, r: 4, g: 5, b: 6 };
      else if (bestN >= 6) layout = { x: 0, y: 1, z: 2, r: 3, g: 4, b: 5 };
      else layout = { x: 0, y: 1, z: 2, r: -1, g: -1, b: -1 };
      return { layout: layout, columns: bestN, delimiter: 'space' };
    }
    if (bestN >= 6) layout = { x: 0, y: 1, z: 2, r: 3, g: 4, b: 5 };
    else if (bestN >= 7) layout = { x: 0, y: 1, z: 2, r: 4, g: 5, b: 6 }; // xyz nxnynz rgb
    else layout = { x: 0, y: 1, z: 2, r: -1, g: -1, b: -1 };
    // 9 列且颜色在后: xyz nx ny nz r g b
    if (bestN === 9) layout = { x: 0, y: 1, z: 2, r: 6, g: 7, b: 8 };
    return { layout: layout, columns: bestN, delimiter: commaVotes.comma > commaVotes.space ? 'comma' : 'space' };
  }

  // ---- XYZ / TXT / CSV / PTS 通用解析 ----
  function parseGeneric(lines, errors, opts) {
    opts = opts || {};
    let start = 0;
    let header = null;
    const first = lines[0] ? lines[0].trim() : '';

    // PTS: 首行单个整数 = 点数
    if (opts.pts) {
      const n0 = parseInt(first, 10);
      if (/^-?\d+$/.test(first) && Number.isFinite(n0)) start = 1;
    }

    // CSV 表头
    if (opts.csv && first && /[a-zA-Z]/.test(first) && first.split(',').some(function (h) {
      return /^(x|y|z|r|g|b|red|green|blue)$/i.test(h.trim());
    })) {
      header = first.split(',').map(function (h) { return h.trim().toLowerCase(); });
      start = 1;
    }

    let layout;
    if (header) {
      layout = {
        x: header.indexOf('x'), y: header.indexOf('y'), z: header.indexOf('z'),
        r: Math.max(header.indexOf('r'), header.indexOf('red')),
        g: Math.max(header.indexOf('g'), header.indexOf('green')),
        b: Math.max(header.indexOf('b'), header.indexOf('blue'))
      };
      if (layout.x < 0 || layout.y < 0 || layout.z < 0) {
        errors.push({ line: 1, reason: 'CSV 表头缺少 x/y/z 列' });
        return { points: [], colors: null };
      }
    } else {
      layout = inferColumns(lines, start, opts || {}).layout;
    }

    const points = [];
    const colors = (layout.r >= 0 && layout.g >= 0 && layout.b >= 0) ? [] : null;
    for (let i = start; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      const t = splitLine(raw);
      const need = Math.max(layout.x, layout.y, layout.z) + 1;
      if (t.length < need) {
        errors.push({ line: i + 1, reason: '字段数不足(至少需要 ' + need + ' 列)' });
        continue;
      }
      const x = Number(t[layout.x]), y = Number(t[layout.y]), z = Number(t[layout.z]);
      if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
        errors.push({ line: i + 1, reason: 'x/y/z 不是有效数字: "' + raw.trim().slice(0, 40) + '"' });
        continue;
      }
      points.push([x, y, z]);
      if (colors) {
        const r = Number(t[layout.r]), g = Number(t[layout.g]), b = Number(t[layout.b]);
        if (!isFiniteNumber(r) || !isFiniteNumber(g) || !isFiniteNumber(b)) {
          errors.push({ line: i + 1, reason: '颜色字段不是有效数字' });
          colors.push([180, 180, 180]);
        } else colors.push(normalizeColor([r, g, b]));
      }
    }
    return { points: points, colors: colors };
  }

  function detectFormat(text, fileName) {
    const head = text.slice(0, 4096);
    const name = (fileName || '').toLowerCase();
    if (/^ply\b/m.test(head) || name.endsWith('.ply')) return 'ply';
    if (/^#\s*PCD\b/m.test(head) || /^VERSION\b/m.test(head) || name.endsWith('.pcd')) return 'pcd';
    if (name.endsWith('.pts')) return 'pts';
    if (name.endsWith('.csv')) return 'csv';
    return 'xyz';
  }

  /**
   * 解析点云文本
   * @param {string} text 完整文件内容
   * @param {string} [fileName] 文件名(辅助格式判断)
   * @returns {{format:string, points:number[][], colors:number[][]|null,
   *            errors:Array<{line:number, reason:string}>, stats:object}}
   */
  function parse(text, fileName) {
    const format = detectFormat(text, fileName);
    const errors = [];
    // 保留行号: split 后数组下标 +1 即文件行号
    const lines = text.split(/\r\n|\r|\n/);
    let result;
    if (format === 'ply') result = parsePly(lines, errors);
    else if (format === 'pcd') result = parsePcd(lines, errors);
    else if (format === 'pts') result = parseGeneric(lines, errors, { pts: true });
    else if (format === 'csv') result = parseGeneric(lines, errors, { csv: true });
    else result = parseGeneric(lines, errors, {});

    const stats = {
      totalLines: lines.length,
      validPoints: result.points.length,
      badLines: errors.length,
      hasColor: !!result.colors
    };
    return {
      format: format,
      points: result.points,
      colors: result.colors,
      errors: errors,
      stats: stats
    };
  }

  return { parse: parse, normalizeColor: normalizeColor, detectFormat: detectFormat };
});
