// MTL 材质库解析器：支持常见的颜色/透明度/贴图指令，无法识别的内容带行号告警

import type { MtlColor, MtlMaterial, MtlTextureRef, ParseWarning, ParsedMtl } from './types';

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function parseColor(tokens: string[], start: number): MtlColor | null {
  const nums: number[] = [];
  for (let i = start; i < tokens.length; i++) {
    const n = Number(tokens[i]);
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  if (nums.length === 1) {
    return { r: nums[0], g: nums[0], b: nums[0] };
  }
  if (nums.length >= 3) {
    return { r: nums[0], g: nums[1], b: nums[2] };
  }
  return null;
}

/** 取贴图声明最后一个 token 作为路径（跳过 -s/-o 等选项的简化处理：选项均成对出现） */
function parseTexturePath(tokens: string[]): string | null {
  const args = tokens.slice(1).filter((t) => !t.startsWith('-'));
  if (args.length === 0) return null;
  return args[args.length - 1];
}

export function parseMtl(text: string, fileName: string): ParsedMtl {
  const warnings: ParseWarning[] = [];
  const materials = new Map<string, MtlMaterial>();
  let current: MtlMaterial | null = null;

  const warn = (line: number, code: string, message: string, raw: string): void => {
    if (warnings.length >= 500) return;
    warnings.push({ level: 'warn', code, message, file: fileName, line, raw });
  };

  const newMaterial = (name: string, line: number): MtlMaterial => {
    const mat: MtlMaterial = {
      name,
      diffuse: { r: 0.8, g: 0.8, b: 0.8 },
      ambient: { r: 0.2, g: 0.2, b: 0.2 },
      specular: { r: 0.0, g: 0.0, b: 0.0 },
      shininess: 32,
      opacity: 1,
      diffuseMap: null,
      normalMap: null,
    };
    if (materials.has(name)) {
      warn(
        line,
        'MTL_DUPLICATE_MATERIAL',
        `材质 "${name}" 重复定义，后出现的定义覆盖前者`,
        '',
      );
    }
    materials.set(name, mat);
    return mat;
  };

  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i];
    const hashIdx = rawLine.indexOf('#');
    const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
    if (line === '') continue;
    const tokens = line.split(/\s+/);
    const kw = tokens[0];

    // 不依赖当前材质上下文的指令
    if (kw === 'newmtl') {
      if (tokens.length < 2) {
        warn(lineNo, 'MTL_NEWMTL_EMPTY', 'newmtl 声明缺少材质名，已跳过', rawLine);
        current = null;
      } else {
        current = newMaterial(tokens.slice(1).join(' '), lineNo);
      }
      continue;
    }

    if (!current) {
      warn(
        lineNo,
        'MTL_ORPHAN_STATEMENT',
        `"${kw}" 出现在任何 newmtl 之前，没有可写入的材质，该行已忽略`,
        rawLine,
      );
      continue;
    }

    const setTexture = (field: 'diffuseMap' | 'normalMap', code: string): void => {
      const path = parseTexturePath(tokens);
      if (!path) {
        warn(lineNo, code, `${kw} 声明缺少贴图路径，已忽略`, rawLine);
        return;
      }
      const ref: MtlTextureRef = { path, line: lineNo };
      current![field] = ref;
    };

    switch (kw) {
      case 'Ka': {
        const c = parseColor(tokens, 1);
        if (!c) warn(lineNo, 'MTL_COLOR_INVALID', `Ka 颜色无法解析："${line}"`, rawLine);
        else current.ambient = c;
        break;
      }
      case 'Kd': {
        const c = parseColor(tokens, 1);
        if (!c) warn(lineNo, 'MTL_COLOR_INVALID', `Kd 颜色无法解析："${line}"`, rawLine);
        else current.diffuse = c;
        break;
      }
      case 'Ks': {
        const c = parseColor(tokens, 1);
        if (!c) warn(lineNo, 'MTL_COLOR_INVALID', `Ks 颜色无法解析："${line}"`, rawLine);
        else current.specular = c;
        break;
      }
      case 'Ke':
        // 自发光本查看器不参与渲染，但属于常见标准指令，静默接受
        break;
      case 'Ns': {
        const n = Number(tokens[1]);
        if (!Number.isFinite(n) || tokens.length < 2) {
          warn(lineNo, 'MTL_NUMBER_INVALID', `Ns 高光指数无法解析："${line}"`, rawLine);
        } else {
          current.shininess = Math.min(1000, Math.max(0, n));
        }
        break;
      }
      case 'd': {
        const n = Number(tokens[1]);
        if (!Number.isFinite(n) || tokens.length < 2) {
          warn(lineNo, 'MTL_NUMBER_INVALID', `d 不透明度无法解析："${line}"`, rawLine);
        } else {
          current.opacity = clamp01(n);
        }
        break;
      }
      case 'Tr': {
        const n = Number(tokens[1]);
        if (!Number.isFinite(n) || tokens.length < 2) {
          warn(lineNo, 'MTL_NUMBER_INVALID', `Tr 透明度无法解析："${line}"`, rawLine);
        } else {
          current.opacity = clamp01(1 - n);
        }
        break;
      }
      case 'illum':
        // 光照模型编号：标准指令，本查看器使用统一光照，静默接受
        break;
      case 'map_Kd':
        setTexture('diffuseMap', 'MTL_TEXTURE_PATH_INVALID');
        break;
      case 'map_Bump':
      case 'bump':
      case 'norm':
        setTexture('normalMap', 'MTL_TEXTURE_PATH_INVALID');
        break;
      default:
        warn(
          lineNo,
          'MTL_UNSUPPORTED_STATEMENT',
          `不支持的 MTL 指令 "${kw}"，该行已忽略`,
          rawLine,
        );
    }
  }

  return { file: fileName, materials, warnings };
}
