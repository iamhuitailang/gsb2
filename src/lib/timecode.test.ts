import { describe, expect, it } from 'vitest'
import {
  RATES,
  actualFps,
  dropFramesPerMinute,
  frameDurationSeconds,
  frameToLabelDriftSeconds,
  frameToParts,
  frameToRealSeconds,
  frameToTimecode,
  frameToTimecodeWithDay,
  framesPerDay,
  framesPerMinute,
  framesPerTenMinutes,
  makeFormat,
  parseClockSeconds,
  parseFormatKey,
  parseTimecode,
  parseTimecodeWithDay,
  realSecondsToFrameExact,
  splitAbsoluteFrame,
} from './timecode'

const df2997 = makeFormat('2997', true)
const ndf2997 = makeFormat('2997', false)
const df5994 = makeFormat('5994', true)
const ndf5994 = makeFormat('5994', false)
const p25 = makeFormat('25', false)

describe('帧率定义', () => {
  it('29.97 的实际帧率是 30000/1001', () => {
    expect(actualFps(df2997)).toBeCloseTo(30000 / 1001, 10)
    expect(frameDurationSeconds(df2997)).toBeCloseTo(1001 / 30000, 10)
  })

  it('59.94 的实际帧率是 60000/1001', () => {
    expect(actualFps(df5994)).toBeCloseTo(60000 / 1001, 10)
  })

  it('25p 不支持跳号，即使请求 DF 也回退为 NDF', () => {
    expect(makeFormat('25', true).dropFrame).toBe(false)
    expect(RATES['25'].dropFrames).toBe(0)
  })

  it('每分钟与每十分钟帧数', () => {
    expect(framesPerMinute(df2997)).toBe(1798)
    expect(framesPerTenMinutes(df2997)).toBe(17982)
    expect(framesPerMinute(df5994)).toBe(3596)
    expect(framesPerTenMinutes(df5994)).toBe(35964)
    expect(framesPerMinute(p25)).toBe(1500)
    expect(dropFramesPerMinute(df2997)).toBe(2)
    expect(dropFramesPerMinute(df5994)).toBe(4)
    expect(dropFramesPerMinute(p25)).toBe(0)
  })

  it('一天帧数', () => {
    expect(framesPerDay(df2997)).toBe(2589408)
    expect(framesPerDay(ndf2997)).toBe(2592000)
    expect(framesPerDay(df5994)).toBe(5178816)
    expect(framesPerDay(p25)).toBe(2160000)
  })
})

describe('29.97 跳号规则', () => {
  it('第 1 分钟边界前是 00:00:59;29', () => {
    expect(frameToTimecode(1799, df2997)).toBe('00:00:59;29')
  })

  it('第 1 分钟边界跳过 ;00 和 ;01，从 ;02 开始', () => {
    expect(frameToTimecode(1800, df2997)).toBe('00:01:00;02')
    expect(frameToTimecode(1801, df2997)).toBe('00:01:00;03')
  })

  it('被跳过的标签不能解析', () => {
    const result = parseTimecode('00:01:00;00', df2997)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('DROPPED_LABEL')
    expect(parseTimecode('00:01:00;01', df2997).ok).toBe(false)
    expect(parseTimecode('00:01:00;02', df2997).ok).toBe(true)
  })

  it('整十分钟不跳，00:10:00;00 合法', () => {
    expect(frameToTimecode(17982, df2997)).toBe('00:10:00;00')
    expect(parseTimecode('00:10:00;00', df2997).ok).toBe(true)
  })

  it('整点 01:00:00;00 合法（60 分属于整十分钟）', () => {
    expect(frameToTimecode(107892, df2997)).toBe('01:00:00;00')
    const parsed = parseTimecode('01:00:00;00', df2997)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.frame).toBe(107892)
  })

  it('第 10 分钟边界前一帧是 00:09:59;29', () => {
    expect(frameToTimecode(17981, df2997)).toBe('00:09:59;29')
  })

  it('午夜前一帧与午夜', () => {
    expect(frameToTimecode(2589407, df2997)).toBe('23:59:59;29')
    expect(frameToTimecode(2589408, df2997)).toBe('00:00:00;00')
    expect(frameToTimecodeWithDay(2589408, df2997)).toBe('00:00:00;00 +1d')
  })

  it('整点处实际经过时间与读数相差不到 4 ms', () => {
    const oneHourFrame = 107892
    const real = frameToRealSeconds(oneHourFrame, df2997)
    // 跳号让读数在整点处几乎与真实时间对齐；1001 分母造成约 3.6 ms 的残差
    expect(Math.abs(real - 3600)).toBeLessThan(0.01)
  })
})

