/* 版本化本地二进制格式（小端）。
   布局：
   头部 "MPCM" | u16 version | u32 flags | u32 seed | u16 blockCount
   每块： u16 vertexCount | u16 indexCount |
         positions: vertexCount*3 个 f32（flags 的 POS_RESTORED 位决定是原始还是还原值）
         uvs:       vertexCount*2 个 f32
         u8 indexFmt | 索引（u16 或 u32）
         u16 uvSeamCount | uvSeams (u32 a, u32 b)
   范围段： u8 mode | u8 bits | u32 crackThreshold | u16 rangeCount |
           每范围 6×f32 | u16 blockRangeId × blockCount
   接缝段： u16 seamCount
           每接缝： u16 blockA | u16 blockB | cstr name | cstr axis |
                    u16 pairCount | pair(u32 va,u32 vb, f32 x,y,z) |
                    u16 extraCount | extra(u16 block,u32 vertex, f32 z)
   尾部： u32 crc32(以上全部) | "MEND"
   位置码按 bits 紧凑位打包（8/10/12/16 均支持），存在范围段之后、接缝段之前。 */
(function (global) {
  const MPC = global.MPC;
  const { crc32, f32 } = MPC.util;

  // 小端写入后字节序即 ASCII "MPCM" / "MEND"
  const MAGIC = ('M'.charCodeAt(0)) | ('P'.charCodeAt(0) << 8) | ('C'.charCodeAt(0) << 16) | ('M'.charCodeAt(0) << 24); // 0x4d43504d
  const END_MAGIC = ('M'.charCodeAt(0)) | ('E'.charCodeAt(0) << 8) | ('N'.charCodeAt(0) << 16) | ('D'.charCodeAt(0) << 24); // 0x444e454d
  const FORMAT_VERSION = 1;
  const FLAG_POS_RESTORED = 1 << 0;
  const FLAG_PACKED_CODES = 1 << 1;

  class DecodeError extends Error {
    constructor(message, offset, partial) {
      super(message + (offset != null ? '（字节偏移 ' + offset + '）' : ''));
      this.name = 'DecodeError';
      this.offset = offset;
      this.partial = partial || null;
    }
  }

  class BitWriter {
    constructor() { this.bytes = []; this.acc = 0; this.nbits = 0; }
    write(value, bits) {
      this.acc |= (value << this.nbits) >>> 0;
      this.nbits += bits;
      while (this.nbits >= 8) { this.bytes.push(this.acc & 0xff); this.acc >>>= 8; this.nbits -= 8; }
    }
    finish() { if (this.nbits > 0) { this.bytes.push(this.acc & 0xff); this.acc = 0; this.nbits = 0; } return Uint8Array.from(this.bytes); }
  }

  class BitReader {
    constructor(u8) { this.u8 = u8; this.bytePos = 0; this.acc = 0; this.nbits = 0; }
    read(bits) {
      while (this.nbits < bits) {
        if (this.bytePos >= this.u8.length) throw new DecodeError('位置码数据被截断：还需要 ' + bits + ' 位但文件已结束', this.bytePos);
        this.acc = (this.acc | (this.u8[this.bytePos++] << this.nbits)) >>> 0;
        this.nbits += 8;
      }
      const v = this.acc & ((1 << bits) - 1);
      this.acc >>>= bits; this.nbits -= bits;
      return v >>> 0;
    }
  }

  // 可检查边界的顺序写入/读取器
  class Writer {
    constructor() { this.buf = new ArrayBuffer(256); this.dv = new DataView(this.buf); this.pos = 0; }
    ensure(n) {
      if (this.pos + n <= this.buf.byteLength) return;
      let size = this.buf.byteLength;
      while (size < this.pos + n) size *= 2;
      const nb = new ArrayBuffer(size);
      new Uint8Array(nb).set(new Uint8Array(this.buf));
      this.buf = nb; this.dv = new DataView(nb);
    }
    u8(v) { this.ensure(1); this.dv.setUint8(this.pos, v); this.pos += 1; }
    u16(v) { this.ensure(2); this.dv.setUint16(this.pos, v, true); this.pos += 2; }
    u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
    f32(v) { this.ensure(4); this.dv.setFloat32(this.pos, f32(v), true); this.pos += 4; }
    cstr(s) { const bytes = new TextEncoder().encode(s); if (bytes.length > 255) throw new Error('字符串过长'); this.u8(bytes.length); this.ensure(bytes.length); new Uint8Array(this.buf, this.pos).set(bytes); this.pos += bytes.length; }
    raw(u8arr) { this.ensure(u8arr.length); new Uint8Array(this.buf, this.pos).set(u8arr); this.pos += u8arr.length; }
    result() { return new Uint8Array(this.buf, 0, this.pos).slice(); }
  }

  class Reader {
    constructor(bytes) {
      this.bytes = bytes; this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.pos = 0; this.total = bytes.byteLength;
    }
    need(n, what) {
      if (this.pos + n > this.total) {
        throw new DecodeError('文件不完整：读取 ' + what + ' 需要 ' + n + ' 字节，只剩 ' + Math.max(0, this.total - this.pos) + ' 字节', this.pos);
      }
    }
    u8(what) { this.need(1, what); const v = this.dv.getUint8(this.pos); this.pos += 1; return v; }
    u16(what) { this.need(2, what); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
    u32(what) { this.need(4, what); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
    f32(what) { this.need(4, what); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
    cstr(what) {
      const len = this.u8(what + ' 长度');
      this.need(len, what);
      const s = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + len));
      this.pos += len; return s;
    }
  }

  function indexFmtOf(count) { return count <= 0xffff ? 16 : 32; }

  // 字节核算（不含头部/尾部的精确每段统计，供 UI 展示占用构成）
  function byteAccounting(scene, pack) {
    const bits = pack.bits;
    let blockBytes = 0, posBytes = 0, uvBytes = 0, indexBytes = 0, uvSeamBytes = 0;
    for (const b of scene.blocks) {
      const v = b.positions.length / 3;
      const pos = v * 3 * 4;
      const uv = v * 2 * 4;
      const idxFmt = indexFmtOf(b.indices.length);
      const idx = b.indices.length * (idxFmt === 16 ? 2 : 4) + 1;
      const seam = 2 + b.uvSeams.length * 8;
      const header = 4;
      posBytes += pos; uvBytes += uv; indexBytes += idx; uvSeamBytes += seam; blockBytes += header + pos + uv + idx + seam;
    }
    const totalVerts = scene.blocks.reduce((s, b) => s + b.positions.length / 3, 0);
    const codeBytes = Math.ceil(totalVerts * 3 * bits / 8);
    const rangeBytes = 1 + 1 + 4 + 2 + pack.ranges.length * 24 + 2 * scene.blocks.length;
    let seamBytes = 2;
    for (const s of scene.seams) {
      seamBytes += 2 + 2 + 1 + new TextEncoder().encode(s.name).length + 1 + new TextEncoder().encode(s.axis).length
        + 2 + s.pairs.length * (8 + 12) + 2 + s.extraVertices.length * (2 + 4 + 4);
    }
    const fixed = 4 + 2 + 4 + 4 + 2 + 4 + 4; // 头 + 尾
    const total = fixed + blockBytes + rangeBytes + codeBytes + seamBytes;
    return {
      total, blockBytes, posBytes, uvBytes, indexBytes, uvSeamBytes,
      codeBytes, rangeBytes, seamBytes, fixed,
      totalVerts,
      // 对照：位置若全部用 f32 原始存储的占用
      f32PosOnly: posBytes,
      packedVsF32: posBytes - codeBytes,
    };
  }

  function encode(scene, pack, opts) {
    opts = opts || {};
    const w = new Writer();
    const flags = (opts.storeRestored ? FLAG_POS_RESTORED : 0) | FLAG_PACKED_CODES;
    w.u32(MAGIC); w.u16(FORMAT_VERSION); w.u32(flags); w.u32(scene.seed); w.u16(scene.blocks.length);

    for (const qb of pack.qBlocks) {
      const v = qb.positions.length / 3;
      if (v > 0xffff || qb.indices.length > 0xffff) throw new Error('当前格式单块顶点/索引数上限 65535');
      w.u16(v); w.u16(qb.indices.length);
      const pos = opts.storeRestored ? qb.restored : qb.positions;
      for (let i = 0; i < pos.length; i++) w.f32(pos[i]);
      for (let i = 0; i < qb.uvs.length; i++) w.f32(qb.uvs[i]);
      const fmt = indexFmtOf(qb.indices.length);
      w.u8(fmt);
      for (const idx of qb.indices) fmt === 16 ? w.u16(idx) : w.u32(idx);
      w.u16(qb.uvSeams.length);
      for (const s of qb.uvSeams) { w.u32(s.a); w.u32(s.b); }
    }

    // 范围段
    w.u8({ global: 0, perBlock: 1, aligned: 2 }[pack.mode]);
    w.u8(pack.bits);
    w.u32(Math.round((opts.threshold ?? 0) * 1e6));
    w.u16(pack.ranges.length);
    for (const r of pack.ranges) { w.f32(r.minX); w.f32(r.minY); w.f32(r.minZ); w.f32(r.maxX); w.f32(r.maxY); w.f32(r.maxZ); }
    for (const rid of pack.blockRangeId) w.u16(rid);

    // 紧凑位打包的位置码
    const bw = new BitWriter();
    for (const qb of pack.qBlocks) {
      const v = qb.positions.length / 3;
      for (let i = 0; i < v * 3; i++) bw.write(qb.codes[i], pack.bits);
    }
    const packed = bw.finish();
    w.u32(packed.length);
    w.raw(packed);

    // 接缝段
    w.u16(scene.seams.length);
    for (const s of scene.seams) {
      w.u16(s.blockA); w.u16(s.blockB); w.cstr(s.name); w.cstr(s.axis);
      w.u16(s.pairs.length);
      for (const p of s.pairs) { w.u32(p.va); w.u32(p.vb); w.f32(p.x); w.f32(p.y); w.f32(p.z); }
      w.u16(s.extraVertices.length);
      for (const e of s.extraVertices) { w.u16(e.block); w.u32(e.vertex); w.f32(e.z); }
    }

    const body = w.result();
    const out = new Uint8Array(body.length + 8);
    out.set(body, 0);
    const dv = new DataView(out.buffer);
    dv.setUint32(body.length, crc32(body), true);
    dv.setUint32(body.length + 4, END_MAGIC, true);
    return out;
  }

  const MODE_BY_ID = ['global', 'perBlock', 'aligned'];

  function decode(u8) {
    const warnings = [];
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
    if (u8.length < 6) {
      throw new DecodeError('文件长度只有 ' + u8.length + ' 字节，连文件头（14 字节）都放不下，不是本工具导出的数据。', 0);
    }
    const rd = new Reader(u8);
    const magic = rd.u32('文件魔数');
    if (magic !== MAGIC) {
      throw new DecodeError('文件魔数不匹配（应为 "MPCM"），这不是本工具的网格打包文件，可能被改名或损坏。', 0);
    }
    const version = rd.u16('格式版本');
    if (version !== FORMAT_VERSION) {
      throw new DecodeError('不支持的格式版本 v' + version + '：本工具只支持 v' + FORMAT_VERSION +
        '。请用导出该文件的工具版本读取，或重新生成数据。', rd.pos - 2);
    }
    const flags = rd.u32('标志位');
    const seed = rd.u32('随机种子');
    const blockCount = rd.u16('块数量');
    if (blockCount === 0 || blockCount > 64) throw new DecodeError('块数量字段异常：' + blockCount, rd.pos - 2);

    const blocks = [];
    let mode, bits, thresholdU, ranges, blockRangeId, codesPerBlock, seams;
    try {
      for (let bi = 0; bi < blockCount; bi++) {
        const vCount = rd.u16('块' + bi + '顶点数');
        const iCount = rd.u16('块' + bi + '索引数');
        if (vCount === 0) throw new DecodeError('块 ' + bi + ' 顶点数为 0，数据已损坏。', rd.pos);
        const positions = new Float32Array(vCount * 3);
        for (let i = 0; i < positions.length; i++) positions[i] = rd.f32('位置');
        const uvs = new Float32Array(vCount * 2);
        for (let i = 0; i < uvs.length; i++) uvs[i] = rd.f32('UV');
        const idxFmt = rd.u8('索引格式');
        if (idxFmt !== 16 && idxFmt !== 32) throw new DecodeError('未知索引格式 ' + idxFmt + '（只支持 16/32 位）。', rd.pos - 1);
        const indices = idxFmt === 16 ? new Uint16Array(iCount) : new Uint32Array(iCount);
        for (let i = 0; i < iCount; i++) indices[i] = idxFmt === 16 ? rd.u16('索引') : rd.u32('索引');
        const seamCount = rd.u16('UV接缝数');
        const uvSeams = [];
        for (let i = 0; i < seamCount; i++) uvSeams.push({ a: rd.u32('UV接缝a'), b: rd.u32('UV接缝b') });
        blocks.push({ id: bi, name: '块' + bi, positions, uvs, indices, uvSeams, nx: 0, nz: 0 });
      }

      const modeId = rd.u8('范围模式');
      if (modeId > 2) throw new DecodeError('未知范围模式代码 ' + modeId, rd.pos - 1);
      mode = MODE_BY_ID[modeId];
      bits = rd.u8('量化位数');
      if (![8, 10, 12, 16].includes(bits)) throw new DecodeError('不支持的量化位数 ' + bits + '（仅支持 8/10/12/16）。', rd.pos - 1);
      thresholdU = rd.u32('裂缝阈值');
      const rangeCount = rd.u16('范围数量');
      if (rangeCount === 0 || rangeCount > blockCount) throw new DecodeError('范围数量异常：' + rangeCount, rd.pos - 2);
      ranges = [];
      for (let ri = 0; ri < rangeCount; ri++) {
        const minX = rd.f32('范围minX'), minY = rd.f32('范围minY'), minZ = rd.f32('范围minZ');
        const maxX = rd.f32('范围maxX'), maxY = rd.f32('范围maxY'), maxZ = rd.f32('范围maxZ');
        if (maxX < minX || maxY < minY || maxZ < minZ) throw new DecodeError('范围 ' + ri + ' 的最大值小于最小值，数据已损坏。', rd.pos);
        ranges.push({ minX, minY, minZ, maxX, maxY, maxZ });
      }
      blockRangeId = [];
      for (let i = 0; i < blockCount; i++) {
        const rid = rd.u16('块范围映射');
        if (rid >= rangeCount) throw new DecodeError('块 ' + i + ' 引用了不存在的范围 ' + rid, rd.pos - 2);
        blockRangeId.push(rid);
      }

      const packedLen = rd.u32('位置码长度');
      if (packedLen > u8.length) throw new DecodeError('位置码长度字段 ' + packedLen + ' 超过文件大小，头部可能损坏。', rd.pos - 4);
      rd.need(packedLen, '位置码');
      const packed = u8.subarray(rd.pos, rd.pos + packedLen);
      rd.pos += packedLen;

      // 用位打包数据重新解码，并与文件中的位置交叉校验
      const br = new BitReader(packed);
      codesPerBlock = [];
      for (const b of blocks) {
        const codes = new Uint32Array(b.positions.length);
        for (let i = 0; i < codes.length; i++) codes[i] = br.read(bits);
        codesPerBlock.push(codes);
      }

      const seamCount = rd.u16('接缝数量');
      seams = [];
      for (let si = 0; si < seamCount; si++) {
        const blockA = rd.u16('接缝块A'), blockB = rd.u16('接缝块B');
        const name = rd.cstr('接缝名称'), axis = rd.cstr('接缝轴');
        if (blockA >= blockCount || blockB >= blockCount) throw new DecodeError('接缝 ' + name + ' 引用了不存在的块。', rd.pos);
        const pairCount = rd.u16('接缝点对数');
        const pairs = [];
        for (let i = 0; i < pairCount; i++) {
          const va = rd.u32('接缝va'), vb = rd.u32('接缝vb');
          const x = rd.f32('接缝x'), y = rd.f32('接缝y'), z = rd.f32('接缝z');
          pairs.push({ va, vb, x, y, z });
        }
        const extraCount = rd.u16('T接顶点数');
        const extraVertices = [];
        for (let i = 0; i < extraCount; i++) {
          const block = rd.u16('T接块'), vertex = rd.u32('T接顶点'), z = rd.f32('T接z');
          extraVertices.push({ block, vertex, z });
        }
        seams.push({ id: 'seam-' + si, name, axis, blockA, blockB, pairs, extraVertices });
      }

      // 尾部校验
      const crc = rd.u32('CRC32');
      const endMagic = rd.u32('结束魔数');
      const bodyBytes = u8.subarray(0, u8.length - 8);
      const wantCrc = crc32(bodyBytes);
      if (crc !== wantCrc) {
        warnings.push('CRC32 校验不一致（文件中 0x' + crc.toString(16).padStart(8, '0') +
          '，实算 0x' + wantCrc.toString(16).padStart(8, '0') + '），文件可能被截断或改动；已按内容尽力解析，请核对误差数字。');
      }
      if (endMagic !== END_MAGIC) {
        throw new DecodeError('结束标记 "MEND" 缺失或损坏，文件可能被截断；主体内容已读出但写入可能不完整。', rd.pos - 4,
          { seed, flags, blocks, ranges, blockRangeId, mode, bits, threshold: thresholdU / 1e6, codesPerBlock, seams, warnings });
      }
      if (rd.pos !== u8.length) warnings.push('文件末尾有 ' + (u8.length - rd.pos) + ' 字节多余数据，已忽略。');
    } catch (e) {
      if (e instanceof DecodeError) throw e;
      throw new DecodeError('解析失败：' + e.message, rd.pos);
    }

    const threshold = thresholdU / 1e6;
    return {
      scene: { version: 1, seed, blocks, seams, generatedBy: 'mesh-precision-compare/imported' },
      flags,
      storeRestored: (flags & FLAG_POS_RESTORED) !== 0,
      ranges, blockRangeId, mode, bits, threshold, codesPerBlock, warnings,
    };
  }

  MPC.binary = { MAGIC, END_MAGIC, FORMAT_VERSION, FLAG_POS_RESTORED, DecodeError, encode, decode, byteAccounting, BitWriter, BitReader };
  if (typeof module !== 'undefined' && module.exports) module.exports = MPC;
})(typeof globalThis !== 'undefined' ? globalThis : this);
