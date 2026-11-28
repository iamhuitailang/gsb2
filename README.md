# gsb2

## 三路分频实验 `crossover_lab.py`

纯软件验证: 一段声音拆成低/中/高三路后, 能否按各自延迟对齐拼回原样。

分频方案为线性相位 FIR 互补分频, 恒等式
`delay(low, D) + mid + high == delay(x, 2D)` 成立(D = (taps-1)/2),
因此默认对齐下合成与原声仅差一个已知总延迟 2D, 残差在浮点/存储精度量级。

```bash
# 一键完整实验(生成信号 -> 分频 -> 检查 -> 重读核对), 13 项自检
python3 crossover_lab.py demo --out demo_out

# 分步使用
python3 crossover_lab.py gen --out gen --fs 48000 --f1 300 --f2 3000
python3 crossover_lab.py split --in gen/tones.wav --out out/tones --f1 300 --f2 3000
python3 crossover_lab.py verify --dir out/tones

# 人为错位: 中路反相 + 高路挪 7 个样本, 报告会分开列出固有延迟与引入的错位
python3 crossover_lab.py split --in gen/stereo_mix.wav --out out/t \
    --invert mid --shift high=7
```

- `split` 导出 `low/mid/high.wav`(已对齐, 可直接试听) + `sum_aligned.wav` + `report.json`
- 头尾规则: 因果滤波头部补零, 所有导出长度 == 输入长度, 尾部截断;
  误差参考 = 原声延迟总延迟后截到同长
- 所有 wav 写 float32, 报告中的差值以写盘数据为准, `verify` 重读可精确核对
