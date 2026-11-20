import type { ProjectData } from '../types';
import { BUILTIN_TEXTURES } from '../webgl/textures';

const now = () => new Date().toISOString();

function makeProject(
  name: string,
  main: string,
  post: string,
  uniforms: Record<string, unknown>,
): ProjectData {
  return {
    format: 'shader-lab-project',
    version: 1,
    name,
    savedAt: now(),
    source: { main, post },
    uniforms: uniforms as ProjectData['uniforms'],
    preview: {
      mode: 'fullscreen',
      resolutionKey: '640x480',
      customWidth: 640,
      customHeight: 480,
      postEnabled: true,
    },
    time: { playing: true, time: 0 },
  };
}

const checker = BUILTIN_TEXTURES.find((t) => t.name === 'checker')!.dataUrl;

/* ---------------- 示例 1：纹理 + UV 流动 ---------------- */

const TEXTURE_MAIN = `// 纹理示例：采样一张纹理，并用 uScroll 控制 UV 滚动
uniform sampler2D uTexture;
uniform vec2 uTiling;       // @default(3.0, 3.0)
uniform float uScrollSpeed; // @range(0, 2, 0.05) @default(0.3)
uniform float uMix;         // @range(0, 1, 0.01) @default(0.35)
uniform vec3 uTint;         // @default(0.4, 0.7, 1.0)

void main() {
  vec2 uv = vUv * uTiling;
  uv.x += uTime * uScrollSpeed;
  vec3 tex = texture2D(uTexture, uv).rgb;
  vec3 color = mix(tex, tex * uTint, uMix);
  // 简单的边缘暗角
  float d = distance(vUv, vec2(0.5));
  color *= smoothstep(0.95, 0.35, d);
  gl_FragColor = vec4(color, 1.0);
}
`;

/* ---------------- 示例 2：Blinn-Phong 光照 ---------------- */

const LIGHT_MAIN = `// 光照示例：Blinn-Phong 模型，两种预览都可运行
// 全屏模式下使用程序化法线；网格模式下使用真实顶点法线
uniform vec3 uBaseColor;  // @default(0.2, 0.8, 0.6)
uniform float uShininess; // @range(1, 128, 1) @default(32)
uniform float uLightOrbit; // @range(0, 3, 0.05) @default(1.0)
uniform vec3 uLightColor; // @default(1.0, 0.95, 0.85)

void main() {
  // 程序化“波纹法线”，让全屏预览也能看到高光流动
  float wave = sin(vUv.x * 12.0 + uTime) * cos(vUv.y * 12.0 - uTime * 0.7);
  vec3 progNormal = normalize(vec3(wave * 0.4, wave * 0.4, 1.0));
  vec3 N = normalize(mix(normalize(vNormal), progNormal, vNormal.z > 0.99 ? 1.0 : 0.0));

  vec3 lightPos = vec3(cos(uTime * uLightOrbit) * 2.0, 2.0, sin(uTime * uLightOrbit) * 2.0);
  vec3 L = normalize(lightPos - vWorldPos);
  vec3 V = normalize(vec3(0.0, 1.15, 3.1) - vWorldPos);
  vec3 H = normalize(L + V);

  float ambient = 0.15;
  float diffuse = max(dot(N, L), 0.0);
  float specular = pow(max(dot(N, H), 0.0), uShininess);

  vec3 color = uBaseColor * (ambient + diffuse) + uLightColor * specular * 0.8;
  gl_FragColor = vec4(color, 1.0);
}
`;

/* ---------------- 示例 3：后处理（场景纹理 + 故障色差） ---------------- */

