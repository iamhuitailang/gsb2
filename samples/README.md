# 样例素材说明

`samples/` 内是可直接使用的样例素材，全部提交在仓库里，打开工具后点「载入样例」即可加载。

- **矢量图（SVG）**：仓库自带的 `materials/`、`reference/` 下的样例，浏览器原生栅格化，无需生成步骤。
- **TGA**：`materials/damaged_panel/damaged_panel_Normal.tga` 是一个**刻意损坏**的文本文件，
  用来演示"解码失败 → 常量补齐 / 批量导出失败项保留原因"。
- **光栅图（PNG/TGA）**：`npm run generate:samples` 会程序化生成同一套图案的 PNG/TGA 版本到
  `samples/raster/`，用于测试自带编解码器与无头导出 CLI；该目录不提交到仓库，也不会覆盖手写演示工程。

## 目录

```
samples/
├── materials/
│   ├── brick_wall/      砖墙：颜色 / 法线 / 粗糙度 / 金属度 / 高度 + AO（768×512，故意尺寸不一致）
│   ├── metal_plate/     金属板：板面 + 铆钉 + 焊缝，法线输出使用 DirectX
│   ├── wood_floor/      木地板：与砖墙输出同名，验证批量导出不覆盖；同材质内另有一个重名 ORM
│   └── damaged_panel/   损坏样例：正常颜色 + 损坏的 TGA 法线
├── reference/
│   ├── color_swatches.svg  8 色色卡
│   ├── normal_sphere.svg   法线参考球（OpenGL 方向）
│   └── gray_steps.svg      16 级灰阶阶梯
└── demo-project.json    四组材质的演示工程（「载入样例」使用）
```

## 各文件

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `brick_wall_Albedo.svg` | 1024×1024 | 颜色来源；打包到 BaseColor 的 R/G/B |
| `brick_wall_Normal.svg` | 1024×1024 | 法线来源；OpenGL 编码 |
| `brick_wall_Roughness.svg` | 1024×1024 | 灰度；ORM 的 G |
| `brick_wall_Metallic.svg` | 1024×1024 | 灰度；ORM 的 B |
| `brick_wall_Height.svg` | 1024×1024 | 灰度；HeightMask 的 R |
| `brick_wall_AO.svg` | **768×512** | 灰度；ORM 的 R。**与目标 1024×1024 不一致** |
| `metal_plate_*.svg` | 512×512 | 颜色 / 法线 / 粗糙度 / 金属度 / AO / 高度 |
| `wood_floor_*.svg` | 1024×512 | 颜色 / 法线 / 粗糙度 / 金属度 / AO，与砖墙输出同名 |
| `damaged_panel_Albedo.svg` | 256×256 | 正常颜色 |
| `damaged_panel_Normal.tga` | 256×256（损坏） | **损坏文件**，不是合法 TGA |
| `reference/color_swatches.svg` | 512×512 | 校验取色 / 通道打包 |
| `reference/normal_sphere.svg` | 512×512 | 校验法线方向与球面预览 |
| `reference/gray_steps.svg` | 512×512 | 校验反相 / 强度 / 灰度通道 |

## 错误与边界情况的演示

1. **尺寸不一致**：`brick_wall_AO.svg` 是 768×512，材质目标 1024×1024。
   - 默认「等比留边」：AO 等比放到 1024×683，上下用常量补齐；
   - 切到「缩放裁切 / 拉伸」可对比；
   - 右侧「来源说明」和预览警告都会写明实际处理方式。
2. **同名不覆盖**：砖墙、金属板、木地板都有 `BaseColor` / `Normal` / `ORM`，
   批量导出后分别位于各自材质目录，文件名不冲突。
3. **同材质内重名**：木地板有两个输出都叫 `ORM`，导出时第二个自动改名（`ORM_Custom`），
   并在 `manifest.txt` 的「命名冲突处理」中说明。
4. **解码失败**：`damaged_panel_Normal.tga` 不是合法 TGA。
   - 界面：该槽位标红，提示解码失败；预览中该通道用常量补齐；
   - 导出：`Normal` 输出失败并列出原因，同组的 `BaseColor` 仍然成功导出。

## 重新生成光栅样本

```bash
npm run generate:samples
```

脚本只依赖 Node 内置模块与仓库内的 `src/lib/png.js`，无需安装依赖；
会写出 PNG/TGA 版本的图案到 `samples/raster/`（用于无头导出 CLI 与编解码测试），
不会改动手写的 `demo-project.json` 与 SVG 样例。该目录不提交到仓库。
