/*
 * 本地内置示例。打开页面即可对照「逐字播放」与「最终版面」。
 */
(function (global) {
  'use strict';

  const SAMPLES = [
    {
      id: 'mixed',
      name: '中英混排 + emoji + 停顿',
      text:
        '[b]勇者营地 · 夜晚[/b]\n' +
        '艾琳推开木门，篝火「噼啪」作响。👋\n' +
        '她说：[wait=350]"You’re late, 旅行者 —— 大家都等急了！"\n' +
        '桌上摆着🍞、🍖和一杯热气腾腾的☕，旁边还有一张[color=gold][b]藏宝图[/b][/color]。\n' +
        '提示：输入 [i]/goto castle[/i] 可以前往 Castle of No-Return，[wait=200]名字很长但值得一去。\n' +
        '[pause]\n' +
        '（组合字符测试：café、café、👨‍👩‍👧、🇨🇳、🙋🏽‍♀️）'
    },
    {
      id: 'errors',
      name: '含错误标记（定位演示）',
      text:
        '这一段有几处错误，但正常文字仍然可以预览。\n' +
        '[b]加粗忘记闭合\n' +
        '[color=notacolor]错误的颜色[/color]\n' +
        '多余的闭合标记在这里：[/i]\n' +
        '[wait] 缺少时长参数\n' +
        '[size=999]字号超范围[/size]\n' +
        '正确的停顿 [wait=120] 与 [i]斜体[/i] 不受影响。'
    },
    {
      id: 'overflow',
      name: '窄宽度 / 长词 / 分页',
      text:
        '[b]窄行宽压力测试[/b]\n' +
        'Supercalifragilisticexpialidocious 是一个很长的英文词，用来验证整词换行与逐字溢出定位。\n' +
        '中文连续文本在窄行宽下应逐字自然换行，emoji 如 🎮👾🕹️ 永远作为一个整体移动，不会被拆开。\n' +
        '[page]\n' +
        '第二页：标点避头尾测试 —— 「引号」、（括号）和省略号……都不应出现在行首或被切碎。\n' +
        '[wait=500]停顿之后继续播放。'
    }
  ];

  global.TT = global.TT || {};
  global.TT.samples = SAMPLES;
})(typeof window !== 'undefined' ? window : globalThis);