const POST_SCENE_MAIN = `// 后处理示例的场景层：一个随时间变化的彩色网格
uniform float uFrequency; // @range(2, 24, 1) @default(10)
uniform vec3 uColorA;      // @default(0.15, 0.1, 0.45)
uniform vec3 uColorB;      // @default(1.0, 0.45, 0.2)

void main() {
  vec2 grid = abs(fract(vUv * uFrequency) - 0.5);
  float line = smoothstep(0.48, 0.5, max(grid.x, grid.y));
  float pulse = 0.5 + 0.5 * sin(uTime * 2.0 + vUv.x * 6.0);
  vec3 color = mix(uColorA, uColorB, pulse);
  color += line * 0.25;
  gl_FragColor = vec4(color, 1.0);
}
`;

const POST_PASS = `// 后处理 pass：uScene 是引擎自动提供的场景纹理
uniform float uAberration; // @range(0, 0.02, 0.0005) @default(0.006)
uniform float uScanline;   // @range(0, 1, 0.01) @default(0.25)

void main() {
  vec2 uv = vUv;
  float amount = uAberration * (0.5 + 0.5 * sin(uTime * 3.0));
  float r = texture2D(uScene, uv + vec2(amount, 0.0)).r;
  float g = texture2D(uScene, uv).g;
  float b = texture2D(uScene, uv - vec2(amount, 0.0)).b;
  vec3 color = vec3(r, g, b);
  float scan = 1.0 - uScanline * 0.5 * step(0.5, fract(uv.y * uResolution.y * 0.5));
  gl_FragColor = vec4(color * scan, 1.0);
}
`;

/* ---------------- 示例 4：故意写错，演示错误处理 ---------------- */

const BROKEN_MAIN = `// 这个示例故意包含编译错误，演示错误处理流程：
//   - 编辑器行号槽把出错行标红，点击错误列表可跳转
//   - 画布不会闪成空白，而是保留上一次成功编译的画面
// 当前第 8 行使用了未声明的变量 uFoo；把它删掉/改成 uSpeed 后，
// 还能看到第 9 行 vec3 与 vec4 类型不匹配的第二个错误
uniform float uSpeed; // @range(0, 4, 0.1) @default(1.0)

void main() {
  float sweep = 0.5 + 0.5 * sin(uTime * uSpeed) + uFoo;
  vec3 color = vec4(sweep);
  gl_FragColor = vec4(color, 1.0);
}
`;

export interface Example {
  id: string;
  label: string;
  description: string;
  project: ProjectData;
}

export const EXAMPLES: Example[] = [
  {
    id: 'texture',
    label: '纹理：UV 流动',
    description: 'sampler2D 纹理上传、tiling/滚动与颜色 tint',
    project: makeProject(
      '示例-纹理',
      TEXTURE_MAIN,
      '',
      {
        uTexture: checker,
        uTiling: [3, 3],
        uScrollSpeed: 0.3,
        uMix: 0.35,
        uTint: [0.4, 0.7, 1.0],
      },
    ),
  },
  {
    id: 'lighting',
    label: '光照：Blinn-Phong',
    description: '法线 / 高光 / 轨道光源，网格预览下使用真实法线',
    project: makeProject(
      '示例-光照',
      LIGHT_MAIN,
      '',
      {
        uBaseColor: [0.2, 0.8, 0.6],
        uShininess: 32,
        uLightOrbit: 1,
        uLightColor: [1, 0.95, 0.85],
      },
    ),
  },
  {
    id: 'post',
    label: '后处理：色差扫描线',
    description: '两 pass 渲染，后处理通过 uScene 采样场景',
    project: makeProject(
      '示例-后处理',
      POST_SCENE_MAIN,
      POST_PASS,
      {
        uFrequency: 10,
        uColorA: [0.15, 0.1, 0.45],
        uColorB: [1, 0.45, 0.2],
        uAberration: 0.006,
        uScanline: 0.25,
      },
    ),
  },
  {
    id: 'broken',
    label: '错误处理演示（故意写错）',
    description: '编译失败时行号标红、错误可点击、画布保留上一帧',
    project: makeProject('示例-编译错误', BROKEN_MAIN, '', { uSpeed: 1 }),
  },
];
