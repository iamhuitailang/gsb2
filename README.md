# mp4rescue —— 分段 MP4 崩溃录像抢救工具

录屏程序崩溃后,磁盘上常留下只写了一半的分段 MP4(fragmented MP4, fMP4):
整文件无法播放,但前面若干分段其实是完好的。本工具用纯 Python 解析 ISO-BMFF
盒子结构,调用本机 ffmpeg 完成重封装与解码校验,把**最后一个完整且可解码的
连续分段前缀**抢救成普通播放器能打开的 MP4。

> 范围限定:只处理本工具自己生成的 fMP4(`empty_moov + moof/mdat` 结构)。
> 起始说明盒子 `moov` 缺失或自身被截断时,无法知道轨道与编码配置,直接拒绝修复。

## 环境要求

- Python 3.10+(用到 `X | None` 类型语法),依赖 Pillow 渲染测试画面
- 本机安装 ffmpeg / ffprobe(需含 libx264 与 AAC 编码器)

```bash
python3 -c "import PIL"            # 没有则: python3 -m pip install pillow
ffmpeg -version | head -1
```

## 一分钟上手

```bash
# 1. 生成标准片与全部中断/异常样例(输出到 samples/)
python3 -m mp4rescue generate -o samples

# 2. 只扫描,查看每段播放时间、轨道、断点位置,不导出
python3 -m mp4rescue scan samples/break_mdat.mp4

# 3. 批量抢救(可传多个文件或目录),每份独立出报告,一个坏了不影响其它
python3 -m mp4rescue rescue samples -o rescued
```

## 生成的样例

| 文件 | 含义 | 预期抢救结果 |
| --- | --- | --- |
| `good.mp4` | 完整标准片(12s,画面带帧号,每秒一声蜂鸣) | 全部 13 段导出 |
| `break_moof.mp4` | 断在第 5 段的分段说明 `moof` 内部 | 导出前 4 段 |
| `break_mdat.mp4` | 第 5 段 `moof` 完整,断在画面数据 `mdat` 内部 | 导出前 4 段,报告数据缺口字节数 |
| `boundary.mp4` | 恰好写完第 5 段后中断 | 导出全部 5 段,无残骸 |
| `gap.mp4` | 第 5 段整体丢失(mfhd 序号 4→6) | 识别掉段,只导连续前 4 段 |
| `duplicate.mp4` | 第 4 段被重复插入(mfhd 序号 4 出现两次) | 识别重复,只导连续前 4 段 |
| `audio_short.mp4` | 末段只有视频 traf,音频比视频早停一整段 | 报告音频实际停点 |
| `no_moov.mp4` | ftyp/moov 全丢 | 拒绝修复 |
| `not_mp4.bin` | 根本不是 MP4 | 拒绝修复 |

## 报告说明

每个被抢救的文件在输出目录产生三份产物:

- `<name>.rescued.mp4` —— 普通 MP4(`+faststart`,播放器直接打开)
- `<name>.rescued.fmp4` —— 抢救出的原始连续字节前缀(未重封装,便于审计)
- `<name>.report.txt` / `<name>.report.json` —— 文字与机器可读报告

报告包含:

1. **轨道清单**:moov/trex 声明的音视频轨道、timescale、分辨率;
2. **分段明细**:每个 moof 的 mfhd 序号、字节范围、状态(完整 / 断在 moof /
   断在 mdat / mdat 缺失),以及每条轨道在该段的样本数、**全局播放时间区间**、
   占用 mdat 字节数;
3. **断点定位**:断在哪个子盒子、mdat 声明与实际可读字节的缺口;
4. **连续性检查**:按 mfhd 全局序号识别掉段(序号跳变)、重复段(序号重复)、
   乱序(序号倒退);
5. **导出计划**:连续前缀包含的分段数与字节切分点;
6. **停点与校验**:ffmpeg 全量解码结果,以及音频相对视频的实际停点
   (0.15s 阈值用于排除 AAC priming 等编码器固有延迟)。

## 关键设计决策

- **连续前缀,绝不跨缺口拼接**。导出字节范围固定为 `[0, cut_offset)`,
  掉段/重复段之后的内容不会被"接"到前面,输出时间线在切点处自然结束。
- **tfdt 是段内相对时间**(本工具生成的 fMP4 每段 tfdt 重置),全局播放时间
  由各 traf 的样本时长逐段累计得到,报告中两者同时展示。
- **某轨道合法缺席分段**(如末段只有音频/视频)不判为故障;连续性以 moof 级
  mfhd 序号为准。
- **批量隔离**:`rescue_batch` 对单文件异常兜底捕获,坏文件只产生拒绝报告,
  不中断其余文件处理。
- **解析层零第三方依赖**:`mp4rescue/boxes.py` 只用标准库,便于审计;
  ffmpeg 仅通过子进程调用,路径经 `shutil.which` 解析。

## 代码结构

```
mp4rescue/
  boxes.py       ISO-BMFF 盒子解析(含截断盒子识别)
  scanner.py     分段/轨道建模、断点与连续性分析、导出切点计算
  generator.py   标准片渲染与字节级中断样例派生
  ffmpeg_wrap.py ffmpeg/ffprobe 子进程封装(重封装、解码校验、音频停点)
  rescue.py      抢救执行、文字/JSON 报告、批量隔离
  cli.py         命令行入口(generate / scan / rescue)
tests/
  test_end_to_end.py  覆盖六项需求的集成测试
```

## 测试

```bash
python3 -m pytest tests/ -q
```
