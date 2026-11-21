'use strict';
/* 临时验证脚本：预设在不同屏幕/状态下的问题分布 */
global.self = global;
require('../js/model.js');
require('../js/engine.js');
require('../js/presets.js');

var M = global.ULCModel, E = global.ULCEngine, P = global.ULCPresets;

function fakeMeasure(n) {
  if (n.type === 'icon') return { w: 20, h: 20 };
  if (n.type === 'bar') return { w: n.width.value || 120, h: n.barHeight || 12 };
  if (n.type === 'edge') return { w: 40, h: 2 };
  if (n.type === 'panel') return { w: 40, h: 24 };
  var str = n.textVar === 'nickname' ? (n.text === '勇者' ? '勇者' : '屠龙者·暴风剑圣阿尔法雷德') : (n.text || '');
  // 近似浏览器：中文全角 13px、ASCII 半角 7px
  var len = 0;
  for (var i = 0; i < str.length; i++) len += str.charCodeAt(i) > 255 ? 13 : 7;
  return { w: Math.max(20, len + 4), h: 18 };
}
var vars = { paused: false, rightSidebarVisible: true, nicknameLong: false, hp: 72, sfxOn: true, musicOn: true };

function run(name, nodes, w, h, overrides) {
  var v = Object.assign({}, vars, overrides);
  var r = E.solveLayout(nodes, { w: w, h: h, safe: { top: 0, right: 0, bottom: 0, left: 0 } }, v, fakeMeasure);
  console.log('\n== ' + name + ' (' + w + 'x' + h + ')', JSON.stringify(overrides || {}));
  console.log('stats:', JSON.stringify(r.stats), ' hidden:', r.hiddenIds.length);
  r.issues.forEach(function (i) { console.log('  [' + i.kind + ']', i.message); });
}

var conflict = P.conflict();
run('冲突预设', conflict, 320, 568, { nicknameLong: true });
run('冲突预设', conflict, 320, 568, {});
run('冲突预设', conflict, 430, 932, {});
run('冲突预设-横屏', conflict, 844, 390, {});
run('冲突预设-暂停', conflict, 320, 568, { paused: true });
run('冲突预设-隐藏右侧栏', conflict, 320, 568, { rightSidebarVisible: false, paused: true });

var healthy = P.healthy();
run('健康预设', healthy, 320, 568, { nicknameLong: true });
