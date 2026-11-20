import type { ShaderDiagnostic } from '../types';

/**
 * 解析 GLSL 编译日志。ANGLE / 各驱动格式不一，常见有：
 *   ERROR: 0:12: 'foo' : ...
 *   ERROR: 12:13(7): ...
 * 这里尽量兼容，提取第一个看起来像行号的数字，再减去前缀行数。
 */
const ERROR_LINE_RES = [
  /\bERROR:\s*\d+:(\d+):\s*(.*)$/,
  /\bERROR:\s*(\d+):\d+\([^)]*\):\s*(.*)$/,
  /\bWARNING:\s*\d+:(\d+):\s*(.*)$/,
];

export function parseShaderLog(
  log: string,
  prefixLines: number,
): ShaderDiagnostic[] {
  const diagnostics: ShaderDiagnostic[] = [];
  for (const rawLine of log.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    for (const re of ERROR_LINE_RES) {
      const m = line.match(re);
      if (!m) continue;
      const rawLineNo = Number(m[1]);
      const userLine = rawLineNo - prefixLines;
      diagnostics.push({
        line: userLine >= 1 ? userLine : 1,
        rawLine: rawLineNo,
        message: m[2]?.trim() || line,
      });
      break;
    }
  }
  // 没匹配到行号时，至少把原始日志展示出来
  if (diagnostics.length === 0 && log.trim()) {
    diagnostics.push({ line: 1, rawLine: 1, message: log.trim() });
  }
  return diagnostics;
}

export function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): { shader: WebGLShader | null; log: string } {
  const shader = gl.createShader(type);
  if (!shader) return { shader: null, log: '无法创建着色器对象' };
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '未知编译错误';
    gl.deleteShader(shader);
    return { shader: null, log };
  }
  return { shader, log: '' };
}

export function linkProgram(
  gl: WebGLRenderingContext,
  shaders: WebGLShader[],
  bindAttribs?: (program: WebGLProgram) => void,
): { program: WebGLProgram | null; log: string } {
  const program = gl.createProgram();
  if (!program) return { program: null, log: '无法创建程序对象' };
  for (const s of shaders) gl.attachShader(program, s);
  // 必须在 link 之前绑定属性位置
  bindAttribs?.(program);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '未知链接错误';
    gl.deleteProgram(program);
    return { program: null, log };
  }
  return { program, log: '' };
}
