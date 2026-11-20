// OBJ 解析器：只做语法解析与结构记录，材质解析与几何展开在 build-scene 中完成
// 所有无法处理的内容都产生带文件名/行号的 ParseWarning，而不是抛异常

import type {
  ParseWarning,
  ParsedObj,
  RawFace,
  RawFaceVertex,
  RawGroup,
  RawObject,
} from './types';
import type { Vec3 } from './math';

const MAX_WARNINGS = 500;

function makeWarn(
  file: string,
  line: number | null,
  code: string,
  message: string,
  raw: string | undefined,
  warnings: ParseWarning[],
): void {
  if (warnings.length >= MAX_WARNINGS) return;
  warnings.push({
    level: 'warn',
    code,
    message,
    file,
    line,
    raw,
  });
}

/** 解析 v/vt/vn 后的数字串，失败返回 null */
function parseNumbers(tokens: string[]): number[] | null {
  const nums: number[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const n = Number(tokens[i]);
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  return nums;
}

/** 解析 f 的一个顶点引用，如 1、1/2、1//3、-1/-2/-3 */
function parseFaceToken(token: string): RawFaceVertex | null {
  const parts = token.split('/');
  if (parts.length < 1 || parts.length > 3) return null;
  const v = parts[0] === '' ? NaN : Number(parts[0]);
  const vt = parts.length >= 2 && parts[1] !== '' ? Number(parts[1]) : 0;
  const vn = parts.length >= 3 && parts[2] !== '' ? Number(parts[2]) : 0;
  if (!Number.isFinite(v) || !Number.isFinite(vt) || !Number.isFinite(vn)) return null;
  return { v, vt, vn };
}

export function parseObj(text: string, fileName: string): ParsedObj {
  const warnings: ParseWarning[] = [];
  const vertices: Vec3[] = [];
  const texcoords: [number, number][] = [];
  const normals: Vec3[] = [];
  const faces: RawFace[] = [];
  const objects: RawObject[] = [];
  const mtllibs: string[] = [];

  // 初始默认对象 + 默认组（文件没有任何 o/g 声明时也能工作）
  let currentObject: RawObject = { name: null, groups: [], startLine: 1 };
  let currentGroup: RawGroup = { name: null, faceIndices: [] };
  currentObject.groups.push(currentGroup);
  objects.push(currentObject);
  let currentMaterial: string | null = null;

  const lines = text.split(/\r\n|\r|\n/);

  const switchObject = (name: string | null, line: number): void => {
    currentObject = { name, groups: [], startLine: line };
    currentGroup = { name: null, faceIndices: [] };
    currentObject.groups.push(currentGroup);
    objects.push(currentObject);
  };

  const switchGroup = (name: string | null): void => {
    currentGroup = { name, faceIndices: [] };
    currentObject.groups.push(currentGroup);
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i];
    // 去掉行内注释与首尾空白
    const hashIdx = rawLine.indexOf('#');
    const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
    if (line === '') continue;

    const tokens = line.split(/\s+/);
    const keyword = tokens[0];

    switch (keyword) {
      case 'v': {
        const nums = parseNumbers(tokens);
        if (!nums || nums.length < 3) {
          makeWarn(
            fileName,
            lineNo,
            'OBJ_VERTEX_INVALID',
            `顶点坐标需要至少 3 个数字，实际得到 "${line}"，该顶点已忽略`,
            rawLine,
            warnings,
          );
          break;
        }
        // 可选的第 4 分量（齐次权重）本查看器不支持，显式提示
        if (nums.length > 3) {
          makeWarn(
            fileName,
            lineNo,
            'OBJ_VERTEX_HOMOGENEOUS_UNSUPPORTED',
            `顶点包含第 4 分量（齐次坐标），查看器仅取前 3 个分量`,
            rawLine,
            warnings,
          );
        }
        vertices.push([nums[0], nums[1], nums[2]]);
        break;
      }
      case 'vt': {
        const nums = parseNumbers(tokens);
        if (!nums || nums.length < 2) {
          makeWarn(
            fileName,
            lineNo,
            'OBJ_TEXCOORD_INVALID',
            `纹理坐标需要至少 2 个数字，实际得到 "${line}"，该纹理坐标已忽略`,
            rawLine,
            warnings,
          );
          break;
        }
        texcoords.push([nums[0], nums[1]]);
        break;
      }
      case 'vn': {
        const nums = parseNumbers(tokens);
        if (!nums || nums.length < 3) {
          makeWarn(
            fileName,
            lineNo,
            'OBJ_NORMAL_INVALID',
            `法线需要 3 个数字，实际得到 "${line}"，该法线已忽略`,
            rawLine,
            warnings,
          );
          break;
        }
        normals.push([nums[0], nums[1], nums[2]]);
        break;
      }
      case 'f': {
        const refs: RawFaceVertex[] = [];
        let invalidReason: string | null = null;
        for (let t = 1; t < tokens.length; t++) {
          const ref = parseFaceToken(tokens[t]);
          if (!ref) {
            invalidReason = `顶点引用 "${tokens[t]}" 无法解析（应为 v、v/vt、v//vn 或 v/vt/vn 形式）`;
            break;
          }
          refs.push(ref);
        }
        if (!invalidReason && refs.length < 3) {
          invalidReason = `面至少需要 3 个顶点，实际只有 ${refs.length} 个`;
        }
        const face: RawFace = {
          vertices: refs,
          material: currentMaterial,
          line: lineNo,
        };
        if (invalidReason) {
          face.invalid = invalidReason;
          makeWarn(
            fileName,
            lineNo,
            'OBJ_FACE_INVALID',
            `无效面：${invalidReason}，该面已跳过，其余内容仍可查看`,
            rawLine,
            warnings,
          );
        }
        const faceIndex = faces.length;
        faces.push(face);
        currentGroup.faceIndices.push(faceIndex);
        break;
      }
      case 'o': {
        if (tokens.length < 2) {
          makeWarn(
            fileName,
            lineNo,
            'OBJ_OBJECT_EMPTY_NAME',
            'o 声明缺少对象名，已使用默认名称',
            rawLine,
            warnings,
          );
        }
        switchObject(tokens.length >= 2 ? tokens.slice(1).join(' ') : null, lineNo);
        currentMaterial = null;
        break;
      }
      case 'g': {
        if (tokens.length < 2) {
          // g 后无名字：切回匿名组
          switchGroup(null);
        } else {
          switchGroup(tokens.slice(1).join(' '));
        }
        break;
      }
      case 'usemtl': {
        if (tokens.length < 2) {
          makeWarn(
            fileName,
            lineNo,
            'OBJ_USEMTL_EMPTY',
            'usemtl 声明缺少材质名，后续面将按默认材质处理',
            rawLine,
            warnings,
          );
          currentMaterial = null;
        } else {
          currentMaterial = tokens.slice(1).join(' ');
        }
        break;
      }
      case 'mtllib': {
        if (tokens.length < 2) {
          makeWarn(
            fileName,
            lineNo,
            'OBJ_MTLLIB_EMPTY',
            'mtllib 声明缺少文件名',
            rawLine,
            warnings,
          );
        } else {
          mtllibs.push(tokens.slice(1).join(' '));
        }
        break;
      }
      case 's':
        // 光滑组是标准指令，本查看器按面法线/顶点法线直接处理，无需警告
        break;
      default: {
        makeWarn(
          fileName,
          lineNo,
          'OBJ_UNSUPPORTED_STATEMENT',
          `不支持的 OBJ 指令 "${keyword}"，该行已忽略，其余内容仍可查看`,
          rawLine,
          warnings,
        );
      }
    }
  }

  // 出现过显式 o 声明时，丢弃文件开头的隐式默认对象（它不包含任何面）
  let finalObjects = objects;
  if (objects.length > 1) {
    const head = objects[0];
    const headHasFaces = head.groups.some((g) => g.faceIndices.length > 0);
    if (!headHasFaces) finalObjects = objects.slice(1);
  }

  if (warnings.length >= MAX_WARNINGS) {
    warnings.push({
      level: 'warn',
      code: 'WARNING_TRUNCATED',
      message: `警告数量超过 ${MAX_WARNINGS} 条，后续警告已截断`,
      file: fileName,
      line: null,
    });
  }

  return { vertices, texcoords, normals, objects: finalObjects, faces, mtllibs, warnings };
}
