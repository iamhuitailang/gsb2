# 游戏对话文字排版试验台

一个零依赖、纯前端的对话文本排版实验页。解决游戏对话逐字播放时，表情、组合字符、
标点和强调样式被切碎、换行错位、停顿难调的问题。直接用浏览器打开 `index.html` 即可，
无需构建、无需服务器。

## 快速开始

```bash
# 方式一：直接双击 index.html，或
open index.html

# 方式二：起一个静态服务（可选）
python3 -m http.server 8080
# 浏览器访问 http://localhost:8080
```

## 功能与需求对照

| # | 需求 | 实现 |
|---|------|------|
| 1 | 录入文本/样式/停顿，错误标位置，正常文字可预览 | `js/parser.js` 容错解析；错误给出行:列与所在行原文，错误片段回退为字面量，预览不中断 |
| 2 | 中英混排指定宽度换行，组合字符/emoji 不拆 | `js/grapheme.js`（Intl.Segmenter + 回退）+ `js/layout.js` 贪心排版，字形为最小不可拆单位 |
| 3 | 比较字号/行宽/字间距，定位放不下的词与超长文本 | 「多配置对照」三视图；`overflows`/`warnings` 带原文位置，点击问题项可闪烁定位 |
| 4 | 播放可停/跳字/全文，改尺寸进度对应 | `js/player.js` 以「已显示字形数」为唯一进度；重排版自动续播，charIndex 稳定对应 |
| 5 | 保存多套配置，导出每页文字/停顿/行位置 | localStorage 预设；`js/exporter.js` 导出完整 JSON，可复制或下载 |
| 6 | 本地混合标点/emoji/长词/停顿示例 | `js/samples.js` 三个内置样本（正常、含错误、窄行/长词/分页） |

## 标记语法

| 写法 | 含义 |
|------|------|
| `[b]…[/b]` `[i]…[/i]` `[u]…[/u]` | 加粗 / 斜体 / 下划线 |
| `[color=red]…[/color]` | 颜色：命名色或 `#rgb` / `#rrggbb` |
| `[size=22]…[/size]` | 局部字号（8–200px） |
| `[wait=300]` | 停顿 300 毫秒，逐字播放时等待 |
| `[pause]` | 默认时长停顿 |
| `[br]` 或真实换行 | 强制换行 |
| `[page]` | 分页，导出数据中独立成页 |
| `[[` | 字面量方括号 `[` |

## 排版规则要点

- **不可拆单位**：组合字符（`café`）、ZWJ emoji 家族（`👨‍👩‍👧`）、带肤色 emoji、
  国旗（`🇨🇳`）整体作为一个字形，测量、换行、播放都不拆开。
- **断行**：拉丁连续串按整词搬运；词本身宽过整行时逐字硬排并逐个记录溢出；
  CJK 逐字断行；半角空格在行首折叠。
- **避头尾（kinsoku）**：`。，、！？）」』` 等不允许出现在行首（把前一字拉下一行）；
  `（「『` 等不允许落在行尾。
- **溢出定位**：任何超出 `lineWidth` 的字形都会进入 `overflows`，预览中红色虚线框标注，
  右侧问题面板点击即闪烁定位并滚动到该处。

## 导出数据结构

`exporter.buildExport(parsed, layout)` 产出：

```jsonc
{
  "version": 1,
  "layout": { "fontSize": 18, "lineWidth": 420, "letterSpacing": 1, "...": "..." },
  "summary": { "pages": 1, "chars": 163, "waits": 2, "overflowCount": 0 },
  "errors": [ { "line": 3, "col": 1, "message": "...", "srcStart": 0, "srcEnd": 3 } ],
  "overflows": [ { "reason": "grapheme-wider-than-line", "charIndex": 12, "line": 2, "...": "..." } ],
  "pages": [
    {
      "page": 0,
      "text": "每页纯文本",
      "lines": [
        { "index": 0, "top": 0, "width": 400, "height": 28.8,
          "chars": [ { "charIndex": 0, "text": "你", "x": 0, "y": 0, "width": 19,
                       "style": { "bold": true }, "srcStart": 3, "srcEnd": 4 } ] }
      ]
    }
  ],
  "markers": [
    { "type": "wait", "durationMs": 350, "afterCharIndex": 12,
      "position": { "page": 0, "line": 1, "x": 200, "y": 28.8 } },
    { "type": "page", "durationMs": null, "afterCharIndex": 80, "position": { "...": "..." } }
  ]
}
```

游戏侧按 `pages[].lines[].chars[]` 的 `x/y/width` 摆放字形，按 `markers` 在
`afterCharIndex` 之后插入等待或翻页即可还原逐字播放与最终版面。

## 代码结构

```
index.html            页面骨架
css/styles.css        暗色主题与布局
js/grapheme.js        字形切分（Intl.Segmenter，含正则回退）
js/parser.js          容错标记解析（错误带行列位置）
js/layout.js          测量 + 贪心换行 + 避头尾 + 溢出定位
js/renderer.js        绝对定位渲染（播放只切显隐，不重排）
js/player.js          逐字播放器（播放/暂停/seek/全文）
js/exporter.js        导出 JSON
js/storage.js         预设与草稿的 localStorage 持久化
js/samples.js         内置示例
js/app.js             主控制器
test/run-tests.js     Node 核心逻辑测试（桩 canvas）
test/browser-smoke.js CDP 浏览器冒烟测试（真实 Chrome）
```

## 测试

```bash
# 核心逻辑：字形/解析/排版/导出/播放，26 个断言，无需浏览器
node test/run-tests.js

# 浏览器冒烟：真实 Chrome 经 CDP 驱动，覆盖渲染、播放交互、改尺寸续播、导出、预设
node test/browser-smoke.js
# 产出 test/smoke.png 截图
```

## 设计取舍

- **绝对定位渲染**：每个字形一个 `span`，播放仅切换 `opacity`，布局永不重排，
  因此播放途中改字号/行宽，进度（已显示字形数）与文字始终按 `charIndex` 对应。
- **canvas 测量**：用 `CanvasRenderingContext2D.measureText` 取字形本身宽度，
  字间距只在 x 步进累加，避免与 CSS `letter-spacing` 双重计算。
- **容错优先**：解析器对任何坏标记都不抛错，回退为可见字面量并同时记录问题，
  保证「正常文字仍可预览」。
