/*
 * core.js —— 纯逻辑层：常量、默认工程、通道取值、尺寸策略、分组匹配、ZIP 打包。
 * 不依赖 DOM，可在 Node 中直接 require 做单元测试。
 */
(function (global) {
  "use strict";
  const MT = global.MT || (global.MT = {});

  const ROLES = ["albedo", "normal", "roughness", "ao", "metallic", "custom"];
  const ROLE_LABELS = {
    albedo: "颜色 Albedo",
    normal: "法线 Normal",
    roughness: "粗糙度 Roughness",
    ao: "环境光遮蔽 AO",
    metallic: "金属度 Metallic",
    custom: "自定义",
  };
  const CHANNELS = ["r", "g", "b", "a"];
  const CHANNEL_LABELS = { r: "R 红", g: "G 绿", b: "B 蓝", a: "A 透明" };
  const PICK_MODES = ["red", "green", "blue", "alpha", "luma", "average"];
  const PICK_MODE_LABELS = {
    red: "红通道",
    green: "绿通道",
    blue: "蓝通道",
    alpha: "Alpha 通道",
    luma: "亮度 (Rec.709)",
    average: "RGB 均值",
  };
  const RESIZE_POLICIES = ["stretch", "crop", "pad"];
  const RESIZE_POLICY_LABELS = {
    stretch: "拉伸（铺满，可能变形）",
    crop: "裁切（保持比例，居中裁掉多余部分）",
    pad: "留边（保持比例，不足处补填充色）",
  };
  const ORIENTATIONS = ["opengl", "directx"];
  const ORIENTATION_LABELS = {
    opengl: "OpenGL / glTF（+Y 向上）",
    directx: "DirectX / Unity（-Y 向下）",
  };

  const DEFAULT_SUFFIXES = {
    albedo: ["_albedo", "_basecolor", "_color", "_diffuse", "_diff", "_albedo"],
    normal: ["_normal", "_norm", "_n", "_nrm"],
    roughness: ["_roughness", "_rough", "_r"],
    ao: ["_ao", "_ambientocclusion", "_occlusion"],
    metallic: ["_metallic", "_metal", "_m"],
    custom: [],
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function clamp8(v) {
    return clamp(Math.round(v), 0, 255);
  }
  function clamp01(v) {
    return clamp(v, 0, 1);
  }

  /** 从一个 RGBA 像素中按取色方式提取单通道 0..255 值 */
  function pickChannelValue(mode, r, g, b, a) {
    switch (mode) {
      case "red":
        return r;
      case "green":
        return g;
      case "blue":
        return b;
      case "alpha":
        return a;
      case "average":
        return (r + g + b) / 3;
      case "luma":
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      default:
        throw new Error("未知取色方式: " + mode);
    }
  }

  /** 反转 + 强度（strength: 0=全黑, 1=原值, 2=加倍对比），输入输出均为 0..255 */
  function applyChannelTransform(value, invert, strength) {
    let v = value / 255;
    if (invert) v = 1 - v;
    v = v * (strength == null ? 1 : strength);
    return clamp8(v * 255);
  }

  /**
   * 计算源矩形 -> 目标矩形的映射（整数坐标）。
   * stretch: 源整体铺满目标；crop: 等比放大后居中裁切；pad: 等比缩小后居中留边。
   * 返回 {sx,sy,sw,sh, dx,dy,dw,dh}
   */
  function resizeRect(sw, sh, tw, th, policy) {
    if (policy === "stretch") {
      return { sx: 0, sy: 0, sw, sh, dx: 0, dy: 0, dw: tw, dh: th };
    }
    const scale =
      policy === "crop"
        ? Math.max(tw / sw, th / sh)
        : Math.min(tw / sw, th / sh);
    if (policy === "pad") {
      // 等比缩小到画布内，居中留边；尺寸直接由缩放比决定，不再钳制
      const dw = Math.round(sw * scale);
      const dh = Math.round(sh * scale);
      return {
        sx: 0, sy: 0, sw, sh,
        dx: Math.round((tw - dw) / 2),
        dy: Math.round((th - dh) / 2),
        dw, dh,
      };
    }
    // crop：目标铺满画布；在源上按目标宽高比居中裁出一块，再拉伸到目标
    const targetAspect = tw / th;
    let csw = sw;
    let csh = Math.round(sw / targetAspect);
    if (csh > sh) {
      csh = sh;
      csw = Math.round(sh * targetAspect);
    }
    return {
      sx: Math.round((sw - csw) / 2),
      sy: Math.round((sh - csh) / 2),
      sw: csw,
      sh: csh,
      dx: 0, dy: 0, dw: tw, dh: th,
    };
  }

  const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"];

  function stemOf(filename) {
    const dot = filename.lastIndexOf(".");
    return dot > 0 ? filename.slice(0, dot) : filename;
  }

  /** 依据后缀表推断角色与分组名，匹配不到返回 null */
  function deriveRole(filename, roleSuffixes) {
    const stem = stemOf(filename).toLowerCase();
    let best = null;
    for (const role of Object.keys(roleSuffixes)) {
      for (const suffix of roleSuffixes[role] || []) {
        const s = suffix.toLowerCase();
        if (stem.endsWith(s) && (!best || s.length > best.suffix.length)) {
          best = { role, suffix: s, group: stem.slice(0, stem.length - s.length) };
        }
      }
    }
    return best;
  }

  /**
   * 把上传文件列表归组。files: [{id,name,width,height,dataUrl, role?, group?}]
   * 返回 [{name, files:{role:file}, unassigned:[file], warnings:[...]}]
   * 已手工指定 role 的文件以手工为准；同组同角色出现多个时，后来者进 unassigned 并给警告。
   */
  function matchGroups(files, roleSuffixes) {
    const map = new Map();
    const result = [];
    const ensure = (key) => {
      if (!map.has(key)) {
        const g = { name: key, files: {}, unassigned: [], warnings: [] };
        map.set(key, g);
        result.push(g);
      }
      return map.get(key);
    };
    for (const file of files) {
      if (file.role === "unassigned") {
        // 显式标记为未分配：进入指定组（file.group），否则按文件名独立成组
        ensure(file.group || stemOf(file.name)).unassigned.push(file);
        continue;
      }
      let info = file.role
        ? { role: file.role, group: file.group || stemOf(file.name) }
        : deriveRole(file.name, roleSuffixes);
      if (!info) {
        ensure(stemOf(file.name)).unassigned.push(file);
        continue;
      }
      const g = ensure(info.group);
      if (g.files[info.role]) {
        g.unassigned.push(file);
        g.warnings.push(
          `角色「${ROLE_LABELS[info.role] || info.role}」存在多个文件，采用 ${g.files[info.role].name}，${file.name} 已放入未分配，可手工替换`
        );
      } else {
        g.files[info.role] = file;
      }
    }
    return result.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** 同名保护：desired 与 existing 冲突时追加 _2、_3…（不含扩展名） */
  function uniqueName(desired, existing) {
    const set = new Set(existing);
    if (!set.has(desired)) return desired;
    const dot = desired.lastIndexOf(".");
    const base = dot > 0 ? desired.slice(0, dot) : desired;
    const ext = dot > 0 ? desired.slice(dot) : "";
    for (let i = 2; ; i++) {
      const candidate = `${base}_${i}${ext}`;
      if (!set.has(candidate)) return candidate;
    }
  }

  /** 替换文件名模板中的 {group} {output} 标记 */
  function renderPattern(pattern, group, output) {
    return pattern.replace(/\{group\}/g, group).replace(/\{output\}/g, output);
  }

  // ------------------------------------------------------------------ //
  // 默认工程
  // ------------------------------------------------------------------ //

  let _uid = 0;
  function uid(prefix) {
    return `${prefix || "id"}_${Date.now().toString(36)}_${(_uid++).toString(36)}`;
  }

  function channelSpec(channel, role, mode, extra) {
    return Object.assign(
      {
        channel,
        source: role ? { type: "role", role } : { type: "constant", value: 255 },
        mode: mode || "red",
        invert: false,
        strength: 1,
        constant: 255,
      },
      extra || {}
    );
  }

  function defaultProject() {
    return {
      app: "mtpack",
      version: 1,
      settings: {
        outputWidth: 256,
        outputHeight: 256,
        resizePolicy: "pad",
        padColor: { r: 0, g: 0, b: 0, a: 255 },
        normalOrientation: "opengl",
        normalStrength: 1,
        filenamePattern: "{group}_{output}",
        embedImages: true,
      },
      roleSuffixes: JSON.parse(JSON.stringify(DEFAULT_SUFFIXES)),
      outputs: [
        {
          id: uid("out"),
          name: "ORM 打包图",
          filename: "orm",
          isNormal: false,
          channels: [
            channelSpec("r", "ao", "red"),
            channelSpec("g", "roughness", "red"),
            channelSpec("b", "metallic", "red", {
              source: { type: "constant", value: 0 },
            }),
          ],
        },
        {
          id: uid("out"),
          name: "法线图",
          filename: "normal",
          isNormal: true,
          channels: [
            channelSpec("r", "normal", "red"),
            channelSpec("g", "normal", "green"),
            channelSpec("b", "normal", "blue"),
          ],
        },
        {
          id: uid("out"),
          name: "颜色图",
          filename: "albedo",
          isNormal: false,
          channels: [
            channelSpec("r", "albedo", "red"),
            channelSpec("g", "albedo", "green"),
            channelSpec("b", "albedo", "blue"),
          ],
        },
      ],
      groups: [],
    };
  }

  /** 加载工程时做容错补全，缺字段用默认值补齐，避免旧版本文件崩页面 */
  function normalizeProject(raw) {
    const base = defaultProject();
    if (!raw || typeof raw !== "object") throw new Error("工程文件不是有效的 JSON 对象");
    if (raw.app !== "mtpack") throw new Error("工程文件缺少 mtpack 标识");
    const p = Object.assign(base, raw);
    p.settings = Object.assign(base.settings, raw.settings || {});
    p.settings.padColor = Object.assign(base.settings.padColor, (raw.settings || {}).padColor || {});
    p.roleSuffixes = Object.assign(base.roleSuffixes, raw.roleSuffixes || {});
    if (!Array.isArray(p.outputs) || p.outputs.length === 0)
      throw new Error("工程文件没有任何输出定义");
    p.outputs = p.outputs.map((o, i) => {
      const channels = (o.channels || []).map((c) =>
        Object.assign(channelSpec(c.channel, null, "red"), c)
      );
      while (channels.length < 4) {
        const ch = CHANNELS[channels.length];
        channels.push(channelSpec(ch, null, "red", { source: { type: "constant", value: ch === "a" ? 255 : 0 } }));
      }
      return Object.assign(
        { id: uid("out"), name: `输出 ${i + 1}`, filename: `output${i + 1}`, isNormal: false, channels },
        o,
        { channels }
      );
    });
    p.groups = Array.isArray(raw.groups) ? raw.groups : [];
    return p;
  }

  // ------------------------------------------------------------------ //
  // ZIP（STORE，零依赖；PNG 本身已压缩，再 deflate 收益很小）
  // ------------------------------------------------------------------ //

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function _u16(v) {
    return [v & 0xff, (v >>> 8) & 0xff];
  }
  function _u32(v) {
    return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  }

  /**
   * 打包 ZIP。entries: [{name, bytes:Uint8Array}]
   * 不做压缩（method 0），返回 Uint8Array。
   */
  function zipStore(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const enc = new TextEncoder();
    for (const entry of entries) {
      const nameBytes = enc.encode(entry.name);
      const data = entry.bytes instanceof Uint8Array
        ? entry.bytes
        : new Uint8Array(entry.bytes);
      const crc = crc32(data);
      const local = [
        ..._u32(0x04034b50), ..._u16(20), ..._u16(0), ..._u16(0),
        ..._u16(0), ..._u16(0), ..._u32(crc), ..._u32(data.length),
        ..._u32(data.length), ..._u16(nameBytes.length), ..._u16(0),
      ];
      chunks.push(Uint8Array.from(local), nameBytes, data);
      const localSize = 30 + nameBytes.length + data.length;
      central.push(
        Uint8Array.from([
          ..._u32(0x02014b50), ..._u16(20), ..._u16(20), ..._u16(0),
          ..._u16(0), ..._u16(0), ..._u16(0), ..._u32(crc),
          ..._u32(data.length), ..._u32(data.length),
          ..._u16(nameBytes.length), ..._u16(0), ..._u16(0),
          ..._u16(0), ..._u16(0), ..._u32(0), ..._u32(offset),
        ]),
        nameBytes
      );
      offset += localSize;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) {
      chunks.push(c);
      centralSize += c.length;
    }
    const end = Uint8Array.from([
      ..._u32(0x06054b50), ..._u16(0), ..._u16(0),
      ..._u16(entries.length), ..._u16(entries.length),
      ..._u32(centralSize), ..._u32(centralStart), ..._u16(0),
    ]);
    chunks.push(end);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  MT.core = {
    ROLES, ROLE_LABELS, CHANNELS, CHANNEL_LABELS,
    PICK_MODES, PICK_MODE_LABELS,
    RESIZE_POLICIES, RESIZE_POLICY_LABELS,
    ORIENTATIONS, ORIENTATION_LABELS,
    DEFAULT_SUFFIXES, IMAGE_EXTS,
    clamp, clamp8, clamp01,
    pickChannelValue, applyChannelTransform, resizeRect,
    stemOf, deriveRole, matchGroups, uniqueName, renderPattern,
    uid, channelSpec, defaultProject, normalizeProject,
    crc32, zipStore,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = MT.core;
})(typeof globalThis !== "undefined" ? globalThis : this);
