/* 标准 MIDI 文件（SMF）读写：导出 format 1，导入 format 0/1。零依赖。 */
const MidiFile = (() => {
  /* ---------- 写 ---------- */
  function vlq(n) {
    const bytes = [n & 0x7f];
    n >>>= 7;
    while (n) { bytes.unshift((n & 0x7f) | 0x80); n >>>= 7; }
    return bytes;
  }

  function strBytes(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else { // 简单 UTF-8
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  function trackChunk(events, endTick) {
    // events: [{tick, bytes:[...]}]，按 tick 排序后写 delta time
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const body = [];
    let last = 0;
    for (const e of events) {
      body.push(...vlq(e.tick - last), ...e.bytes);
      last = e.tick;
    }
    // End of Track：delta 补齐到 endTick，保证导出时长一致
    const end = Math.max(endTick == null ? last : endTick, last);
    body.push(...vlq(end - last), 0xff, 0x2f, 0x00);
    const len = body.length;
    return [
      0x4d, 0x54, 0x72, 0x6b, // MTrk
      (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
      ...body,
    ];
  }

  // project -> Uint8Array（SMF format 1）
  function write(project) {
    const ppq = project.ppq;
    const total = Model.totalTicks(project);

    // 轨 0：速度 + 拍号
    const meta = [];
    let order = 0;
    for (const t of project.tempoMap.slice().sort((a, b) => a.tick - b.tick)) {
      const us = Math.round(60000000 / t.bpm);
      meta.push({
        tick: t.tick, order: order++,
        bytes: [0xff, 0x51, 0x03, (us >>> 16) & 0xff, (us >>> 8) & 0xff, us & 0xff],
      });
    }
    for (const s of project.timeSigs.slice().sort((a, b) => a.tick - b.tick)) {
      const dd = Math.round(Math.log2(s.den));
      meta.push({ tick: s.tick, order: order++, bytes: [0xff, 0x58, 0x04, s.num & 0xff, dd & 0xff, 24, 8] });
    }

    const chunks = [trackChunk(meta, total)];

    project.tracks.forEach((tr, i) => {
      const channel = tr.instrument === 'drums' ? 9 : Math.min(i, 15) === 9 ? 15 : i % 9;
      const events = [];
      let ord = 0;
      const nameBytes = strBytes(tr.name || `Track ${i + 1}`);
      events.push({ tick: 0, order: ord++, bytes: [0xff, 0x03, nameBytes.length, ...nameBytes] });
      if (tr.instrument !== 'drums') {
        events.push({ tick: 0, order: ord++, bytes: [0xc0 | channel, 0x00] }); // Acoustic Grand
      }
      for (const n of tr.notes) {
        events.push({ tick: n.tick, order: ord++, bytes: [0x90 | channel, n.pitch & 0x7f, n.vel & 0x7f] });
        events.push({ tick: n.tick + n.dur, order: ord++, bytes: [0x80 | channel, n.pitch & 0x7f, 0x40] });
      }
      chunks.push(trackChunk(events, total)); // 尾部对齐工程总长
    });

    const ntrks = chunks.length;
    const header = [
      0x4d, 0x54, 0x68, 0x64, // MThd
      0, 0, 0, 6,
      0, 1, // format 1
      (ntrks >>> 8) & 0xff, ntrks & 0xff,
      (ppq >>> 8) & 0xff, ppq & 0xff,
    ];
    const all = [...header, ...chunks.flat()];
    return new Uint8Array(all);
  }

  /* ---------- 读 ---------- */
  function parse(buffer) {
    const dv = new DataView(buffer);
    let pos = 0;
    const u8 = () => dv.getUint8(pos++);
    const u16 = () => { const v = dv.getUint16(pos); pos += 2; return v; };
    const u32 = () => { const v = dv.getUint32(pos); pos += 4; return v; };
    const readVlq = () => {
      let v = 0, b;
      do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80);
      return v;
    };

    if (u32() !== 0x4d546864) throw new Error('不是 MIDI 文件（缺少 MThd）');
    const hlen = u32();
    const format = u16();
    const ntrks = u16();
    const division = u16();
    if (division & 0x8000) throw new Error('暂不支持 SMPTE 时间格式的 MIDI 文件');
    pos = 8 + hlen;

    const srcPpq = division;
    const dstPpq = Model.PPQ;
    const conv = t => Math.round((t * dstPpq) / srcPpq);

    const tempoMap = [];
    const timeSigs = [];
    const tracks = [];

    for (let ti = 0; ti < ntrks; ti++) {
      if (u32() !== 0x4d54726b) throw new Error(`第 ${ti + 1} 个块不是 MTrk`);
      const len = u32();
      const end = pos + len;
      let tick = 0, status = 0;
      let name = '';
      const active = new Map(); // key channel<<8|pitch -> [{tick, vel}]
      const notes = [];
      let isDrum = false;

      while (pos < end) {
        tick += readVlq();
        let b = u8();
        if (b < 0x80) { pos--; b = status; } else if (b < 0xf0) status = b;
        if (b === 0xff) {
          const type = u8();
          const l = readVlq();
          const start = pos;
          if (type === 0x51 && l === 3) {
            const us = (u8() << 16) | (u8() << 8) | u8();
            tempoMap.push({ tick: conv(tick), bpm: +(60000000 / us).toFixed(3) });
          } else if (type === 0x58 && l >= 4) {
            const num = u8(), den = 1 << u8();
            timeSigs.push({ tick: conv(tick), num, den });
          } else if (type === 0x03) {
            name = '';
            for (let i = 0; i < l; i++) name += String.fromCharCode(u8());
          }
          pos = start + l;
        } else if (b === 0xf0 || b === 0xf7) {
          const l = readVlq();
          pos += l;
        } else {
          const kind = b & 0xf0;
          const channel = b & 0x0f;
          if (channel === 9) isDrum = true;
          if (kind === 0x90 || kind === 0x80) {
            const pitch = u8(), vel = u8();
            const key = (channel << 8) | pitch;
            if (kind === 0x90 && vel > 0) {
              if (!active.has(key)) active.set(key, []);
              active.get(key).push({ tick, vel });
            } else {
              const stack = active.get(key);
              if (stack && stack.length) {
                const on = stack.shift();
                const t0 = conv(on.tick), t1 = conv(tick);
                notes.push({ tick: t0, dur: Math.max(1, t1 - t0), pitch, vel: on.vel });
              }
            }
          } else if (kind === 0xa0 || kind === 0xb0 || kind === 0xe0) {
            u8(); u8();
          } else if (kind === 0xc0 || kind === 0xd0) {
            u8();
          } else {
            throw new Error(`未知 MIDI 事件 0x${b.toString(16)}`);
          }
        }
      }
      pos = end;
      if (notes.length || name) {
        tracks.push({ name: name || `Track ${tracks.length + 1}`, isDrum, notes });
      }
    }

    // 组装为工程
    const project = Model.createProject();
    project.tracks = [];
    project.tempoMap = tempoMap.length ? tempoMap.sort((a, b) => a.tick - b.tick) : [{ tick: 0, bpm: 120 }];
    if (project.tempoMap[0].tick !== 0) project.tempoMap.unshift({ tick: 0, bpm: project.tempoMap[0].bpm });
    project.timeSigs = timeSigs.length ? timeSigs.sort((a, b) => a.tick - b.tick) : [{ tick: 0, num: 4, den: 4 }];
    if (project.timeSigs[0].tick !== 0) project.timeSigs.unshift({ tick: 0, num: 4, den: 4 });

    let maxTick = 0;
    for (const t of tracks) {
      const tr = Model.createTrack(t.name, t.isDrum ? 'drums' : 'piano');
      for (const n of t.notes) {
        Model.newNote(tr, n.tick, n.pitch, n.dur, n.vel);
        maxTick = Math.max(maxTick, n.tick + n.dur);
      }
      project.tracks.push(tr);
    }
    if (!project.tracks.length) project.tracks.push(Model.createTrack('Piano', 'piano'));

    // 根据内容与拍号表推算小节数
    const bounds = [];
    let tick = 0, si = 0;
    const sigs = project.timeSigs;
    while (tick < maxTick || bounds.length < 1) {
      while (si + 1 < sigs.length && sigs[si + 1].tick <= tick) si++;
      const s = sigs[si];
      const len = s.num * ((project.ppq * 4) / s.den);
      bounds.push(tick);
      tick += len;
      if (bounds.length > 10000) break;
    }
    project.lengthMeasures = Math.max(1, bounds.length);
    return project;
  }

  return { write, parse };
})();
