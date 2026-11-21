/* 浏览器冒烟测试：通过 CDP 加载页面，收集 JS 异常并验证关键交互 */
'use strict';
const http = require('http');

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9222' + path, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let msgId = 0;

async function main() {
  const targets = await getJSON('/json');
  const page = targets.find(t => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const errors = [];
  const logs = [];
  const pending = new Map();

  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception
        ? m.params.exceptionDetails.exception.description
        : m.params.exceptionDetails.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + m.params.args.map(a => a.value || a.description).join(' '));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      logs.push(m.params.entry.text);
    }
  };

  await new Promise(r => ws.onopen = r);
  function send(method, params) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise(r => pending.set(id, r));
  }

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://localhost:8765/index.html' });
  await sleep(2500);

  const checks = await send('Runtime.evaluate', {
    expression: `(() => {
      const out = {};
      out.treeRows = document.querySelectorAll('.tv-row').length;
      out.previewNodesA = document.querySelectorAll('#preview-a .pv-node').length;
      out.previewNodesB = document.querySelectorAll('#preview-b .pv-node').length;
      out.issueItems = document.querySelectorAll('.iss-item, .iss-ok').length;
      out.statsA = document.getElementById('stats-a').textContent;
      out.hitReadout = document.getElementById('hit-a').textContent;
      out.svgIcons = document.querySelectorAll('.pv-node svg').length;
      // 模拟切换 A 预览为长昵称
      const longChk = document.querySelector('#preview-a [data-var="nicknameLong"]');
      longChk.checked = true;
      longChk.dispatchEvent(new Event('change', { bubbles: true }));
      return out;
    })()`,
    returnByValue: true
  });
  await sleep(800);
  const afterToggle = await send('Runtime.evaluate', {
    expression: `(() => {
      const out = {};
      out.issueCountAfter = document.querySelectorAll('.iss-item').length;
      out.logEntries = document.querySelectorAll('#recompute-log li').length;
      // 打开导出弹窗
      document.getElementById('btn-export').click();
      out.modalOpen = document.getElementById('export-modal').classList.contains('modal-open');
      out.runtimeJson = document.getElementById('export-runtime').value.slice(0, 120);
      out.runtimeHasGuides = /showGuides|guide/.test(document.getElementById('export-runtime').value);
      out.runtimeHasPreviewOnly = /previewOnly/.test(document.getElementById('export-runtime').value);
      out.runtimeNodeCount = JSON.parse(document.getElementById('export-runtime').value).nodes.length;
      out.editorNodeCount = JSON.parse(document.getElementById('export-project').value).nodes.length;
      // 演示悬空参照
      document.getElementById('export-close').click();
      document.getElementById('btn-demo-dangling').click();
      return out;
    })()`,
    returnByValue: true
  });
  await sleep(500);
  const afterDangling = await send('Runtime.evaluate', {
    expression: `(() => {
      const out = {};
      out.danglingError = !!document.querySelector('.iss-error');
      out.danglingText = (document.querySelector('.iss-error .iss-msg')||{}).textContent || '';
      // 演示循环
      document.getElementById('btn-demo-cycle').click();
      return out;
    })()`,
    returnByValue: true
  });
  await sleep(500);
  const afterCycle = await send('Runtime.evaluate', {
    expression: `(() => ({
      cycleError: Array.from(document.querySelectorAll('.iss-error .iss-msg'))
        .some(e => /循环/.test(e.textContent)),
      errorTexts: Array.from(document.querySelectorAll('.iss-error .iss-msg')).map(e=>e.textContent)
    }))()`,
    returnByValue: true
  });

  const result = {
    jsErrors: errors,
    logErrors: logs.filter(l => !/cert|CVDisplay|favicon/.test(l)),
    initial: checks.result.value,
    afterToggle: afterToggle.result.value,
    afterDangling: afterDangling.result.value,
    afterCycle: afterCycle.result.value
  };
  console.log(JSON.stringify(result, null, 2));
  ws.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
