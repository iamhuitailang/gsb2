# 本地视频颜色表（LUT）检查与导出工具

面向剪辑/调色现场的本地 Python 工具，用来核对剪辑发来的多版 `.cube`
颜色表，重点排查“灰色正常、一上肤色就偏色”这类问题。零网络、零账号，
全部计算在本地完成。

## 依赖

`numpy`、`opencv-python`、`Pillow`，GUI 用标准库 `tkinter`，无需 Qt。

```bash
pip install -r requirements.txt
```

## 启动

```bash
# 图形界面（原片/套表/差值三联同步 + 探针）
python3 run_gui.py

# 命令行（无头环境/自动化）
python3 lut_tool.py --help
```

建议在隔离模式下运行，避免被工作目录中的同名模块干扰：

```bash
python3 -I lut_tool.py check examples/samples/warm_skin_shift_PROBLEM.cube
```

## 模块结构

| 文件 | 职责 |
| --- | --- |
| `lut_tool/cube.py` | `.cube` 文本解析（1D/3D、DOMAIN、注释），错误精确定位到行 |
| `lut_tool/lut.py` | 1D 逐通道插值、3D 三线性插值、双表串联/换序、范围与钳位标记 |
| `lut_tool/patterns.py` | 程序生成测试短片（灰阶/边界高饱和/平滑过渡/肤色/运动） |
| `lut_tool/analysis.py` | 颜色突变、通道串扰与通道互换检测 |
| `lut_tool/video.py` | 视频读写、8-bit 量化隔离、编码往返检查 |
| `lut_tool/config.py` | 两套比较配置存取、加载失败保留旧表 |
| `lut_tool/app.py` | Tkinter 三联画面、同步播放、探针、导出 |
| `lut_tool/cli.py` | 命令行入口 |

## 统一颜色约定

全链路内部一律使用 **float64、RGB 通道顺序、归一化 [0,1]**；OpenCV 的
BGR uint8 只在视频读写边界转换一次，8-bit 量化在最终边界完成。因此预览、
探针、导出后读回的数值可以直接比较，不会出现通道约定不一致。

## 六项需求对应说明

1. **读 1D/3D 表、显示适用范围、定位问题行**
   - `parse_cube` 支持 `LUT_1D_SIZE` / `LUT_3D_SIZE` 与 `DOMAIN_MIN/MAX`；
   - 行数不符、坏 token、列数不对都抛出带 1 起始行号和原文的 `CubeParseError`；
   - GUI 表区与 `lut_tool.py info` 直接显示输入适用范围。

2. **原片/套表/差值三联，播放位置锁同一帧**
   - 三个画面共享一个帧索引，滑块、步进、播放全部同步；
   - 差值为固定量程 [0,1] 的彩色热力图，附均值/最大差统计；
   - 测试片含运动球与扫掠条，帧不同步会立刻肉眼可见。

3. **探针看入表/出表数值、双表换序、标出超范围像素**
   - 点击任一画面即可在该像素追加探针，显示入表 RGB、出表 RGB 与状态；
   - 勾选“交换应用顺序 (B→A)”即可换序，两级越界分别记录（`oor_stage`）；
   - 超出表 `DOMAIN` 的像素用品红标记，输出被钳位的像素用橙色标记。

4. **中性灰阶、边界高饱和、平滑过渡；查突变与通道串换**
   - 测试片一帧内含 11 级灰阶、8 色边界高饱和条、R/G/B 纯通道斜坡、6 档肤色；
   - `analysis` 用差分尖峰抓 banding，用相关 + 增益判据区分“轻微串扰”
     和“整通道互换”（只看相关会把轻微联动误报成互换，已做回归测试）。

5. **导出后回查实际颜色，标出编码可见差异**
   - `export_and_verify` 写出后逐帧读回，把误差拆成 **8-bit 量化误差**
     （理论下限）和 **编码器附加误差** 两部分；
   - 超过阈值（默认 2/255）的帧逐帧列出；读回与预览共用同一颜色约定；
   - 提供 `mp4v` / `avc1`（有损）与 `FFV1`（无损，编码附加误差≈0）。

6. **保存两套比较配置，加载失败保留旧效果**
   - 槽位 A/B 各自记录两张表路径与是否换序，原子写入 JSON；
   - `SafeLutLoader` 加载失败时不清空上一张有效表，界面继续显示旧效果，
     错误信息单独展示，不影响另一张表。

## 示例素材

`python3 -I examples/make_samples.py` 生成到 `examples/samples/`：

- `identity_1d/3d.cube`：恒等表，基线；
- `warm_skin_shift_PROBLEM.cube`：灰色不动、暖区/肤色明显偏色（复现现场问题）；
- `rb_swap_PROBLEM.cube`：R/B 整通道互换；
- `banded_1d_PROBLEM.cube`：8 级量化造成的 banding；
- `narrow_domain_1d.cube`：窄输入域，用于范围外标记；
- `broken_*.cube`：行数不符、坏 token、列数不对的损坏样本。

## 常用命令

```bash
# 表信息与适用范围
python3 lut_tool.py info examples/samples/identity_3d.cube

# 表体诊断（单调性/突变/串换/越界）
python3 lut_tool.py check examples/samples/warm_skin_shift_PROBLEM.cube

# 探针：灰阶 + 肤色的入表/出表
python3 lut_tool.py probe examples/samples/warm_skin_shift_PROBLEM.cube

# 生成测试片并检查编码往返
python3 lut_tool.py testclip /tmp/clip.mp4 --codec mp4v --json

# 双表三联对照（换序加 --swap）
python3 lut_tool.py compare /tmp/cmp.mp4 \
    --first examples/samples/banded_1d_PROBLEM.cube \
    --second examples/samples/warm_skin_shift_PROBLEM.cube

# 两套配置
python3 lut_tool.py config save --slot A --first a.cube --second b.cube --file cfg.json
python3 lut_tool.py config show --file cfg.json
```

## 测试

```bash
python3 -I -m unittest discover -s tests -v
```

31 个用例覆盖解析与错误定位、插值、双表换序、范围/钳位标记、突变与
通道串换、编码往返、配置存取与加载容错，以及 GUI 的无头冒烟流程。