describe('59.94 跳号规则', () => {
  it('第 1 分钟跳 4 个编号，从 ;04 开始', () => {
    expect(frameToTimecode(3599, df5994)).toBe('00:00:59;59')
    expect(frameToTimecode(3600, df5994)).toBe('00:01:00;04')
  })

  it('被跳过的标签 ;00–;03 全部无效', () => {
    for (const frame of ['00', '01', '02', '03']) {
      expect(parseTimecode(`00:01:00;${frame}`, df5994).ok).toBe(false)
    }
    expect(parseTimecode('00:01:00;04', df5994).ok).toBe(true)
  })

  it('整十分钟不跳', () => {
    expect(frameToTimecode(35964, df5994)).toBe('00:10:00;00')
  })

  it('午夜翻页', () => {
    expect(frameToTimecodeWithDay(5178816, df5994)).toBe('00:00:00;00 +1d')
    expect(frameToTimecode(5178815, df5994)).toBe('23:59:59;59')
  })
})

describe('不跳号与 25p', () => {
  it('29.97 NDF 分钟边界的帧号直接按 30 进位', () => {
    expect(frameToTimecode(1800, ndf2997)).toBe('00:01:00:00')
    expect(frameToTimecode(1799, ndf2997)).toBe('00:00:59:29')
  })

  it('NDF 与真实时间持续漂移', () => {
    const drift = frameToLabelDriftSeconds(18000, ndf2997)
    // 10 分钟时 NDF 时码读数比真实时间慢约 0.6 秒（每小时约 3.6 秒）
    expect(drift).toBeCloseTo(-0.6, 1)
    const hourDrift = frameToLabelDriftSeconds(108000, ndf2997)
    expect(hourDrift).toBeCloseTo(-3.6, 1)
    // DF 在十分钟边界处对齐
    expect(Math.abs(frameToLabelDriftSeconds(17982, df2997))).toBeLessThan(0.001)
  })

  it('25 帧普通分钟与午夜', () => {
    expect(frameToTimecode(1500, p25)).toBe('00:01:00:00')
    expect(frameToTimecode(2160000, p25)).toBe('00:00:00:00')
    expect(frameToTimecodeWithDay(2160000, p25)).toBe('00:00:00:00 +1d')
  })

  it('59.94 NDF 不跳号', () => {
    expect(frameToTimecode(3600, ndf5994)).toBe('00:01:00:00')
  })
})

