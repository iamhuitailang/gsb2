/* 右侧属性检查器：所有属性编辑 + 关键帧开关 + 缓动/时间编辑 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});
  const h = G.util.h;
  const clamp = G.util.clamp;

  function node(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
  }

  function selectedLayer() {
    const app = G.App;
    if (app.state.selection.length !== 1) return null;
    return G.Model.findById(app.state.project.children, app.state.selection[0])?.layer || null;
  }

  /* ---------- 关键帧菱形按钮 ---------- */
  function kfDiamond(layer, prop) {
    const app = G.App;
    const keys = layer.keys[prop] || [];
    const at = G.Model.kfAt(keys, app.state.time, app.state.project.fps);
    const btn = h('button', {
      class: `kf-btn ${keys.length ? 'has-key' : ''} ${at >= 0 ? 'key-at-time' : ''}`,
      title: at >= 0 ? '删除当前时刻关键帧' : '在播放头处添加关键帧',
      'aria-label': `${prop} 关键帧开关`,
      onclick: (e) => { e.stopPropagation(); app.toggleKeyframe(layer.id, prop); },
    }, '◆');
    return btn;
  }

  /* ---------- 数字输入绑定 ---------- */
  function bindNumber(input, apply, opts) {
    opts = opts || {};
    const min = opts.min == null ? -1e9 : opts.min;
    const max = opts.max == null ? 1e9 : opts.max;
    const step = opts.step || 1;
    const parse = () => {
      let v = parseFloat(input.value);
      if (isNaN(v)) return null;
      v = clamp(v, min, max);
      if (opts.integer) v = Math.round(v);
      return v;
    };
    input.addEventListener('focus', () => G.App.editStart());
    input.addEventListener('input', () => {
      const v = parse();
      if (v == null) return;
      G.App.editLive(() => apply(v));
    });
    input.addEventListener('blur', () => {
      const v = parse();
      if (v != null) { input.value = opts.format ? opts.format(v) : v; }
      G.App.editEnd();
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const cur = parse();
        if (cur == null) return;
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? step * 10 : step);
        // focus 时已经开启手势并记录快照，这里只需实时写入
        G.App.editLive(() => apply(clamp(cur + d, min, max)));
        input.value = clamp(cur + d, min, max);
      }
    });
  }

  function numBox(tagText, value, opts, apply) {
    const input = h('input', { type: 'number', value: Math.round(value * 100) / 100, step: opts.step || 1 });
    if (opts.min != null) input.min = opts.min;
    if (opts.max != null) input.max = opts.max;
    bindNumber(input, apply, opts);
    return h('div', { class: 'num-field', title: opts.title || '' }, [
      tagText ? h('span', { class: 'tag' }, tagText) : null,
      input,
      opts.unit ? h('span', { class: 'unit-tag' }, opts.unit) : null,
    ]);
  }

  function fieldLabel(text, extraClass) {
    return h('label', { class: `field-label ${extraClass || ''}` }, text);
  }

  /* ---------- 可折叠分区 ---------- */
  function section(title, children, collapsedByDefault) {
    const sec = h('section', { class: `insp-section ${collapsedByDefault ? 'collapsed' : ''}` });
    const head = h('button', {
      class: 'insp-section-head',
      onclick: () => sec.classList.toggle('collapsed'),
    }, [h('span', { class: 'caret' }, '▼'), h('span', null, title)]);
    const grid = h('div', { class: 'insp-grid' }, children);
    sec.appendChild(head);
    sec.appendChild(grid);
    return sec;
  }

  /* ---------- 关键帧编辑器 ---------- */
  function kfEditor(layer) {
    const sk = G.App.state.selectedKey;
    if (!sk || sk.layerId !== layer.id) return null;
    const keys = layer.keys[sk.prop];
    if (!keys) return null;
    const kf = keys.find((k) => k.id === sk.kfId);
    if (!kf) return null;
    const def = G.Model.PROP_DEFS.find((d) => d.key === sk.prop);

    const timeInput = h('input', { class: 'input', type: 'number', min: '0', step: (1 / G.App.state.project.fps).toFixed(4), value: +kf.t.toFixed(3) });
    timeInput.addEventListener('change', () => {
      const v = clamp(parseFloat(timeInput.value) || 0, 0, G.App.state.project.duration);
      G.App.commit('move-kf', () => G.App.moveKeyframe(layer.id, sk.prop, kf.id, v));
    });
    timeInput.addEventListener('keydown', (e) => e.stopPropagation());

    const easeSelect = h('select', { class: 'input' });
    G.Easing.options.forEach((key) => {
      const o = h('option', { value: key }, G.Easing[key].label);
      if ((kf.ease || 'linear') === key) o.selected = true;
      easeSelect.appendChild(o);
    });
    easeSelect.addEventListener('change', () => {
      G.App.commit('ease', () => { kf.ease = easeSelect.value; });
      G.toast(`缓动已设为「${G.Easing[easeSelect.value].label}」`);
    });

    const del = h('button', {
      class: 'btn btn-small btn-danger-ghost',
      onclick: () => G.App.commit('del-kf', () => G.App.deleteSelectedKey()),
    }, '删除此关键帧');

    return h('div', { class: 'kf-editor' }, [
      h('div', { class: 'kf-title' }, `◆ ${def ? def.label : ''}关键帧 · 第 ${Math.round(kf.t * G.App.state.project.fps)} 帧`),
      h('div', { class: 'insp-row' }, [fieldLabel('时间(秒)'), timeInput]),
      h('div', { class: 'insp-row' }, [fieldLabel('缓动方式'), easeSelect]),
      h('div', { class: 'insp-row' }, [
        fieldLabel(''),
        h('div', { style: { flex: '1', display: 'flex', gap: '8px', justifyContent: 'flex-end' } }, del),
      ]),
      h('div', { style: { fontSize: '11px', color: 'var(--txt-3)', lineHeight: 1.6 } },
        '缓动作用于该关键帧到下一关键帧之间的动画段；拖动时间线上的 ◆ 可调整动画时长。'),
    ]);
  }

  /* ---------- 变换区 ---------- */
  function transformSection(layer, st) {
    const app = G.App;
    const rows = [];

    // 位置
    rows.push(h('div', { class: 'insp-row' }, [
      fieldLabel('位置'),
      h('div', { class: 'insp-two', style: { flex: '1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } }, [
        numBox('X', st.x, { step: 1 }, (v) => app.setPropValue(layer.id, 'position', { x: v })),
        numBox('Y', st.y, { step: 1 }, (v) => app.setPropValue(layer.id, 'position', { y: v })),
      ]),
      kfDiamond(layer, 'position'),
    ]));

    // 大小（缩放）
    const scaleChildren = [
      numBox('', st.scaleX, { step: 1, min: 0, unit: '%', title: '整体缩放百分比（“大小”关键帧）' },
        (v) => app.setPropValue(layer.id, 'scale', layer.uniformScale === false ? { sx: v, sy: st.scaleY } : { sx: v, sy: v })),
      kfDiamond(layer, 'scale'),
    ];
    rows.push(h('div', { class: 'insp-row' }, [
      fieldLabel('大小'),
      h('div', { class: 'grow' }, scaleChildren[0]),
      h('button', {
        class: `btn btn-small toggle-btn ${layer.uniformScale === false ? '' : 'is-on'}`,
        style: { width: '52px', flex: 'none' },
        title: layer.uniformScale === false ? '当前不等比，点击锁定等比' : '当前等比，点击可分别调整宽高缩放',
        textContent: layer.uniformScale === false ? '分离' : '等比',
        onclick: () => app.commit('uniform', () => { layer.uniformScale = !layer.uniformScale; if (layer.uniformScale) layer.scaleY = layer.scaleX; }),
      }),
      scaleChildren[1],
    ]));
    if (layer.uniformScale === false) {
      rows.push(h('div', { class: 'insp-row' }, [
        fieldLabel('缩放 W/H'),
        h('div', { class: 'insp-two', style: { flex: '1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } }, [
          numBox('W', st.scaleX, { step: 1, min: 0, unit: '%' }, (v) => app.setPropValue(layer.id, 'scale', { sx: v })),
          numBox('H', st.scaleY, { step: 1, min: 0, unit: '%' }, (v) => app.setPropValue(layer.id, 'scale', { sy: v })),
        ]),
        h('span', { style: { width: '24px', flex: 'none' } }),
      ]));
    }

    // 宽高（基础尺寸）
    rows.push(h('div', { class: 'insp-row' }, [
      fieldLabel('宽高'),
      h('div', { class: 'insp-two', style: { flex: '1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } }, [
        numBox('W', st.w, { step: 1, min: 1 }, (v) => app.setPropValue(layer.id, 'size', { w: v })),
        numBox('H', st.h, { step: 1, min: 1 }, (v) => app.setPropValue(layer.id, 'size', { h: v })),
      ]),
      kfDiamond(layer, 'size'),
    ]));

    // 旋转
    rows.push(h('div', { class: 'insp-row' }, [
      fieldLabel('旋转'),
      h('div', { class: 'grow' }, numBox('', Math.round(st.rotation * 10) / 10, { step: 1, unit: '°' },
        (v) => app.setPropValue(layer.id, 'rotation', { v }))),
      kfDiamond(layer, 'rotation'),
    ]));

    // 透明度
    const opRange = h('input', { class: 'range', type: 'range', min: '0', max: '100', step: '1', value: Math.round(st.opacity) });
    opRange.addEventListener('focus', () => app.editStart());
    opRange.addEventListener('input', () => app.editLive(() => app.setPropValue(layer.id, 'opacity', { v: +opRange.value })));
    opRange.addEventListener('blur', () => app.editEnd());
    rows.push(h('div', { class: 'insp-row' }, [
      fieldLabel('透明度'),
      opRange,
      h('span', { style: { width: '42px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: '12px' } }, `${Math.round(st.opacity)}%`),
      kfDiamond(layer, 'opacity'),
    ]));

    return section('变换 / 动画', rows);
  }

  /* ---------- 文字 ---------- */
  const FONTS = [
    ['"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif', '苹方 / 雅黑（默认黑体）'],
    ['"Songti SC", "SimSun", serif', '宋体 / 明朝'],
    ['"Kaiti SC", "KaiTi", serif', '楷体'],
    ['"Futura", "Avenir Next", "Helvetica Neue", sans-serif', 'Futura / Avenir'],
    ['Georgia, "Times New Roman", serif', 'Georgia 衬线'],
    ['"SF Mono", Menlo, Consolas, monospace', '等宽字体'],
  ];

  function textSection(layer) {
    const app = G.App;
    const ta = h('textarea', { class: 'input', rows: '3', placeholder: '输入文字，换行可多行' });
    ta.value = layer.text;
    ta.addEventListener('focus', () => app.editStart());
    ta.addEventListener('input', () => app.editLive(() => { layer.text = ta.value; }));
    ta.addEventListener('blur', () => app.editEnd());

    const fontSel = h('select', { class: 'input' });
    FONTS.forEach(([v, label]) => {
      const o = h('option', { value: v }, label);
      if (layer.fontFamily === v) o.selected = true;
      fontSel.appendChild(o);
    });
    fontSel.addEventListener('change', () => app.commit('font', () => { layer.fontFamily = fontSel.value; }));

    const sizeI = numBox(null, layer.fontSize, { step: 1, min: 4, max: 800 },
      (v) => app.editLive(() => { layer.fontSize = v; }));

    const weightSel = h('select', { class: 'input' }, [
      ['400', '常规 400'], ['500', '中等 500'], ['700', '粗体 700'], ['800', '特粗 800'], ['900', '黑体 900'],
    ].map(([v, l]) => {
      const o = h('option', { value: v }, l);
      if (String(layer.fontWeight) === v) o.selected = true;
      return o;
    }));
    weightSel.addEventListener('change', () => app.commit('weight', () => { layer.fontWeight = +weightSel.value; }));

    const alignBtns = ['left', 'center', 'right'].map((a) => h('button', {
      class: `btn btn-small ${layer.align === a ? 'toggle-btn is-on' : ''}`,
      style: { flex: '1' },
      title: { left: '左对齐', center: '居中', right: '右对齐' }[a],
      onclick: () => app.commit('align', () => { layer.align = a; }),
    }, { left: '⇤ 左', center: '居中', right: '右 ⇥' }[a]));

    const color = h('input', { class: 'color-field', type: 'color', value: layer.color });
    color.addEventListener('input', () => app.editLive(() => { layer.color = color.value; }));
    color.addEventListener('focus', () => app.editStart());
    color.addEventListener('blur', () => app.editEnd());

    const ls = numBox(null, layer.letterSpacing, { step: 1, min: -20, max: 100, unit: 'px' },
      (v) => app.editLive(() => { layer.letterSpacing = v; }));

    const lh = numBox(null, layer.lineHeight, { step: 0.05, min: 0.6, max: 4 },
      (v) => app.editLive(() => { layer.lineHeight = v; }));

    return section('文字', [
      ta,
      h('div', { class: 'insp-row' }, [fieldLabel('字体'), h('div', { class: 'grow' }, fontSel)]),
      h('div', { class: 'insp-two' }, [
        h('div', { class: 'insp-row' }, [fieldLabel('字号'), sizeI]),
        h('div', { class: 'insp-row' }, [fieldLabel('字重'), h('div', { class: 'grow' }, weightSel)]),
      ]),
      h('div', { class: 'insp-row' }, [fieldLabel('对齐'), h('div', { class: 'grow', style: { display: 'flex', gap: '6px' } }, alignBtns)]),
      h('div', { class: 'insp-row' }, [fieldLabel('颜色'), color, h('span', { class: 'flex1' }), fieldLabel('字距'), ls]),
      h('div', { class: 'insp-row' }, [fieldLabel('行距'), lh]),
    ]);
  }

  /* ---------- 矩形 ---------- */
  function rectSection(layer) {
    const app = G.App;
    const fill = h('input', { class: 'color-field', type: 'color', value: /^#[0-9a-f]{6}$/i.test(layer.fill) ? layer.fill : '#6e8bff' });
    fill.addEventListener('input', () => app.editLive(() => { layer.fill = fill.value; }));
    fill.addEventListener('focus', () => app.editStart());
    fill.addEventListener('blur', () => app.editEnd());

    const radius = numBox(null, layer.radius, { step: 2, min: 0, max: 2000, unit: 'px' },
      (v) => app.editLive(() => { layer.radius = v; }));

    const sw = numBox(null, layer.strokeWidth, { step: 1, min: 0, max: 200, unit: 'px' },
      (v) => app.editLive(() => { layer.strokeWidth = v; }));

    const sc = h('input', { class: 'color-field', type: 'color', value: layer.strokeColor || '#ffffff' });
    sc.addEventListener('input', () => app.editLive(() => { layer.strokeColor = sc.value; }));
    sc.addEventListener('focus', () => app.editStart());
    sc.addEventListener('blur', () => app.editEnd());

    return section('矩形外观', [
      h('div', { class: 'insp-row' }, [fieldLabel('填充'), fill, h('span', { class: 'flex1' })]),
      h('div', { class: 'insp-row' }, [fieldLabel('圆角'), radius]),
      h('div', { class: 'insp-row' }, [fieldLabel('描边宽'), sw]),
      h('div', { class: 'insp-row' }, [fieldLabel('描边色'), sc, h('span', { class: 'flex1' })]),
    ]);
  }

  /* ---------- 图片 ---------- */
  function imageSection(layer) {
    const app = G.App;
    const fitSel = h('select', { class: 'input' }, [
      ['contain', '完整显示 (contain)'],
      ['cover', '填满裁切 (cover)'],
      ['fill', '拉伸填满 (fill)'],
    ].map(([v, l]) => {
      const o = h('option', { value: v }, l);
      if (layer.fit === v) o.selected = true;
      return o;
    }));
    fitSel.addEventListener('change', () => app.commit('fit', () => { layer.fit = fitSel.value; }));

    const replaceBtn = h('button', { class: 'btn btn-small', onclick: () => app.chooseImageFor(layer.id) }, '替换本地图片');
    const naturalBtn = h('button', {
      class: 'btn btn-small',
      onclick: () => app.commit('natural', () => {
        const s = Math.min(1, 600 / Math.max(layer.imgW, layer.imgH));
        layer.w = Math.round(layer.imgW * s);
        layer.h = Math.round(layer.imgH * s);
      }),
    }, '恢复原始比例尺寸');

    return section('图片', [
      h('div', { style: { fontSize: '11.5px', color: 'var(--txt-3)' } },
        `原始尺寸：${layer.imgW || '?'} × ${layer.imgH || '?'}（图片以 dataURL 保存在工程文件中）`),
      h('div', { class: 'insp-row' }, [fieldLabel('适配'), h('div', { class: 'grow' }, fitSel)]),
      h('div', { class: 'insp-row', style: { gap: '8px' } }, [replaceBtn, naturalBtn]),
    ]);
  }

  /* ---------- 投影（所有类型） ---------- */
  function shadowSection(layer) {
    const app = G.App;
    if (!layer.shadow) layer.shadow = { enabled: false, color: 'rgba(0,0,0,0.45)', blur: 20, offsetY: 6 };
    const sh = layer.shadow;
    const enable = h('input', { type: 'checkbox', checked: !!sh.enabled });
    enable.addEventListener('change', () => app.commit('shadow', () => { sh.enabled = enable.checked; }));

    const color = h('input', { class: 'color-field', type: 'color', value: /^#[0-9a-f]{6}$/i.test(sh.color) ? sh.color : '#000000' });
    color.addEventListener('input', () => app.editLive(() => { sh.color = color.value; }));
    color.addEventListener('focus', () => app.editStart());
    color.addEventListener('blur', () => app.editEnd());

    const blur = numBox(null, sh.blur || 0, { step: 1, min: 0, max: 300, unit: 'px' }, (v) => app.editLive(() => { sh.blur = v; }));
    const dy = numBox(null, sh.offsetY || 0, { step: 1, min: -200, max: 200, unit: 'px' }, (v) => app.editLive(() => { sh.offsetY = v; }));

    return section('投影', [
      h('div', { class: 'insp-row' }, [h('label', { class: 'ctl ctl-check' }, [enable, h('span', null, '启用投影')])]),
      h('div', { class: 'insp-row' }, [fieldLabel('颜色'), color, h('span', { class: 'flex1' })]),
      h('div', { class: 'insp-row' }, [fieldLabel('模糊'), blur]),
      h('div', { class: 'insp-row' }, [fieldLabel('Y 偏移'), dy]),
    ], true);
  }

  /* ---------- 工程设置（无单选时） ---------- */
  function projectPanel() {
    const p = G.App.state.project;
    const wrap = h('div', { style: { paddingTop: '6px' } });
    wrap.appendChild(h('div', { class: 'insp-section' }, [
      h('div', { class: 'insp-section-head' }, [h('span', { class: 'caret' }, '▼'), h('span', null, '工程与输出')]),
      h('div', { class: 'insp-grid' }, [
        h('div', { style: { fontSize: '12px', color: 'var(--txt-2)', lineHeight: 1.8 } },
          '在顶部或画布上方修改输出尺寸、帧率与时长。所有导出均使用此处的工程参数。'),
        h('div', { class: 'summary-card', style: { textAlign: 'left' } }, [
          h('div', { class: 'v', style: { fontSize: '15px' } }, `${p.width} × ${p.height}`),
          h('div', { class: 'k' }, `${p.fps} fps · ${p.duration}s · 共 ${G.Exporter.frameCount(p)} 帧`),
        ]),
      ]),
    ]));
    wrap.appendChild(h('div', { class: 'insp-section' }, [
      h('div', { class: 'insp-section-head' }, [h('span', { class: 'caret' }, '▼'), h('span', null, '快捷操作')]),
      h('div', { class: 'insp-grid' }, [
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } }, [
          h('button', { class: 'btn btn-small', onclick: () => G.App.addLayer('text') }, '＋ 文字'),
          h('button', { class: 'btn btn-small', onclick: () => G.App.addLayer('rect') }, '＋ 矩形'),
          h('button', { class: 'btn btn-small', onclick: () => G.App.triggerImageImport() }, '＋ 图片'),
          h('button', { class: 'btn btn-small', onclick: () => G.UI.ExportDialog.open('seq') }, '导出序列'),
        ]),
      ]),
    ]));
    wrap.appendChild(h('div', { class: 'insp-empty' },
      '提示：在画布中点击元素即可选中并拖动；\n双击图层名可重命名。'));
    return wrap;
  }

  function multiPanel(ids) {
    return h('div', { class: 'insp-empty' }, [
      h('div', { style: { fontSize: '15px', color: 'var(--txt)', marginBottom: '10px' } }, `已选择 ${ids.length} 个图层`),
      h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center' } }, [
        h('button', { class: 'btn btn-primary btn-small', onclick: () => G.App.groupSelected() }, '编组'),
        h('button', { class: 'btn btn-small btn-danger-ghost', onclick: () => G.App.deleteSelected() }, '删除'),
      ]),
    ]);
  }

  function render() {
    const root = document.getElementById('inspector');
    if (!root) return;
    root.innerHTML = '';
    const app = G.App;
    const ids = app.state.selection;

    if (ids.length > 1) { root.appendChild(multiPanel(ids)); return; }
    const layer = selectedLayer();
    if (!layer) { root.appendChild(projectPanel()); return; }

    if (layer.type === 'group') {
      root.appendChild(h('div', { class: 'insp-empty' }, [
        h('div', { style: { fontSize: '15px', color: 'var(--txt)', marginBottom: '8px' } }, `编组：${layer.name}`),
        h('div', null, `包含 ${layer.children.length} 个图层；眼睛/锁定可批量作用。`),
        h('div', { style: { marginTop: '14px' } },
          h('button', { class: 'btn btn-small', onclick: () => app.ungroupSelected() }, '取消编组')),
      ]));
      return;
    }

    const st = G.Interpolate.sampleLayer(layer, app.state.time);

    // 顶部图层名
    const typeChar = { text: '文', rect: '矩', image: '图' }[layer.type] || '层';
    root.appendChild(h('div', { style: { padding: '14px 16px 4px', display: 'flex', alignItems: 'center', gap: '8px' } }, [
      h('span', { class: `layer-ico type-${layer.type}` }, typeChar),
      h('input', {
        class: 'input',
        value: layer.name,
        style: { fontWeight: '700' },
        onchange: (e) => app.commit('rename', () => { layer.name = e.target.value.trim() || layer.name; app.refreshAll(); }),
      }),
    ]));

    const ed = kfEditor(layer);
    if (ed) root.appendChild(ed);

    root.appendChild(transformSection(layer, st));
    if (layer.type === 'text') root.appendChild(textSection(layer));
    if (layer.type === 'rect') root.appendChild(rectSection(layer));
    if (layer.type === 'image') root.appendChild(imageSection(layer));
    root.appendChild(shadowSection(layer));
  }

  G.UI = G.UI || {};
  G.UI.Inspector = { render };
})();
