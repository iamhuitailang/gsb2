# 横转竖取景重排工具 (reframer)

把横屏讲解片重排成 9:16 竖版的 Python + ffmpeg 工具。台上两个人轮流讲话时,
竖版取景框由关注框轨迹自动驱动: 同镜头内平滑跟随、跨镜头硬切, 带限速/迟滞/
驻留, 不会在两个说话人之间快速来回晃。

只依赖 **Python 3 标准库 + 系统 ffmpeg/ffprobe**, 无第三方包。

## 解决的核心问题

- 裁切框跟快了会晃、跟慢了人出画 —— 用"迟滞 + 驻留 + 限速"的一维平滑器;
- 两人同框 / 单人跟随 / 无数据留边 —— 每帧显式记录取景策略, 界面可提前知道;
- 必留对象和字幕安全区 —— 作为硬约束夹取裁框, 冲突时告警;
- 预览和成片不一致 —— 两者共用同一份逐帧裁框数据, 并有逐帧校验;
- 想局部改取景 —— 时间表可重开编辑, 原片和原始轨迹都不动。

## 目录结构

```
reframer/
  model.py       数据模型 (Rect/KF/Track/Shot/SafeZone)
  tracks.py      关注框轨迹读写、逐时刻线性插值、null 区间语义
  planner.py     核心: 目标取景 + 硬约束 + 平滑/硬切 + 关键帧压缩
  expr.py        把时间表编译成 ffmpeg 表达式 (crop 用 n, drawbox 用 t)
  samplegen.py   生成带编号方块的样例横片 + 轨迹 (纯 ffmpeg 滤镜)
  render.py      横版预览 / 横竖对照 / 竖版导出 / 抽帧联系表
  verify.py      转场帧归属、逐帧裁框一致性、音视频保留检查
  timeline.py    时间表二次编辑 (人工取景点、限速参数)
  report.py      静态 HTML 报告 (内联 SVG 时间轴 + 联系表)
  cli.py         命令行入口
run.py           入口包装 (支持 python3 -I 隔离模式)
tests/           24 个单元/集成测试
```

## 快速开始

```bash
# 0. 确认 ffmpeg 可用
ffmpeg -version

# 1. 生成样例: 带编号 1/2 的两个方块、一次镜头硬切、2 号短暂出画、字幕安全区
python3 -I run.py sample out/
#   -> out/sample.mp4 (1280x720, 30fps, 12s, 带音频)
#   -> out/sample_tracks.json

# 2. 由关注框轨迹生成取景时间表
python3 -I run.py plan out/sample_tracks.json -o out/schedule.json

# 3. 横版预览 (能看到竖版取景框移动、关注框、安全区)
python3 -I run.py preview out/schedule.json -o out/preview.mp4

# 3b. 横竖对照 (左边带框横版, 右边竖版成片, 逐帧同源)
python3 -I run.py compare out/schedule.json -o out/compare.mp4

# 4. 导出竖版 (保留原音和完整时长)
python3 -I run.py export out/schedule.json -o out/vertical.mp4

# 5. 对照检查: 转场帧用哪套裁框 + 逐帧一致性 + 音视频
python3 -I run.py verify out/schedule.json out/vertical.mp4 --json out/verify.json

# 6. HTML 报告 (取景轨迹 SVG、策略分段、事件、联系表)
python3 -I run.py report out/schedule.json -o out/report.html \
    --vertical out/vertical.mp4 --sheet-video out/vertical.mp4
```

## 时间表二次编辑 (原片不动)

```bash
# 查看分段和已有人工取景点
python3 -I run.py edit out/schedule.json --list

# 在 5~7s 区间把取景中心钉到归一化 x=0.8 (硬约束仍优先, 会自动夹到可行域)
python3 -I run.py edit out/schedule.json \
    --add-override 5.0 7.0 0.80 --name fix1

# 调整平滑参数后整体重算
python3 -I run.py edit out/schedule.json --max-speed 200 --dwell 0.3 -o fast.json

# 删除某段人工取景
python3 -I run.py edit out/schedule.json --remove-override fix1
```

编辑后重新 `export` 即可, 原始 `sample.mp4` 和 `sample_tracks.json` 不会被修改。

## 输入文件格式 (tracks.json)

```json
{
  "schema": "reframer.tracks/v1",
  "source": "sample.mp4",
  "width": 1280, "height": 720, "fps": 30, "duration": 12.0,
  "tracks": [
    {
      "id": "p1", "label": "1号", "required": true,
      "keyframes": [
        {"t": 0.0, "rect": {"x": 0.10, "y": 0.34, "w": 0.11, "h": 0.29}},
        {"t": 3.0, "rect": null}
      ]
    }
  ],
  "shots": [{"start": 0.0, "end": 6.0, "transition": "cut"}],
  "safe_zones": [
    {"name": "字幕安全区", "rect": {"x": 0.70, "y": 0.86, "w": 0.12, "h": 0.13}}
  ],
  "speakers": {"p1": [[0.0, 2.0]], "p2": [[2.0, 4.2]]},
  "config": {"motion": {"max_speed_px_s": 360, "hysteresis_px": 42,
                        "dwell_s": 0.45, "margin_frac": 0.12, "no_data": "hold"}}
}
```

- 矩形坐标全部归一化到 0..1; 关键帧之间线性插值。
- `rect: null` 表示该时刻起关注框消失, 直到下一个非 null 关键帧。
- `shots[].transition`: `cut` (跨镜头硬切) 或 `smooth` (同镜头平滑移动)。
- `required: true` 的对象和 `safe_zones` 是硬约束, 无法同时满足时写 warning。
- `speakers` 标记谁在说话; 视野装不下两人时优先跟当前说话人。

## 取景策略 (写入 schedule.json 的 segments/events)

| 策略 | 触发条件 |
|------|----------|
| `both` | 两人(含留白)能同时装进竖框, 合框居中 |
| `speaker` | 装不下, 跟当前说话人 |
| `required` | 装不下且没人说话, 保必留对象 |
| `fallback` | 所有关注框暂时无数据, 原地/贴边留边 |
| `manual` | 落在人工取景点区间 |
| `cut` | 跨镜头硬切 (裁框在切点直接跳, 不插值) |

`no_data` 支持 `hold` (原地保留) 和 `edge_hold` (贴边留边)。

## 预览与成片为什么能严格一致

时间表只存一份裁框关键帧, 渲染层编译成两条同源表达式:

- **成片** `crop` 滤镜: ffmpeg 的 crop 求值器支持帧号变量 `n`, 按帧分段;
- **预览** `drawbox` 滤镜: drawbox 求值器只认时间变量 `t`, 改用帧网格
  时间 `n/fps` 作分支边界, 与 crop 的 `n` 分支严格等价。

表达式过长时自动回退到 `sendcmd` 逐帧指令文件。

`verify` 用时间表坐标从原片现裁一帧 (rawvideo), 与成片同帧的**亮度平面**
逐字节对比: 正确裁框差异 <2.5%, 裁错位置 ≥6.8%, 阈值 3% 严格区分。

## 运行测试

```bash
python3 -I -c "import sys; sys.path.insert(0,'.'); \
  import unittest; unittest.TextTestRunner(verbosity=2).run( \
  unittest.defaultTestLoader.discover('tests'))"
```

集成测试会真实调用 ffmpeg 跑通 样例→规划→预览→导出→校验→报告 全链路;
无 ffmpeg 时自动跳过。
