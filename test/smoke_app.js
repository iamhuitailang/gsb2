/* 页面冒烟测试: 用 DOM/WebGL 桩在 node 中执行 app.js 的主要流程
 * node test/smoke_app.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------- WebGL 桩 ----------
const glStub = () => {
  const consts = {};
  const names = ['VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS',
    'ARRAY_BUFFER','STATIC_DRAW','FLOAT','TRIANGLES','LINES','POINTS','DEPTH_TEST',
    'COLOR_BUFFER_BIT','DEPTH_BUFFER_BIT','POLYGON_OFFSET_FILL'];
  const g = {};
  for (const n of names) g[n] = Math.random();
  Object.assign(g, {
    createShader: () => ({}), shaderSource: () => {}, compileShader: () => {},
    getShaderParameter: () => true, getShaderInfoLog: () => '',
    createProgram: () => ({}), attachShader: () => {}, linkProgram: () => {},
    getProgramParameter: () => true, getProgramInfoLog: () => '',
    useProgram: () => {}, getAttribLocation: () => 0, getUniformLocation: () => ({}),
    enableVertexAttribArray: () => {}, createBuffer: () => ({}),
    bindBuffer: () => {}, bufferData: () => {}, vertexAttribPointer: () => {},
    enable: () => {}, disable: () => {}, clearColor: () => {}, clear: () => {},
    viewport: () => {}, uniformMatrix4fv: () => {}, uniform1f: () => {},
    drawArrays: () => {}, polygonOffset: () => {},
  });
  return g;
};

// ---------- DOM 桩 ----------
function elStub(id) {
  const el = {
    id, children: [], style: {}, dataset: {},
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    addEventListener: () => {},
    appendChild(c) { el.children.push(c); },
    click() { if (el.onclick) el.onclick(); },
    set innerHTML(v) { el.children = []; el._html = v; },
    get innerHTML() { return el._html || ''; },
    textContent: '', className: '', disabled: false, value: 'facing',
    scrollTop: 0, scrollHeight: 0,
  };
  return el;
}
const els = {};
const canvas = Object.assign(elStub('gl'), {
  getContext: () => glStub(),
  clientWidth: 800, clientHeight: 600, width: 800, height: 600,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
});
const sandbox = {
  console,
  document: {
    getElementById: (id) => (id === 'gl' ? canvas : (els[id] = els[id] || elStub(id))),
    createElement: (tag) => elStub(tag),
    querySelectorAll: () => [],
  },
  window: { addEventListener: () => {}, devicePixelRatio: 1 },
  requestAnimationFrame: () => {},
  FileReader: function () {},
  Blob: function () {},
  URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
};
sandbox.self = sandbox;
sandbox.__els = els;
vm.createContext(sandbox);

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const code =
  read('js/mesh-core.js') + '\n' +
  read('js/examples-data.js') + '\n' +
  read('js/app.js') + '\n' +
  // ---------- 驱动: 加载 -> 修闭合块 -> 开口片参考面 -> 自检 -> 撤销 ----------
  `
  (function(){
    const results = [];
    const t = (name, cond) => results.push([name, !!cond]);

    // 默认已加载 demo_all.obj
    t('默认加载 demo_all', state.meshOriginal && state.meshOriginal.faces.length === 59);
    t('初始为原始视图', state.view === 'original');

    // 修所有闭合块
    const an = state.analysisOriginal;
    const closedIds = an.components.filter(c => c.closed).map(c => c.id);
    t('demo_all 有闭合块', closedIds.length >= 2);
    for (const id of closedIds) {
      state.selComp = id;
      fixSelected();
    }
    t('修复后生成 fixedMesh', !!state.meshFixed);
    t('视图切到修复后', state.view === 'fixed');
    const anF = state.analysisFixed;
    t('闭合块全部朝外', anF.components.filter(c=>c.closed).every(c => c.orientation === 'outward'));
    t('问题保留: 非流形边', anF.nonManifoldEdges.length === an.nonManifoldEdges.length);
    t('问题保留: 零面积面', anF.zeroAreaFaces.length === an.zeroAreaFaces.length);
    t('问题保留: 重合顶点', anF.coincidentVertices.length === an.coincidentVertices.length);

    // 开口片: 无参考面应提示
    const openComp = an.components.find(c => !c.closed && c.faceCount > 4);
    state.selComp = openComp.id;
    fixSelected();
    t('开口片无参考面不修复', !state.flipsByComp.has(openComp.id));
    // 选参考面后修复
    state.refFaceByComp.set(openComp.id, openComp.faceIds[0]);
    fixSelected();
    t('开口片有参考面可修复', state.flipsByComp.has(openComp.id));
    const fixedAn = state.analysisFixed;
    let inconsistent = 0;
    for (const e of fixedAn.edges)
      if (e.faces.length === 2 && e.faces[0].dir === e.faces[1].dir) inconsistent++;
    t('开口片修复后绕向一致', inconsistent === 0);

    // 自检
    doSelfCheck();
    const logText = __els['log'].children.map(c => c.textContent).join('\\n');
    t('自检全部 ✓', logText.includes('读回自检') && !logText.includes('✗'));

    // 导出 OBJ 文本可解析且面数不变
    const txt = MeshCore.serializeOBJ(exportMesh());
    const re = MeshCore.parseOBJ(txt);
    t('导出读回面数一致', re.faces.length === state.meshOriginal.faces.length);

    // 视图切换不改变相机
    const before = [cam.theta, cam.phi, cam.dist, cam.target.join(',')].join('|');
    state.view = 'original'; $('btnViewOrig').onclick && null;
    const after = [cam.theta, cam.phi, cam.dist, cam.target.join(',')].join('|');
    t('切换前后相机不变', before === after);

    // 撤销
    $('btnUndo').onclick();
    t('撤销后无 fixedMesh', state.meshFixed === null && state.view === 'original');

    // 单独加载 illegal_mesh: 闭合块可修, 非法结构不动
    loadModel(EXAMPLE_MODELS['illegal_mesh.obj'], 'illegal_mesh.obj');
    const an2 = state.analysisOriginal;
    const cc = an2.components.find(c => c.closed);
    state.selComp = cc.id;
    fixSelected();
    t('illegal: 闭合块已修', state.analysisFixed.components.find(c=>c.closed).orientation === 'outward');
    t('illegal: 非流形边仍在', state.analysisFixed.nonManifoldEdges.length === 1);

    let fail = 0;
    for (const [name, ok] of results) { console.log((ok?'PASS':'FAIL')+'  '+name); if(!ok) fail++; }
    console.log(fail ? fail + ' 项失败' : '冒烟测试全部通过');
    if (fail) process.exitCode = 1;
  })();
  `;
vm.runInContext(code, sandbox, { filename: 'app-bundle.js' });
