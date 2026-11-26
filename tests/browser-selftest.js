/*
 * browser-selftest.js — headless 自检钩子（普通打开页面时不产生任何行为）
 *
 * 由 scripts/browser_test.sh 通过 URL 参数 ?selftest=1 激活，
 * app.js 启动后调用 window.STEREO_SELFTEST.run(api)，
 * 本文件再按需动态 import 真正的用例 tests/cases.js。
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  if (!params.has('selftest')) return;

  window.STEREO_SELFTEST = {
    run: function (api) {
      import('../tests/cases.js').then(function (mod) {
        return mod.default(api);
      }).then(function (results) {
        var el = document.getElementById('selftest');
        el.hidden = false;
        el.textContent = JSON.stringify({ ok: results.every(function (r) { return r.ok; }), results: results });
        el.setAttribute('data-done', '1');
        console.log('SELFTEST_RESULT ' + JSON.stringify(results));
      }).catch(function (err) {
        var el = document.getElementById('selftest');
        el.hidden = false;
        el.textContent = JSON.stringify({ ok: false, fatal: String(err && err.stack || err) });
        el.setAttribute('data-done', '1');
        console.error('SELFTEST_FATAL', err);
      });
    }
  };
})();