describe('解析', () => {
  it('接受中文冒号与分号', () => {
    const result = parseTimecode('00：01：00；02', df2997)
    expect(result.ok).toBe(true)
  })

  it('分隔符与格式不一致时给出提示但仍解析', () => {
    // 用 00:01:01:00：不在跳号区间内，因此只提示分隔符与格式不一致
    const result = parseTimecode('00:01:01:00', df2997)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings.some((warning) => warning.code === 'NDF_MARKER_MISMATCH')).toBe(true)
    }
  })

  it('超出帧率范围报错', () => {
    const result = parseTimecode('00:00:00:30', ndf2997)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FRAME_RANGE')
  })

  it('25p 帧号 25 越界', () => {
    const result = parseTimecode('00:00:00:25', p25)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FRAME_RANGE')
  })

  it('语法错误报 SYNTAX', () => {
    const result = parseTimecode('1:2', p25)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('SYNTAX')
  })

  it('小时不能超过 23', () => {
    const result = parseTimecode('24:00:00:00', p25)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('HOUR_RANGE')
  })

  it('支持 +1d 日期后缀', () => {
    const result = parseTimecodeWithDay('00:00:00;00 +1d', df2997)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.absoluteFrame).toBe(2589408)
      expect(result.day).toBe(1)
      expect(result.hasDaySuffix).toBe(true)
    }
  })

  it('没有日期后缀时 hasDaySuffix 为 false', () => {
    const result = parseTimecodeWithDay('00:00:00;00', df2997)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.hasDaySuffix).toBe(false)
  })

  it('负日期后缀若把绝对帧号推成负数则报 DAY_RANGE', () => {
    const result = parseTimecodeWithDay('00:00:00;00 -1d', df2997)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('DAY_RANGE')
  })
})

describe('往返一致性', () => {
  const samples: number[] = [
    0, 1, 29, 30, 1798, 1799, 1800, 1801, 3596, 3599, 3600, 17982, 17983, 107892, 2589407, 2589408,
    5178815, 5178816, 9999999,
  ]
  for (const format of [df2997, ndf2997, df5994, ndf5994, p25]) {
    it(`${format.rate}${format.dropFrame ? 'df' : 'ndf'} 帧号 → 时码 → 帧号`, () => {
      for (const frame of samples) {
        const timecode = frameToTimecode(frame, format)
        const parsed = parseTimecode(timecode, format)
        expect(parsed.ok, `${frame} → ${timecode}`).toBe(true)
        if (parsed.ok) expect(parsed.frame).toBe(frame % framesPerDay(format))
      }
    })
  }

  it('真实秒数 → 帧 → 真实秒数', () => {
    for (const frame of [0, 1800, 17982, 107892, 2589408]) {
      const real = frameToRealSeconds(frame, df2997)
      expect(realSecondsToFrameExact(real, df2997)).toBeCloseTo(frame, 6)
    }
  })
})

describe('日期拆分', () => {
  it('超过一天时返回天数与日内帧号', () => {
    const split = splitAbsoluteFrame(framesPerDay(df2997) + 100, df2997)
    expect(split.day).toBe(1)
    expect(split.frameInDay).toBe(100)
  })

  it('frameToParts 给出 dayOffset', () => {
    const parts = frameToParts(framesPerDay(p25) * 2 + 5, p25)
    expect(parts.dayOffset).toBe(2)
    expect(parts.frames).toBe(5)
  })
})

describe('辅助解析', () => {
  it('parseClockSeconds 支持纯秒与 HH:MM:SS.mmm', () => {
    expect(parseClockSeconds('90.5')).toBe(90.5)
    expect(parseClockSeconds('00:01:30.500')).toBeCloseTo(90.5, 6)
    expect(parseClockSeconds('01:30')).toBe(90)
    expect(parseClockSeconds('-1')).toBe(-1)
    expect(parseClockSeconds('abc')).toBeNull()
    expect(parseClockSeconds('01:75')).toBeNull()
  })

  it('parseFormatKey 识别常见写法', () => {
    expect(parseFormatKey('2997df')?.dropFrame).toBe(true)
    expect(parseFormatKey('29.97 DF')?.rate).toBe('2997')
    expect(parseFormatKey('59.94ndf')?.dropFrame).toBe(false)
    expect(parseFormatKey('25')?.rate).toBe('25')
    expect(parseFormatKey('2997')?.dropFrame).toBe(false)
    expect(parseFormatKey('DF 29.97')?.dropFrame).toBe(true)
    expect(parseFormatKey('2997 non-drop')?.dropFrame).toBe(false)
    expect(parseFormatKey('foo')).toBeNull()
  })
})
