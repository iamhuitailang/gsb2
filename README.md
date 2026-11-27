# neg2pos — 彩色负片扫描转正的本机检查工具

自己扫的彩色负片转正后灰纸发红棕, 多半是片基色罩(橙色片底)没校准。
本工具用**片底 + 参考灰块**做卷级校准, 单张微调高光/暗处, 并给出截断警示、
区域标记预览和可重放参数。纯本地运行, 依赖只有 numpy + Pillow。

## 转换模型

每通道独立: 密度 `d = -log2(n/B)`(n=扫描值, B=片底色), 灰块中性化去色罩,
影调映射 `p = 1 - 2^(-d/γf)`(γf=胶片特性指数), 再做黑/白点和 gamma 微调。

## 快速上手(无真实扫描件时先生成模拟负片)

```bash
# 1. 生成一卷模拟负片(可选片底色/张数/片边污点), 附带已知目标颜色 targets.json
python3 -m neg2pos gen --out /tmp/roll --frames 3 --base orange --stains 4

# 2. 卷级校准: 片边取片底(可多个矩形), 画面内取参考灰块
#    每个取样点给出 median/MAD, 污点污染的会被标"疑似异常", 用 --exclude 手工剔除
python3 -m neg2pos calibrate --image /tmp/roll/frame_00.png \
    --base-rect 2,2,18,18 --base-rect 618,458,18,18 --base-rect 300,2,18,18 \
    --gray-rect 44,304,72,72 --film-gamma 1.6 \
    --exclude 2,3 --out /tmp/roll/calib.json

# 3. 单张转正: 同卷共用 --calib; 单张微调曝光/黑点/白点/gamma
python3 -m neg2pos convert --image /tmp/roll/frame_01.png --calib /tmp/roll/calib.json \
    --exposure 0.7 --white 0.98 \
    --preview /tmp/roll/preview.png --out /tmp/roll/pos_01.png
#    输出: 正片 + 截断报告 + 标记预览(蓝=近片底, 红=过深, 品红=通道截断)
#         + pos_01.params.json(可重放参数, 含 roll/frame_delta/effective 三栏对照)

# 重放某张的全部参数:
python3 -m neg2pos convert --image /tmp/roll/frame_01.png \
    --params /tmp/roll/pos_01.params.json --out /tmp/roll/replay.png

# 4. 只做检查不出图: 截断警示 + 剩余层次 + 区域占比
python3 -m neg2pos analyze --image /tmp/roll/frame_02.png --calib /tmp/roll/calib.json

# 5. 与已知目标颜色对比(灰阶中性度 + 主要色块偏差)
python3 -m neg2pos chart --positive /tmp/roll/pos_01.png --targets /tmp/roll/targets.json

# 6. 批量: 单张失败不影响其他张, 结果逐条记录在 batch_results.json,
#    有失败时退出码为 1, 已成功的正片和参数文件保留可用
python3 -m neg2pos batch --indir /tmp/roll --calib /tmp/roll/calib.json --out /tmp/roll/out
```

## 真实扫描件怎么用

1. 无损彩色图(PNG/TIFF)直接读; 矩形参数都是 `x,y,w,h` 像素。
2. 片底取样: 在未曝光片边/片头取几个小矩形(`--base-rect` 可重复)。
3. 灰块取样: 拍进去的灰卡或已知中性灰物体(`--gray-rect`)。
4. `--film-gamma` 默认 1.0; 高光发闷可试 1.2–1.6, 用 `chart` 或灰阶目测判断。
5. 卷级校准存一次, 同卷所有张 `--calib` 引用; 单张增量存在各自的
   `*.params.json` 里, 与卷级的关系(roll / frame_delta / effective)随转换打印。

## 测试

```bash
python3 -m unittest discover tests -v
```
