/*
 * 战斗数值试算器 · 界面逻辑
 *
 * 依赖 js/engine.js 与 js/samples.js（均为本地脚本，无网络请求）。
 * 所有用户可见的数据都通过 textContent / createTextNode 写入，避免把配置内容当 HTML 解析。
 */
(function () {
  'use strict';

  var E = window.CombatEngine;
  var Samples = window.CombatSamples;
  var STORE_KEY = 'combat-calc:configs:v1';

  var state = {
    configs: { A: null, B: null },
    results: { A: null, B: null },
    batches: { A: null, B: null },
    stale: { A: false, B: false },
    sampleId: null
  };

  // ---------- 小工具 ----------

  function $(sel, root) { return (root || document).querySelector(sel); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'value') node.value = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function fmtNum(n) {
    if (!Number.isFinite(n)) return '—';
    var r = Math.round(n * 100) / 100;
    return String(r);
  }

  function fmtPct(n) { return fmtNum(n) + '%'; }

  function teamLabel(team) { return team === 'ally' ? '我方' : '敌方'; }

  // ---------- 配置模型 ----------

  function blankUnit(team, n) {
    return {
      id: (team === 'ally' ? 'a' : 'b') + '-u' + n,
      name: (team === 'ally' ? '我方单位 ' : '敌方单位 ') + n,
      maxHp: 600,
      atk: 45,
      def: 20,
      speed: 100,
      skills: [blankSkill((team === 'ally' ? 'a' : 'b') + '-u' + n + '-s1', '技能 1')]
    };
  }

  function blankSkill(id, name) {
    return {
      id: id,
      name: name,
      cooldown: 2,
      castTime: 0,
      target: 'lowestHpEnemy',
      damage: { min: 40, max: 55 },
      heal: { min: 0, max: 0 },
      effect: null
    };
  }

  // 生成在本单位内唯一的 skill id，避免删除后再添加产生重复 id（会把两类效果误判为同类）
  function uniqueSkillId(unit, prefix) {
    var used = {};
    unit.skills.forEach(function (s) { used[s.id] = true; });
    prefix = prefix || (unit.id + '-s');
    var n = 1;
    while (used[prefix + n]) n += 1;
    return prefix + n;
  }

  function blankConfig(label) {
    return {
      name: '配置 ' + label,
      seed: '1',
      rules: { maxTime: 30, speedTieBreak: 'id-asc' },
      allies: [blankUnit('ally', 1)],
      enemies: [blankUnit('enemy', 1)]
    };
  }

  function defaultBatchRuns() { return 200; }

  // ---------- 本地保存 ----------

  function saveConfigs() {
    return safeSet(STORE_KEY, JSON.stringify({
      A: state.configs.A, B: state.configs.B,
      sampleId: state.sampleId,
      savedAt: new Date().toISOString()
    }));
  }

  function loadConfigs() {
    try {
      var raw = safeGet(STORE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (!data || !data.A || !data.B) return false;
      state.configs.A = normalizeForEditor(data.A);
      state.configs.B = normalizeForEditor(data.B);
      state.sampleId = data.sampleId || null;
      return true;
    } catch (err) {
      return false;
    }
  }

  function normalizeForEditor(cfg) {
    var out = clone(cfg);
    out.name = out.name || '未命名配置';
    out.seed = out.seed == null ? '1' : String(out.seed);
    out.rules = out.rules || {};
    out.rules.maxTime = Number(out.rules.maxTime) || 30;
    out.rules.speedTieBreak = out.rules.speedTieBreak === 'id-desc' ? 'id-desc' : 'id-asc';
    out.allies = (out.allies || []).map(normalizeUnitForEditor);
    out.enemies = (out.enemies || []).map(normalizeUnitForEditor);
    return out;
  }

  function normalizeUnitForEditor(u) {
    var out = clone(u);
    out.id = String(out.id || 'u');
    out.name = String(out.name || out.id);
    out.maxHp = Number(out.maxHp) || 1;
    out.atk = Number(out.atk) || 0;
    out.def = Number(out.def) || 0;
    out.speed = Number(out.speed) || 1;
    out.skills = (out.skills || []).map(function (s) {
      var sk = clone(s);
      sk.id = String(sk.id || (out.id + '-s'));
      sk.name = String(sk.name || sk.id);
      sk.cooldown = Number(sk.cooldown) || 0;
      sk.castTime = Number(sk.castTime) || 0;
      sk.target = E.TARGETS.indexOf(sk.target) >= 0 ? sk.target : 'lowestHpEnemy';
      sk.damage = { min: Number(sk.damage && sk.damage.min) || 0, max: Number(sk.damage && sk.damage.max) || 0 };
      sk.heal = { min: Number(sk.heal && sk.heal.min) || 0, max: Number(sk.heal && sk.heal.max) || 0 };
      sk.effect = sk.effect ? {
        kind: E.EFFECT_KINDS.indexOf(sk.effect.kind) >= 0 ? sk.effect.kind : 'dot',
        value: { min: Number(sk.effect.value && sk.effect.value.min) || 0, max: Number(sk.effect.value && sk.effect.value.max) || 0 },
        duration: Number(sk.effect.duration) || 1,
        interval: Number(sk.effect.interval) || 1,
        stackMode: E.STACK_MODES.indexOf(sk.effect.stackMode) >= 0 ? sk.effect.stackMode : 'stack',
        maxStacks: Number(sk.effect.maxStacks) || 1,
        stat: sk.effect.stat === 'def' || sk.effect.stat === 'speed' ? sk.effect.stat : 'atk'
      } : null;
      return sk;
    });
    return out;
  }

  // ---------- 主题 ----------

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }

  function safeSet(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (err) { return false; }
  }

  function initTheme() {
    var saved = safeGet('combat-calc:theme');
    if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
    $('#theme-toggle').addEventListener('click', function () {
      var cur = document.documentElement.dataset.theme;
      if (!cur) {
        cur = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      safeSet('combat-calc:theme', next);
      rerenderCharts();
    });
  }

  // ---------- 配置编辑器 ----------

  function renderEditors() {
    ['A', 'B'].forEach(function (key) {
      var host = $('#config-' + key);
      host.innerHTML = '';
      host.appendChild(buildConfigCard(key));
    });
  }

  function buildConfigCard(key) {
    var cfg = state.configs[key];
    var card = el('div', { class: 'config-card' });

    var title = el('input', {
      class: 'config-title-input',
      type: 'text',
      value: cfg.name,
      'aria-label': '配置 ' + key + ' 名称',
      oninput: function (ev) { cfg.name = ev.target.value; markStale(key); scheduleSave(); }
    });

    card.appendChild(el('div', { class: 'config-head' }, [
      el('span', { class: 'config-badge ' + key.toLowerCase(), text: key }),
      el('div', { class: 'config-title' }, [title]),
      el('button', {
        class: 'btn btn-sm btn-ghost',
        type: 'button',
        text: '重置',
        title: '把这套配置恢复为空白模板',
        onclick: function () {
          if (!confirm('确定要清空配置 ' + key + ' 吗？')) return;
          state.configs[key] = blankConfig(key);
          state.results[key] = null;
          state.batches[key] = null;
          renderEditors();
          refreshAfterConfigChange();
          scheduleSave();
        }
      })
    ]));

    var meta = el('div', { class: 'config-meta' });
    meta.appendChild(numberField('随机种子', cfg.seed, function (v) {
      cfg.seed = v === '' ? '1' : v;
      markStale(key); scheduleSave();
    }, { type: 'text', hint: '同一配置 + 同一种子结果完全一致' }));
    meta.appendChild(numberField('时间上限（秒）', cfg.rules.maxTime, function (v) {
      cfg.rules.maxTime = Math.max(0.1, Number(v) || 30);
      markStale(key); scheduleSave();
    }, { min: 1, max: 600, step: 1 }));
    meta.appendChild(selectField('同速排序规则', [
      { value: 'id-asc', label: '同速：我方优先，再按 id 升序' },
      { value: 'id-desc', label: '同速：我方优先，再按 id 降序' }
    ], cfg.rules.speedTieBreak, function (v) {
      cfg.rules.speedTieBreak = v;
      markStale(key); scheduleSave();
    }));
    card.appendChild(meta);

    ['ally', 'enemy'].forEach(function (team) {
      card.appendChild(buildTeamBlock(key, team));
    });

    return card;
  }

  function buildTeamBlock(key, team) {
    var cfg = state.configs[key];
    var list = team === 'ally' ? cfg.allies : cfg.enemies;
    var section = el('div', { class: 'team-section' });

    section.appendChild(el('div', { class: 'team-head' }, [
      el('div', { class: 'team-head-left' }, [
        el('span', { class: 'team-dot ' + team }),
        el('h3', { text: teamLabel(team) }),
        el('span', { class: 'tag', text: list.length + ' 名单位' })
      ]),
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: '+ 添加单位',
        onclick: function () {
          var n = list.length + 1;
          var unit = blankUnit(team, n);
          while (list.some(function (u) { return u.id === unit.id; })) {
            n += 1;
            unit = blankUnit(team, n);
          }
          list.push(unit);
          renderEditors();
          markStale(key); scheduleSave();
        }
      })
    ]));

    if (!list.length) {
      section.appendChild(el('div', { class: 'empty-hint', text: '暂无单位，点击「添加单位」加入一名' }));
    }

    list.forEach(function (unit, unitIndex) {
      section.appendChild(buildUnitCard(key, unit, list, unitIndex));
    });
    return section;
  }

  function buildUnitCard(key, unit, list, unitIndex) {
    var card = el('div', { class: 'unit-card' });

    card.appendChild(el('div', { class: 'unit-head' }, [
      el('span', { class: 'tag', text: '单位 ' + (unitIndex + 1) }),
      el('input', {
        class: 'unit-name', type: 'text', value: unit.name, 'aria-label': '单位名称',
        oninput: function (ev) { unit.name = ev.target.value; markStale(key); scheduleSave(); }
      }),
      el('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', text: '移出',
        title: '从本队移除该单位',
        onclick: function () {
          list.splice(unitIndex, 1);
          renderEditors();
          markStale(key); scheduleSave();
        }
      })
    ]));

    var stats = el('div', { class: 'unit-stats' });
    stats.appendChild(numberField('生命', unit.maxHp, function (v) {
      unit.maxHp = Math.max(1, Number(v) || 1); markStale(key); scheduleSave();
    }, { min: 1, step: 10 }));
    stats.appendChild(numberField('攻击', unit.atk, function (v) {
      unit.atk = Math.max(0, Number(v) || 0); markStale(key); scheduleSave();
    }, { min: 0, step: 1 }));
    stats.appendChild(numberField('防御', unit.def, function (v) {
      unit.def = Math.max(0, Number(v) || 0); markStale(key); scheduleSave();
    }, { min: 0, step: 1 }));
    stats.appendChild(numberField('速度', unit.speed, function (v) {
      unit.speed = Math.max(1, Number(v) || 1); markStale(key); scheduleSave();
    }, { min: 1, step: 1, hint: '速度 100 ≈ 每秒行动一次' }));
    card.appendChild(stats);

    var skills = el('div', { class: 'skills' });
    skills.appendChild(el('div', { class: 'skills-head' }, [
      el('h4', { text: '技能（按顺序尝试施放，冷却中则顺延）' }),
      el('button', {
        class: 'btn btn-sm', type: 'button', text: '+ 技能',
        onclick: function () {
          var n = unit.skills.length + 1;
          unit.skills.push(blankSkill(uniqueSkillId(unit), '技能 ' + n));
          renderEditors(); markStale(key); scheduleSave();
        }
      })
    ]));

    if (!unit.skills.length) {
      skills.appendChild(el('div', { class: 'empty-hint', text: '没有技能，该单位只会普通攻击' }));
    }

    unit.skills.forEach(function (skill, skillIndex) {
      skills.appendChild(buildSkillCard(key, unit, skill, skillIndex));
    });
    card.appendChild(skills);

    return card;
  }

  function buildSkillCard(key, unit, skill, skillIndex) {
    var card = el('div', { class: 'skill-card' });

    card.appendChild(el('div', { class: 'skill-head' }, [
      el('span', { class: 'tag', text: '技能 ' + (skillIndex + 1) }),
      el('input', {
        class: 'skill-name', type: 'text', value: skill.name, 'aria-label': '技能名称',
        oninput: function (ev) { skill.name = ev.target.value; markStale(key); scheduleSave(); }
      }),
      el('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', text: '删除',
        onclick: function () {
          unit.skills.splice(skillIndex, 1);
          renderEditors(); markStale(key); scheduleSave();
        }
      })
    ]));

    var grid = el('div', { class: 'skill-grid' });
    grid.appendChild(numberField('冷却（秒）', skill.cooldown, function (v) {
      skill.cooldown = Math.max(0, Number(v) || 0); markStale(key); scheduleSave();
    }, { min: 0, step: 0.1 }));
    grid.appendChild(numberField('引导（秒）', skill.castTime, function (v) {
      skill.castTime = Math.max(0, Number(v) || 0); markStale(key); scheduleSave();
    }, { min: 0, step: 0.1, hint: '0 = 瞬发' }));
    grid.appendChild(selectField('目标', [
      { value: 'lowestHpEnemy', label: '敌方·生命最低' },
      { value: 'randomEnemy', label: '敌方·随机' },
      { value: 'allEnemies', label: '敌方·全体' },
      { value: 'lowestHpAlly', label: '我方·生命最低' },
      { value: 'randomAlly', label: '我方·随机' },
      { value: 'allAllies', label: '我方·全体' },
      { value: 'self', label: '自身' }
    ], skill.target, function (v) { skill.target = v; markStale(key); scheduleSave(); }));
    card.appendChild(grid);

    var dmgHeal = el('div', { class: 'skill-grid', style: 'margin-top:6px' });
    dmgHeal.appendChild(rangeField('伤害范围', skill.damage, function (min, max) {
      skill.damage = { min: min, max: max }; markStale(key); scheduleSave();
    }));
    dmgHeal.appendChild(rangeField('治疗范围', skill.heal, function (min, max) {
      skill.heal = { min: min, max: max }; markStale(key); scheduleSave();
    }));
    card.appendChild(dmgHeal);

    // 持续效果
    var effectBlock = el('div', { class: 'effect-block' });
    var hasEffect = !!skill.effect;
    var toggle = el('input', {
      type: 'checkbox',
      checked: hasEffect,
      onchange: function (ev) {
        if (ev.target.checked) {
          skill.effect = {
            kind: 'dot', value: { min: 10, max: 14 }, duration: 4,
            interval: 1, stackMode: 'stack', maxStacks: 5, stat: 'atk'
          };
        } else {
          skill.effect = null;
        }
        renderEditors(); markStale(key); scheduleSave();
      }
    });
    effectBlock.appendChild(el('label', { class: 'effect-toggle' }, [
      toggle, el('span', { text: '附加持续效果（持续伤害 / 持续治疗 / 属性增益）' })
    ]));

    if (skill.effect) {
      var eff = skill.effect;
      var fields = el('div', { class: 'effect-fields' });
      fields.appendChild(selectField('类型', [
        { value: 'dot', label: '持续伤害' },
        { value: 'hot', label: '持续治疗' },
        { value: 'buff', label: '属性增益' }
      ], eff.kind, function (v) {
        eff.kind = v;
        renderEditors(); markStale(key); scheduleSave();
      }));
      fields.appendChild(rangeField('每跳数值', eff.value, function (min, max) {
        eff.value = { min: min, max: max }; markStale(key); scheduleSave();
      }));
      fields.appendChild(numberField('持续（秒）', eff.duration, function (v) {
        eff.duration = Math.max(0, Number(v) || 0); markStale(key); scheduleSave();
      }, { min: 0, step: 0.1 }));
      fields.appendChild(numberField('间隔（秒）', eff.interval, function (v) {
        eff.interval = Math.max(0.1, Number(v) || 1); markStale(key); scheduleSave();
      }, { min: 0.1, step: 0.1 }));
      fields.appendChild(selectField('叠加规则', [
        { value: 'stack', label: '叠层（累加，刷新时长）' },
        { value: 'refresh', label: '刷新（层数不变，重置时长）' },
        { value: 'replace', label: '覆盖（层数重置为 1）' },
        { value: 'ignore', label: '忽略（已存在则不生效）' }
      ], eff.stackMode, function (v) {
        eff.stackMode = v; markStale(key); scheduleSave();
      }));
      fields.appendChild(numberField('最大层数', eff.maxStacks, function (v) {
        eff.maxStacks = Math.max(1, Math.round(Number(v) || 1)); markStale(key); scheduleSave();
      }, { min: 1, step: 1 }));
      if (eff.kind === 'buff') {
        fields.appendChild(selectField('增益属性', [
          { value: 'atk', label: '攻击' },
          { value: 'def', label: '防御' },
          { value: 'speed', label: '速度' }
        ], eff.stat, function (v) { eff.stat = v; markStale(key); scheduleSave(); }));
      }
      effectBlock.appendChild(fields);
    }
    card.appendChild(effectBlock);

    return card;
  }

  function numberField(label, value, onChange, opts) {
    opts = opts || {};
    var input = el('input', {
      type: opts.type === 'text' ? 'text' : 'number',
      value: String(value),
      min: opts.min,
      max: opts.max,
      step: opts.step,
      oninput: function (ev) { onChange(ev.target.value, ev); },
      onchange: function (ev) { onChange(ev.target.value, ev); }
    });
    return el('label', { class: 'field' }, [
      el('span', { text: label }),
      input,
      opts.hint ? el('span', { class: 'field-hint', text: opts.hint }) : null
    ]);
  }

  function selectField(label, options, value, onChange) {
    var select = el('select', { onchange: function (ev) { onChange(ev.target.value); } },
      options.map(function (o) {
        return el('option', { value: o.value, text: o.label, selected: o.value === value });
      }));
    return el('label', { class: 'field' }, [el('span', { text: label }), select]);
  }

  function rangeField(label, range, onChange) {
    // 用元素自身当前值计算，避免闭包里的 range 对象在 onChange 重建后变旧
    var minInput = el('input', {
      type: 'number', value: String(range.min), step: 1, 'aria-label': label + ' 最小值'
    });
    var maxInput = el('input', {
      type: 'number', value: String(range.max), step: 1, 'aria-label': label + ' 最大值'
    });
    function emit() {
      var lo = Math.max(0, Number(minInput.value) || 0);
      var hi = Math.max(0, Number(maxInput.value) || 0);
      if (hi < lo) { var t = lo; lo = hi; hi = t; }
      onChange(lo, hi);
    }
    minInput.addEventListener('input', emit);
    maxInput.addEventListener('input', emit);
    return el('label', { class: 'field span2' }, [
      el('span', { text: label }),
      el('div', { style: 'display:flex;gap:6px;align-items:center' }, [
        minInput, el('span', { class: 'muted', text: '–' }), maxInput
      ])
    ]);
  }

  // ---------- 过期标记 ----------

  var saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveConfigs, 400);
  }

  function markStale(key) {
    if (state.results[key] || state.batches[key]) {
      state.stale[key] = true;
      $('#stale-note').hidden = false;
    }
    // 批量结果依赖完整配置，配置一改就作废，避免展示过期分布
    if (state.batches[key]) {
      state.batches[key] = null;
      if ($('#batch-body')) renderBatchResults();
    }
  }

  function clearStale() {
    state.stale.A = false;
    state.stale.B = false;
    $('#stale-note').hidden = true;
  }

  // 配置被结构性改动后，让结果区与配置保持一致
  function refreshAfterConfigChange() {
    showValidation();
    if (state.results.A || state.results.B) {
      renderComparison();
    } else {
      $('#comparison').hidden = true;
    }
    if (state.batches.A || state.batches.B) {
      ensureBatchSection();
      renderBatchResults();
    } else {
      $('#batch-section').hidden = true;
    }
  }

  // ---------- 校验 ----------

  function showValidation() {
    var host = $('#validation');
    host.innerHTML = '';
    var allErrors = [];
    var allWarnings = [];
    ['A', 'B'].forEach(function (key) {
      var v = E.validateSetup(state.configs[key]);
      v.errors.forEach(function (msg) { allErrors.push('配置 ' + key + '：' + msg); });
      v.warnings.forEach(function (msg) { allWarnings.push('配置 ' + key + '：' + msg); });
    });
    if (!allErrors.length && !allWarnings.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    if (allErrors.length) {
      host.appendChild(el('div', { class: 'err' }, [
        el('strong', { text: '无法模拟：' }),
        el('ul', {}, allErrors.map(function (m) { return el('li', { text: m }); }))
      ]));
    }
    if (allWarnings.length) {
      host.appendChild(el('div', { class: 'warn' }, [
        el('strong', { text: '提示：' }),
        el('ul', {}, allWarnings.map(function (m) { return el('li', { text: m }); }))
      ]));
    }
    return allErrors.length;
  }

  // ---------- 运行单次模拟 ----------

  function runBoth() {
    showValidation();
    var vA = E.validateSetup(state.configs.A);
    var vB = E.validateSetup(state.configs.B);
    if (vA.errors.length || vB.errors.length) return;

    state.results.A = E.simulate(state.configs.A);
    state.results.B = E.simulate(state.configs.B);
    clearStale();
    renderComparison();
    ensureBatchSection();
  }

  function runOne(key) {
    var v = E.validateSetup(state.configs[key]);
    if (v.errors.length) { showValidation(); return; }
    state.results[key] = E.simulate(state.configs[key]);
    state.stale[key] = false;
    if (!state.stale.A && !state.stale.B) $('#stale-note').hidden = true;
    renderComparison();
    ensureBatchSection();
  }

  function ensureBatchSection() {
    var host = $('#batch-section');
    if (host.hidden || !$('#batch-body')) {
      host.hidden = false;
      buildBatchSection();
    }
  }

  // ---------- 对比结果 ----------

  function renderComparison() {
    var host = $('#comparison');
    var A = state.results.A;
    var B = state.results.B;
    if (!A && !B) { host.hidden = true; return; }
    host.hidden = false;
    host.innerHTML = '';

    host.appendChild(buildVerdictPanel(A, B));
    host.appendChild(buildDiffPanel(A, B));
    host.appendChild(buildOrderPanel());
    host.appendChild(buildTimelinePanel(A, B));
    host.appendChild(buildEventPanel(A, B));
  }

  // ---------- 行动顺序预览 ----------

  function buildOrderPanel() {
    var panel = el('section', { class: 'panel' });
    panel.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { text: '行动顺序预览' }),
      el('span', { class: 'sub', text: '同 tick 排序：行动时刻 → 速度 → 我方优先 → 配置内顺序 / id 规则' })
    ]));
    var body = el('div', { class: 'panel-body' });
    var grid = el('div', { class: 'result-grid' });

    ['A', 'B'].forEach(function (key) {
      var cfg = state.configs[key];
      if (!cfg) return;
      var order = [];
      try { order = E.previewActionOrder(cfg, 10); } catch (err) { order = []; }
      var card = el('div', { class: 'result-card' });
      card.appendChild(el('div', { class: 'result-card-head' }, [
        el('span', { class: 'config-badge ' + key.toLowerCase(), text: key }),
        el('span', { class: 'name', text: '配置 ' + key + ' · 前 10 次行动' }),
        el('span', { class: 'tag', text: cfg.rules.speedTieBreak === 'id-desc' ? 'id 降序同速' : 'id 升序同速' })
      ]));
      if (!order.length) {
        card.appendChild(el('div', { class: 'chart-empty', text: '暂无可用单位' }));
      } else {
        var list = el('ol', { class: 'order-list' });
        order.forEach(function (o) {
          list.appendChild(el('li', {}, [
            el('span', { class: 'order-time', text: fmtNum(o.time) + 's' }),
            el('span', { class: 'team-dot ' + o.team }),
            el('span', { text: o.unitName }),
            el('span', { class: 'muted', text: '速度 ' + fmtNum(o.speed) })
          ]));
        });
        card.appendChild(list);
      }
      grid.appendChild(card);
    });

    body.appendChild(grid);
    panel.appendChild(body);
    return panel;
  }

  function buildResultCard(key, result) {
    var card = el('div', { class: 'result-card' });

    var verdictText = result.winner === 'ally' ? '我方胜利'
      : result.winner === 'enemy' ? '敌方胜利'
      : result.winnerLabel;
    // 胜负始终以“我方”视角判定，两套配置共用同一阵营定义
    var verdictClass = result.winner === 'ally' ? 'win' : result.winner === 'enemy' ? 'lose' : 'draw';

    card.appendChild(el('div', { class: 'result-card-head' }, [
      el('span', { class: 'config-badge ' + key.toLowerCase(), text: key }),
      el('span', { class: 'name', text: result.setupName }),
      el('span', { class: 'verdict ' + verdictClass, text: verdictText })
    ]));

    var stats = el('div', { class: 'stat-row' });
    stats.appendChild(el('div', { class: 'stat-tile' }, [
      el('div', { class: 'label', text: '战斗时长' }),
      el('div', { class: 'value' }, [String(result.duration), el('small', { text: ' 秒' })]),
      el('div', { class: 'sub', text: result.timedOut ? '达到时间上限' : '自然结束' })
    ]));
    stats.appendChild(el('div', { class: 'stat-tile' }, [
      el('div', { class: 'label', text: '我方剩余生命' }),
      el('div', { class: 'value' }, [fmtNum(result.allyHp), el('small', { text: ' / ' + fmtNum(result.allyMaxHp) })]),
      hpBar('ally', result.allyHpPct),
      el('div', { class: 'sub', text: fmtPct(result.allyHpPct) })
    ]));
    stats.appendChild(el('div', { class: 'stat-tile' }, [
      el('div', { class: 'label', text: '敌方剩余生命' }),
      el('div', { class: 'value' }, [fmtNum(result.enemyHp), el('small', { text: ' / ' + fmtNum(result.enemyMaxHp) })]),
      hpBar('enemy', result.enemyHpPct),
      el('div', { class: 'sub', text: fmtPct(result.enemyHpPct) })
    ]));
    card.appendChild(stats);

    card.appendChild(el('div', { class: 'sub', style: 'margin-top:10px;font-size:11px;color:var(--text-muted)' }, [
      '种子 ' + result.seed + ' · ' + result.events.length + ' 条事件' +
      (result.eventsTruncated ? '（已截断）' : '')
    ]));

    return card;
  }

  function hpBar(team, pct) {
    var width = Math.max(0, Math.min(100, pct));
    return el('div', { class: 'hp-bar' }, [
      el('span', { class: 'fill ' + team, style: 'width:' + width + '%' })
    ]);
  }

  function buildVerdictPanel(A, B) {
    var panel = el('section', { class: 'panel' });
    panel.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { text: '单次模拟结果' }),
      el('span', { class: 'sub', text: '固定时间步 0.1 秒 · 固定种子，结果可复现' })
    ]));
    var grid = el('div', { class: 'panel-body result-grid' });
    if (A) grid.appendChild(buildResultCard('A', A));
    if (B) grid.appendChild(buildResultCard('B', B));
    panel.appendChild(grid);
    return panel;
  }

  function diffMetricRows(A, B) {
    var rows = [];
    function add(metric, getter, opts) {
      opts = opts || {};
      var va = A ? getter(A) : null;
      var vb = B ? getter(B) : null;
      rows.push({
        metric: metric,
        a: va, b: vb,
        display: opts.display || fmtNum,
        diff: va != null && vb != null && String(va) !== String(vb),
        eventAnchor: opts.eventAnchor || null
      });
    }
    add('胜负', function (r) {
      return r.winner === 'ally' ? '我方胜利' : r.winner === 'enemy' ? '敌方胜利' : r.winnerLabel;
    }, { display: function (v) { return v; } });
    add('战斗时长（秒）', function (r) { return r.duration; }, { display: fmtNum });
    add('我方剩余生命', function (r) { return r.allyHp; }, { display: fmtNum });
    add('敌方剩余生命', function (r) { return r.enemyHp; }, { display: fmtNum });
    add('我方剩余生命 %', function (r) { return r.allyHpPct; }, { display: fmtPct });
    add('敌方剩余生命 %', function (r) { return r.enemyHpPct; }, { display: fmtPct });
    add('我方存活单位', function (r) { return r.survivors.filter(function (u) { return u.team === 'ally'; }).length; });
    add('敌方存活单位', function (r) { return r.survivors.filter(function (u) { return u.team === 'enemy'; }).length; });
    add('事件条数', function (r) { return r.events.length; });
    add('我方总伤害', function (r) { return sumStat(r, 'ally', 'damageDealt'); }, { display: fmtNum });
    add('敌方总伤害', function (r) { return sumStat(r, 'enemy', 'damageDealt'); }, { display: fmtNum });
    add('我方总治疗', function (r) { return sumStat(r, 'ally', 'healingDone'); }, { display: fmtNum });
    add('敌方总治疗', function (r) { return sumStat(r, 'enemy', 'healingDone'); }, { display: fmtNum });
    return rows;
  }

  function sumStat(result, team, field) {
    var total = 0;
    Object.keys(result.stats).forEach(function (id) {
      var s = result.stats[id];
      if (s.team === team) total += s[field] || 0;
    });
    return Math.round(total * 1000) / 1000;
  }

  function buildDiffPanel(A, B) {
    var panel = el('section', { class: 'panel' });
    panel.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { text: '关键指标对比' }),
      el('span', { class: 'sub', text: '高亮行表示两套配置结果不同' })
    ]));

    var body = el('div', { class: 'panel-body' });
    var table = el('table', { class: 'diff-table' });
    table.appendChild(el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '指标' }),
        el('th', { text: '配置 A' }),
        el('th', { text: '配置 B' }),
        el('th', { text: '差异' })
      ])
    ]));

    var tbody = el('tbody');
    var rows = diffMetricRows(A, B);
    var diffCount = 0;
    rows.forEach(function (row) {
      if (row.diff) diffCount += 1;
      var delta;
      if (row.a == null || row.b == null) {
        delta = '—';
      } else if (typeof row.a === 'number' && typeof row.b === 'number') {
        var d = Math.round((row.b - row.a) * 100) / 100;
        delta = d === 0 ? '—' : (d > 0 ? '+' : '') + fmtNum(d);
      } else {
        delta = row.diff ? '不同' : '一致';
      }
      tbody.appendChild(el('tr', { class: row.diff ? 'diff' : '' }, [
        el('td', { class: 'metric', text: row.metric }),
        el('td', { class: 'num', text: row.a == null ? '—' : row.display(row.a) }),
        el('td', { class: 'num', text: row.b == null ? '—' : row.display(row.b) }),
        el('td', { class: 'num' }, [
          row.diff ? el('span', { class: 'tag diff', text: delta }) : el('span', { class: 'muted', text: delta })
        ])
      ]));
    });
    table.appendChild(tbody);
    body.appendChild(table);

    var note = el('p', { class: 'sub', style: 'margin-top:10px;font-size:12px;color:var(--text-muted)' },
      [diffCount + ' / ' + rows.length + ' 项指标不同。展开下方「事件明细」可逐条对照两套配置的行动与效果时序。']);
    body.appendChild(note);
    panel.appendChild(body);
    return panel;
  }

  function buildTimelinePanel(A, B) {
    var panel = el('section', { class: 'panel' });
    panel.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { text: '生命曲线' }),
      el('span', { class: 'sub', text: '两套配置各自独立坐标轴，悬停查看任意时刻' })
    ]));
    var body = el('div', { class: 'panel-body' });
    var charts = el('div', { class: 'charts' });
    charts.id = 'timeline-charts';
    body.appendChild(charts);
    panel.appendChild(body);

    // 延迟到插入 DOM 后绘制，便于测量宽度
    requestAnimationFrame(function () { drawTimelineCharts(); });
    return panel;
  }

  function drawTimelineCharts() {
    var host = $('#timeline-charts');
    if (!host) return;
    host.innerHTML = '';
    ['A', 'B'].forEach(function (key) {
      var result = state.results[key];
      if (!result) return;
      var card = el('div', { class: 'chart-card' });
      card.appendChild(el('div', { class: 'chart-title' }, [
        el('h4', { text: '配置 ' + key + ' · 双方总生命' }),
        el('span', { class: 'chart-sub', text: result.setupName })
      ]));
      card.appendChild(el('div', { class: 'legend' }, [
        el('span', { class: 'legend-item' }, [
          el('span', { class: 'legend-swatch', style: 'background:var(--series-1)' }),
          el('span', { text: '我方' })
        ]),
        el('span', { class: 'legend-item' }, [
          el('span', { class: 'legend-swatch', style: 'background:var(--series-2)' }),
          el('span', { text: '敌方' })
        ])
      ]));
      var chartHost = el('div');
      card.appendChild(chartHost);
      host.appendChild(card);
      renderTimelineChart(chartHost, result);
    });
  }

  function rerenderCharts() {
    if (state.results.A || state.results.B) drawTimelineCharts();
    if (state.batches.A || state.batches.B) drawBatchHistograms();
  }

  // ---------- SVG 折线图（带十字准星 tooltip） ----------

  function renderTimelineChart(host, result) {
    var points = result.timeline;
    if (!points || points.length < 2) {
      host.appendChild(el('div', { class: 'chart-empty', text: '战斗过短，没有足够的时间序列数据' }));
      return;
    }

    var W = Math.max(280, host.clientWidth || 560);
    var H = 210;
    var pad = { top: 12, right: 52, bottom: 26, left: 40 };
    var plotW = W - pad.left - pad.right;
    var plotH = H - pad.top - pad.bottom;

    var maxT = Math.max(1, points[points.length - 1].t);
    var maxHp = Math.max(result.allyMaxHp, result.enemyMaxHp, 1);
    var yMax = niceMax(maxHp);

    function x(t) { return pad.left + (t / maxT) * plotW; }
    function y(v) { return pad.top + plotH - (v / yMax) * plotH; }

    var svgNs = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('class', 'chart-svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '配置 ' + result.setupName + ' 双方总生命随时间变化曲线');

    // 网格 + y 轴刻度
    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var val = (yMax / ticks) * i;
      var yy = y(val);
      if (i > 0) {
        var g = document.createElementNS(svgNs, 'line');
        g.setAttribute('x1', pad.left); g.setAttribute('x2', W - pad.right);
        g.setAttribute('y1', yy); g.setAttribute('y2', yy);
        g.setAttribute('class', 'gridline');
        svg.appendChild(g);
      }
      var lbl = document.createElementNS(svgNs, 'text');
      lbl.setAttribute('x', pad.left - 6); lbl.setAttribute('y', yy + 3);
      lbl.setAttribute('text-anchor', 'end');
      lbl.setAttribute('class', 'axis-label');
      lbl.textContent = compact(val);
      svg.appendChild(lbl);
    }

    // x 轴
    var axis = document.createElementNS(svgNs, 'line');
    axis.setAttribute('x1', pad.left); axis.setAttribute('x2', W - pad.right);
    axis.setAttribute('y1', pad.top + plotH); axis.setAttribute('y2', pad.top + plotH);
    axis.setAttribute('class', 'axis-line');
    svg.appendChild(axis);

    var xTicks = Math.min(6, Math.max(2, Math.round(maxT / 5)));
    for (var k = 0; k <= xTicks; k++) {
      var tVal = (maxT / xTicks) * k;
      var xx = x(tVal);
      var tl = document.createElementNS(svgNs, 'text');
      tl.setAttribute('x', xx); tl.setAttribute('y', H - 8);
      tl.setAttribute('text-anchor', k === 0 ? 'start' : k === xTicks ? 'end' : 'middle');
      tl.setAttribute('class', 'axis-label');
      tl.textContent = fmtNum(tVal) + 's';
      svg.appendChild(tl);
    }

    function drawSeries(key, color, field, areaOpacity) {
      var d = '';
      points.forEach(function (p, idx) {
        d += (idx === 0 ? 'M' : 'L') + x(p.t).toFixed(2) + ' ' + y(p[field]).toFixed(2);
      });
      if (areaOpacity) {
        var area = document.createElementNS(svgNs, 'path');
        var da = d + 'L' + x(points[points.length - 1].t).toFixed(2) + ' ' + y(0).toFixed(2) +
          'L' + x(points[0].t).toFixed(2) + ' ' + y(0).toFixed(2) + 'Z';
        area.setAttribute('d', da);
        area.setAttribute('class', 'series-area');
        area.style.fill = color;
        svg.appendChild(area);
      }
      var path = document.createElementNS(svgNs, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'series-line');
      path.style.stroke = color;
      svg.appendChild(path);

      // 末端标记 + 直接标签
      var last = points[points.length - 1];
      var dot = document.createElementNS(svgNs, 'circle');
      dot.setAttribute('cx', x(last.t)); dot.setAttribute('cy', y(last[field]));
      dot.setAttribute('r', 4);
      dot.style.fill = color;
      dot.setAttribute('class', 'hover-dot');
      svg.appendChild(dot);

      var label = document.createElementNS(svgNs, 'text');
      label.setAttribute('x', x(last.t) + 8);
      label.setAttribute('y', y(last[field]) + 3);
      label.setAttribute('class', 'end-label');
      label.textContent = key;
      svg.appendChild(label);
    }

    drawSeries('我方', 'var(--series-1)', 'ally', true);
    drawSeries('敌方', 'var(--series-2)', 'enemy', false);

    // 交互层：十字准星 + tooltip
    var cross = document.createElementNS(svgNs, 'line');
    cross.setAttribute('class', 'crosshair');
    cross.setAttribute('y1', pad.top);
    cross.setAttribute('y2', pad.top + plotH);
    cross.style.display = 'none';
    svg.appendChild(cross);

    var hit = document.createElementNS(svgNs, 'rect');
    hit.setAttribute('x', pad.left); hit.setAttribute('y', pad.top);
    hit.setAttribute('width', plotW); hit.setAttribute('height', plotH);
    hit.setAttribute('class', 'hit-layer');
    hit.setAttribute('tabindex', '0');
    svg.appendChild(hit);

    var lastIdx = -1;
    function nearestIndex(px) {
      var t = ((px - pad.left) / plotW) * maxT;
      var best = 0, bestD = Infinity;
      points.forEach(function (p, idx) {
        var d = Math.abs(p.t - t);
        if (d < bestD) { bestD = d; best = idx; }
      });
      return best;
    }

    function showAt(px, clientX, clientY) {
      var idx = nearestIndex(px);
      lastIdx = idx;
      var p = points[idx];
      cross.setAttribute('x1', x(p.t));
      cross.setAttribute('x2', x(p.t));
      cross.style.display = '';
      var svgRect = svg.getBoundingClientRect();
      var scale = svgRect.width / W;
      showTooltip(
        clientX != null ? clientX : svgRect.left + x(p.t) * scale,
        clientY != null ? clientY : svgRect.top + pad.top,
        fmtNum(p.t) + ' 秒',
        [
          { name: '我方', value: fmtNum(p.ally), color: 'var(--series-1)' },
          { name: '敌方', value: fmtNum(p.enemy), color: 'var(--series-2)' }
        ]
      );
    }

    hit.addEventListener('pointermove', function (ev) {
      var rect = svg.getBoundingClientRect();
      var scale = rect.width / W;
      showAt((ev.clientX - rect.left) / scale, ev.clientX, ev.clientY);
    });
    hit.addEventListener('pointerleave', function () {
      cross.style.display = 'none';
      hideTooltip();
    });
    hit.addEventListener('focus', function () {
      var rect = svg.getBoundingClientRect();
      showAt(x(points[points.length - 1].t), rect.left + 40, rect.top + 40);
    });
    hit.addEventListener('blur', hideTooltip);
    hit.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      if (lastIdx < 0) lastIdx = points.length - 1;
      lastIdx = Math.max(0, Math.min(points.length - 1, lastIdx + (ev.key === 'ArrowRight' ? 1 : -1)));
      var p = points[lastIdx];
      var rect = svg.getBoundingClientRect();
      var scale = rect.width / W;
      cross.setAttribute('x1', x(p.t)); cross.setAttribute('x2', x(p.t));
      cross.style.display = '';
      showTooltip(rect.left + x(p.t) * scale, rect.top + 40, fmtNum(p.t) + ' 秒', [
        { name: '我方', value: fmtNum(p.ally), color: 'var(--series-1)' },
        { name: '敌方', value: fmtNum(p.enemy), color: 'var(--series-2)' }
      ]);
    });

    host.appendChild(svg);

    // 表格视图：图表不是唯一的取值途径（抽样展示，避免超长）
    var details = el('details', { class: 'dist-table' });
    details.appendChild(el('summary', {}, [el('span', { text: '查看数据表' })]));
    var step = Math.max(1, Math.ceil(points.length / 40));
    var sampled = points.filter(function (p, idx) {
      return idx % step === 0 || idx === points.length - 1;
    });
    var table = el('table', { class: 'data-table' });
    table.appendChild(el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '时间（秒）' }),
        el('th', { class: 'num', text: '我方总生命' }),
        el('th', { class: 'num', text: '敌方总生命' })
      ])
    ]));
    table.appendChild(el('tbody', {}, sampled.map(function (p) {
      return el('tr', {}, [
        el('td', { class: 'num', text: fmtNum(p.t) }),
        el('td', { class: 'num', text: fmtNum(p.ally) }),
        el('td', { class: 'num', text: fmtNum(p.enemy) })
      ]);
    })));
    details.appendChild(table);
    host.appendChild(details);
  }

  // y 轴上限取 1 / 2 / 2.5 / 5 / 10 × 10^n，保证刻度是整齐数字
  function niceMax(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var norm = v / mag;
    var step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    return step * mag;
  }

  function compact(v) {
    if (v >= 10000) return Math.round(v / 1000) + 'K';
    if (v >= 1000) return (Math.round(v / 100) / 10) + 'K';
    return String(Math.round(v));
  }

  // ---------- Tooltip ----------

  function showTooltip(x, y, title, rows) {
    var tip = $('#tooltip');
    tip.innerHTML = '';
    tip.appendChild(el('div', { class: 'tt-title', text: title }));
    rows.forEach(function (r) {
      tip.appendChild(el('div', { class: 'tt-row' }, [
        el('span', { class: 'tt-key' }, [
          el('span', { class: 'tt-swatch', style: 'background:' + r.color }),
          el('span', { text: r.name })
        ]),
        el('span', { class: 'tt-val', text: r.value })
      ]));
    });
    tip.hidden = false;
    var rect = tip.getBoundingClientRect();
    var left = x + 14;
    var top = y + 14;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - 14;
    if (top + rect.height > window.innerHeight - 8) top = y - rect.height - 14;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }

  function hideTooltip() {
    $('#tooltip').hidden = true;
  }

  // ---------- 事件明细（含差异对齐） ----------

  function eventSignature(ev) {
    return [
      ev.type,
      ev.time,
      ev.unitId || ev.sourceId || '',
      ev.targetId || ev.ownerId || '',
      (ev.targetIds || []).join(','),
      ev.skillId || '',
      ev.amount != null ? ev.amount : '',
      ev.stacks != null ? ev.stacks : '',
      ev.reason || ''
    ].join('|');
  }

  function firstDivergence(A, B) {
    if (!A || !B) return null;
    var ea = A.events;
    var eb = B.events;
    var n = Math.min(ea.length, eb.length);
    for (var i = 0; i < n; i++) {
      if (eventSignature(ea[i]) !== eventSignature(eb[i])) {
        return { index: i, eventA: ea[i], eventB: eb[i] };
      }
    }
    if (ea.length !== eb.length) {
      return {
        index: n,
        eventA: ea[n] || null,
        eventB: eb[n] || null
      };
    }
    return null;
  }

  function eventDescription(ev) {
    switch (ev.type) {
      case 'battle_start': return ev.detail || '战斗开始';
      case 'battle_end': return '结果：' + ev.reasonLabel + '，用时 ' + fmtNum(ev.duration) + ' 秒';
      case 'cast': return ev.unitName + ' 施放「' + ev.skillName + '」→ ' + (ev.targetNames || []).join('、');
      case 'cast_complete': return ev.unitName + ' 的「' + ev.skillName + '」生效，冷却至 ' + fmtNum(ev.cooldownUntil) + ' 秒';
      case 'cast_fizzle': return ev.unitName + ' 的「' + ev.skillName + '」' + ev.detail;
      case 'cast_cancel': return ev.unitName + ' 的「' + ev.skillName + '」被打断（' + ev.reason + '）';
      case 'basic': return ev.unitName + ' 普通攻击 → ' + ev.targetName;
      case 'damage': return (ev.sourceName || '持续效果') + ' → ' + ev.targetName + ' 造成 ' + fmtNum(ev.amount) +
        ' 伤害（剩余 ' + fmtNum(ev.hpAfter) + '）' + (ev.detail ? ' · ' + ev.detail : '');
      case 'heal': return (ev.sourceName || '持续效果') + ' → ' + ev.targetName + ' 治疗 ' + fmtNum(ev.amount) +
        '（剩余 ' + fmtNum(ev.hpAfter) + '）' + (ev.detail ? ' · ' + ev.detail : '');
      case 'death': return ev.unitName + ' 阵亡（' + ev.reasonLabel + '）';
      case 'effect_apply': return ev.sourceName + ' 对 ' + ev.ownerName + ' 施加「' + ev.effectName + '」' +
        (ev.duration != null ? '，' + fmtNum(ev.duration) + ' 秒' : '') + (ev.endTime != null ? '，至 ' + fmtNum(ev.endTime) + ' 秒' : '');
      case 'effect_stack': return ev.ownerName + ' 的「' + ev.effectName + '」叠至 ' + ev.stacks + '/' + ev.maxStacks +
        ' 层' + (ev.endTime != null ? '，刷新至 ' + fmtNum(ev.endTime) + ' 秒' : '');
      case 'effect_refresh': return ev.ownerName + ' 的「' + ev.effectName + '」刷新时长至 ' + fmtNum(ev.endTime) + ' 秒（' + ev.stacks + ' 层）';
      case 'effect_replace': return ev.ownerName + ' 的「' + ev.effectName + '」被覆盖，层数重置为 ' + ev.stacks + '，至 ' + fmtNum(ev.endTime) + ' 秒';
      case 'effect_ignore': return ev.ownerName + ' 的「' + ev.effectName + '」重复施加被忽略（' + ev.stacks + ' 层）';
      case 'effect_cap': return ev.ownerName + ' 的「' + ev.effectName + '」已达 ' + ev.maxStacks + ' 层上限，仅刷新时长' +
        (ev.endTime != null ? '至 ' + fmtNum(ev.endTime) + ' 秒' : '');
      case 'effect_end': return ev.ownerName + ' 的「' + ev.effectName + '」结束：' + ev.reasonLabel + '（' + ev.stacks + ' 层）';
      default: return ev.detail || ev.type;
    }
  }

  function eventKindClass(ev) {
    if (ev.type === 'damage') return 'damage';
    if (ev.type === 'heal') return 'heal';
    if (ev.type === 'death') return 'death';
    if (ev.type.indexOf('cast') === 0) return 'cast';
    if (ev.type.indexOf('effect') === 0) return 'effect';
    return '';
  }

  function eventTypeLabel(ev) {
    return E.EVENT_LABELS[ev.type] || ev.type;
  }

  function buildEventPanel(A, B) {
    var panel = el('section', { class: 'panel' });
    var details = el('details', { class: 'events-details', open: false });
    var first = firstDivergence(A, B);

    var summaryChildren = [el('span', { text: '事件明细（可展开，逐条对照）' })];
    if (first) {
      var anchor = first.eventA || first.eventB;
      summaryChildren.push(el('span', {
        class: 'tag diff',
        text: '首个差异：第 ' + (first.index + 1) + ' 条' + (anchor ? ' @ ' + fmtNum(anchor.time) + ' 秒' : '')
      }));
    } else if (A && B) {
      summaryChildren.push(el('span', { class: 'tag', text: '两套配置事件序列完全一致' }));
    }
    details.appendChild(el('summary', {}, summaryChildren));

    var wrap = el('div', { class: 'panel-body' });
    wrap.appendChild(el('p', { class: 'sub', style: 'font-size:12px;color:var(--text-muted);margin-bottom:10px' }, [
      '两侧事件按序号对齐。行底色高亮表示该序号处两套配置的事件不同（类型、来源、目标、数值或层数）。时间单位：秒。'
    ]));

    var toolbar = el('div', { class: 'log-toolbar' });
    var typeSelect = el('select', { 'aria-label': '按事件类型筛选' },
      [el('option', { value: '', text: '全部事件类型' })].concat(
        Object.keys(E.EVENT_LABELS).map(function (k) {
          return el('option', { value: k, text: E.EVENT_LABELS[k] + '（' + k + '）' });
        })
      ));
    var keyword = el('input', { type: 'search', placeholder: '搜索单位 / 技能 / 效果名', 'aria-label': '搜索事件' });
    var diffOnly = el('input', { type: 'checkbox', id: 'diff-only' });
    toolbar.appendChild(typeSelect);
    toolbar.appendChild(keyword);
    toolbar.appendChild(el('label', { class: 'effect-toggle', for: 'diff-only' }, [diffOnly, el('span', { text: '只看差异行' })]));
    toolbar.appendChild(el('span', { class: 'spacer' }));
    var countLabel = el('span', { class: 'count' });
    toolbar.appendChild(countLabel);
    wrap.appendChild(toolbar);

    var scroll = el('div', { class: 'log-scroll' });
    var table = el('table', { class: 'event-table' });
    table.appendChild(el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '#' }),
        el('th', { text: '时间' }),
        el('th', { text: '配置 A 事件' }),
        el('th', { text: '配置 B 事件' })
      ])
    ]));
    var tbody = el('tbody');

    var maxLen = Math.max(A ? A.events.length : 0, B ? B.events.length : 0);
    var bothAvailable = !!(A && B);
    var MAX_RENDER_ROWS = 3000;
    var renderLen = Math.min(maxLen, MAX_RENDER_ROWS);
    var rows = [];
    for (var i = 0; i < renderLen; i++) {
      var ea = A && A.events[i] ? A.events[i] : null;
      var eb = B && B.events[i] ? B.events[i] : null;
      var comparable = !!(ea && eb);
      var same = comparable && eventSignature(ea) === eventSignature(eb);
      // 两侧都存在时，某一侧缺少事件也算差异；只跑了一套配置时不做差异标记
      var isDiff = bothAvailable && !same;
      var tr = el('tr', { class: isDiff ? 'diff-row' : '' });
      tr.dataset.search = [ea, eb].filter(Boolean).map(function (ev) {
        return [ev.unitName, ev.sourceName, ev.targetName, ev.ownerName, ev.skillName, ev.effectName, ev.detail].filter(Boolean).join(' ');
      }).join(' ').toLowerCase();
      tr.dataset.types = ' ' + [ea, eb].filter(Boolean).map(function (ev) { return ev.type; }).join(' ') + ' ';
      tr.dataset.same = isDiff ? '0' : '1';

      tr.appendChild(el('td', { class: 'seq', text: String(i + 1) }));
      var timeCell = el('td', { class: 'time' }, [
        ea ? fmtNum(ea.time) : eb ? fmtNum(eb.time) : '—'
      ]);
      tr.appendChild(timeCell);
      tr.appendChild(buildEventCell(ea));
      tr.appendChild(buildEventCell(eb));
      tbody.appendChild(tr);
      rows.push(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);

    function applyFilter() {
      var t = typeSelect.value;
      var q = keyword.value.trim().toLowerCase();
      var onlyDiff = diffOnly.checked;
      var visible = 0;
      rows.forEach(function (tr) {
        var ok = true;
        if (t && tr.dataset.types.indexOf(' ' + t + ' ') < 0) ok = false;
        if (ok && q && tr.dataset.search.indexOf(q) < 0) ok = false;
        if (ok && onlyDiff && tr.dataset.same === '1') ok = false;
        tr.hidden = !ok;
        if (ok) visible += 1;
      });
      countLabel.textContent = '显示 ' + visible + ' / ' + rows.length + ' 行';
    }
    typeSelect.addEventListener('change', applyFilter);
    keyword.addEventListener('input', applyFilter);
    diffOnly.addEventListener('change', applyFilter);
    applyFilter();

    if (maxLen > renderLen) {
      wrap.appendChild(el('p', { class: 'sub', style: 'font-size:12px;color:var(--text-muted);margin-top:8px' },
        ['事件较多，表格仅渲染前 ' + renderLen + ' 行（共 ' + maxLen + ' 行）。可导出配置后在 Node 中读取完整事件。']));
    }

    details.appendChild(wrap);
    panel.appendChild(details);

    if (first) {
      var note = el('div', { class: 'panel-body' });
      note.style.borderTop = '1px solid var(--border)';
      note.appendChild(el('h4', { text: '首个差异事件' }));
      var compare = el('div', { class: 'result-grid', style: 'margin-top:8px' });
      compare.appendChild(el('div', { class: 'dist-card' }, [
        el('div', { class: 'dist-head' }, [
          el('span', { class: 'name', text: '配置 A' }),
          el('span', { class: 'range', text: first.eventA ? fmtNum(first.eventA.time) + ' 秒' : '无事件' })
        ]),
        el('p', { style: 'margin-top:6px;font-size:12px;color:var(--text-secondary)' },
          [first.eventA ? eventDescription(first.eventA) : '事件序列已结束'])
      ]));
      compare.appendChild(el('div', { class: 'dist-card' }, [
        el('div', { class: 'dist-head' }, [
          el('span', { class: 'name', text: '配置 B' }),
          el('span', { class: 'range', text: first.eventB ? fmtNum(first.eventB.time) + ' 秒' : '无事件' })
        ]),
        el('p', { style: 'margin-top:6px;font-size:12px;color:var(--text-secondary)' },
          [first.eventB ? eventDescription(first.eventB) : '事件序列已结束'])
      ]));
      note.appendChild(compare);
      panel.appendChild(note);
    }

    return panel;
  }

  function buildEventCell(ev) {
    if (!ev) return el('td', { class: 'desc muted', text: '—' });
    return el('td', { class: 'desc' }, [
      el('span', { class: 'event-type ' + eventKindClass(ev), text: eventTypeLabel(ev) }),
      el('span', { style: 'margin-left:6px', text: eventDescription(ev) })
    ]);
  }

  // ---------- 批量模拟 ----------

  function buildBatchSection() {
    var host = $('#batch-section');
    host.innerHTML = '';
    host.hidden = false;

    var panel = el('section', { class: 'panel' });
    panel.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { text: '批量模拟 · 结果分布' }),
      el('span', { class: 'sub', text: '每个种子独立运行；同一批种子可复现同一组分布' })
    ]));

    var controls = el('div', { class: 'batch-seed-row' });
    var runsInput = el('input', { type: 'number', min: 10, max: 2000, step: 10, value: String(state.batchRuns || defaultBatchRuns()), 'aria-label': '模拟次数' });
    runsInput.addEventListener('change', function () { state.batchRuns = Math.max(1, Math.min(2000, Number(runsInput.value) || 200)); });
    controls.appendChild(el('label', { class: 'field' }, [
      el('span', { text: '每套配置运行次数' }), runsInput
    ]));
    var seedInput = el('input', { type: 'text', value: String(state.batchSeed || '1000'), 'aria-label': '批量种子基' });
    seedInput.addEventListener('change', function () { state.batchSeed = seedInput.value || '1000'; });
    controls.appendChild(el('label', { class: 'field' }, [
      el('span', { text: '批量种子基' }), seedInput
    ]));
    controls.appendChild(el('button', {
      class: 'btn btn-primary', type: 'button', text: '运行批量模拟',
      onclick: function () {
        runBatch('A', runsInput.value, seedInput.value);
        runBatch('B', runsInput.value, seedInput.value);
        renderBatchResults();
      }
    }));
    controls.appendChild(el('span', { class: 'muted', style: 'font-size:12px' },
      ['单次模拟使用配置自身种子；批量模拟使用种子基 + #序号']));
    panel.appendChild(controls);

    var body = el('div', { class: 'panel-body' });
    body.id = 'batch-body';
    panel.appendChild(body);
    host.appendChild(panel);
    renderBatchResults();
  }

  function runBatch(key, runs, seed) {
    if (!state.configs[key]) return;
    var v = E.validateSetup(state.configs[key]);
    if (v.errors.length) { state.batches[key] = null; return; }
    var r = Number(runs);
    if (!Number.isFinite(r) || r < 1) r = defaultBatchRuns();
    state.batches[key] = E.simulateBatch(state.configs[key], {
      runs: Math.min(2000, Math.round(r)),
      seed: seed || '1000'
    });
  }

  function renderBatchResults() {
    var body = $('#batch-body');
    if (!body) return;
    body.innerHTML = '';
    var A = state.batches.A;
    var B = state.batches.B;
    if (!A && !B) {
      body.appendChild(el('div', { class: 'chart-empty', text: '点击「运行批量模拟」查看胜率与分布范围' }));
      return;
    }

    var summary = el('div', { class: 'batch-summary' });
    ['A', 'B'].forEach(function (key) {
      var b = state.batches[key];
      if (!b) return;
      summary.appendChild(el('div', { class: 'dist-card' }, [
        el('div', { class: 'dist-head' }, [
          el('span', { class: 'name', text: '配置 ' + key + ' · 胜率' }),
          el('span', { class: 'range', text: b.runs + ' 次' })
        ]),
        el('div', { class: 'stat-tile', style: 'margin-top:4px' }, [
          el('div', { class: 'value' }, [fmtPct(b.winRate.ally), el('small', { text: ' 我方胜' })]),
          el('div', { class: 'sub', text: '敌方胜 ' + fmtPct(b.winRate.enemy) + ' · 平局 ' + fmtPct(b.winRate.draw) })
        ]),
        el('div', { class: 'winrate-bar', role: 'img', 'aria-label': '胜率分布' }, [
          el('span', { class: 'ally', style: 'width:' + b.winRate.ally + '%' }),
          el('span', { class: 'enemy', style: 'width:' + b.winRate.enemy + '%' }),
          el('span', { class: 'draw', style: 'width:' + b.winRate.draw + '%' })
        ])
      ]));
    });
    body.appendChild(summary);

    body.appendChild(el('h3', { text: '分布范围（P10 / 中位数 / P90）', style: 'margin:4px 0 10px' }));
    var distGrid = el('div', { class: 'dist-grid' });
    ['A', 'B'].forEach(function (key) {
      var b = state.batches[key];
      if (!b) return;
      distGrid.appendChild(distCard('配置 ' + key + ' · 战斗时长（秒）', b.duration, fmtNum, b.durationHistogram, 'duration-' + key));
      distGrid.appendChild(distCard('配置 ' + key + ' · 我方剩余生命 %', b.allyHpPct, fmtPct, b.allyHpHistogram, 'allyhp-' + key));
      distGrid.appendChild(distCard('配置 ' + key + ' · 敌方剩余生命 %', b.enemyHpPct, fmtPct, b.enemyHpHistogram, 'enemyhp-' + key));
    });
    body.appendChild(distGrid);

    requestAnimationFrame(drawBatchHistograms);
  }

  function distCard(title, stats, fmt, histogram, id) {
    var peak = histogram.reduce(function (best, b) { return !best || b.count > best.count ? b : best; }, null);
    var details = el('details', { class: 'dist-table' });
    details.appendChild(el('summary', {}, [el('span', { text: '查看分布表' })]));
    var table = el('table', { class: 'data-table' });
    table.appendChild(el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '区间' }),
        el('th', { class: 'num', text: '次数' })
      ])
    ]));
    table.appendChild(el('tbody', {}, histogram.map(function (b) {
      return el('tr', {}, [
        el('td', { class: 'num', text: b.label }),
        el('td', { class: 'num', text: String(b.count) })
      ]);
    })));
    details.appendChild(table);

    return el('div', { class: 'dist-card' }, [
      el('div', { class: 'dist-head' }, [
        el('span', { class: 'name', text: title }),
        el('span', { class: 'range', text: fmt(stats.min) + ' – ' + fmt(stats.max) })
      ]),
      el('div', { class: 'pct-row' }, [
        el('span', {}, ['P10 ', el('b', { text: fmt(stats.p10) })]),
        el('span', {}, ['P50 ', el('b', { text: fmt(stats.p50) })]),
        el('span', {}, ['P90 ', el('b', { text: fmt(stats.p90) })]),
        el('span', {}, ['均值 ', el('b', { text: fmt(stats.mean) })])
      ]),
      el('div', { class: 'hist', id: 'hist-' + id, role: 'img', 'aria-label': title + ' 直方图' },
        histogram.map(function (bucket) {
          return el('div', {
            class: 'hist-bar',
            style: 'height:' + Math.max(2, (bucket.count / maxBucket(histogram)) * 100) + '%',
            title: bucket.label + '：' + bucket.count + ' 次'
          });
        })),
      el('div', { class: 'hist-axis' }, [
        el('span', { text: fmt(histogram[0] ? histogram[0].from : stats.min) }),
        el('span', { text: fmt(histogram.length ? histogram[histogram.length - 1].to : stats.max) })
      ]),
      peak ? el('p', { class: 'dist-peak' }, [
        '峰值区间 ', el('b', { text: peak.label }), '，出现 ' + peak.count + ' 次'
      ]) : null,
      details
    ]);
  }

  function maxBucket(hist) {
    var m = 0;
    hist.forEach(function (b) { if (b.count > m) m = b.count; });
    return Math.max(1, m);
  }

  function drawBatchHistograms() {
    var host = document.querySelectorAll('.hist');
    // 柱状图用 DOM 绘制并已带 title，此处补充 hover 提示到统一 tooltip
    Array.prototype.forEach.call(host, function (elHost) {
      if (elHost.dataset.bound) return;
      elHost.dataset.bound = '1';
      elHost.addEventListener('pointermove', function (ev) {
        var bar = ev.target.closest('.hist-bar');
        if (!bar) { hideTooltip(); return; }
        var parts = String(bar.title).split('：');
        showTooltip(ev.clientX, ev.clientY, parts[0], [
          { name: '次数', value: parts[1] || '', color: 'var(--series-1)' }
        ]);
      });
      elHost.addEventListener('pointerleave', hideTooltip);
    });
  }

  // ---------- 样例 / 导入导出 ----------

  function initSamples() {
    var select = $('#sample-select');
    select.appendChild(el('option', { value: '', text: '— 选择内置样例 —' }));
    Samples.samples.forEach(function (s) {
      select.appendChild(el('option', { value: s.id, text: s.name }));
    });
    select.addEventListener('change', function () { loadSample(select.value); });
    $('#load-sample').addEventListener('click', function () {
      loadSample(select.value || (Samples.samples[0] && Samples.samples[0].id));
    });
  }

  function loadSample(id) {
    var sample = Samples.getSample(id);
    if (!sample) return;
    state.sampleId = sample.id;
    state.configs.A = normalizeForEditor(sample.setupA);
    state.configs.B = normalizeForEditor(sample.setupB);
    state.results.A = null;
    state.results.B = null;
    state.batches.A = null;
    state.batches.B = null;
    state.batchRuns = sample.recommendedRuns || defaultBatchRuns();
    clearStale();
    var note = $('#sample-note');
    note.hidden = false;
    $('#sample-note-title').textContent = sample.name;
    $('#sample-note-desc').textContent = sample.description;
    $('#sample-select').value = sample.id;
    renderEditors();
    showValidation();
    $('#comparison').hidden = true;
    $('#batch-section').hidden = true;
    saveConfigs();
  }

  function exportConfig() {
    var payload = {
      exportedAt: new Date().toISOString(),
      note: '战斗数值试算器配置导出（本地生成，无服务端数据）',
      configs: { A: state.configs.A, B: state.configs.B }
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: 'combat-configs.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function importConfig(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result));
        var configs = data.configs || data;
        if (!configs.A || !configs.B) throw new Error('配置结构不完整');
        state.configs.A = normalizeForEditor(configs.A);
        state.configs.B = normalizeForEditor(configs.B);
        state.results.A = null;
        state.results.B = null;
        state.batches.A = null;
        state.batches.B = null;
        clearStale();
        renderEditors();
        showValidation();
        $('#comparison').hidden = true;
        $('#batch-section').hidden = true;
        saveConfigs();
      } catch (err) {
        alert('导入失败：' + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ---------- 启动 ----------

  function init() {
    initTheme();
    initSamples();

    if (!loadConfigs()) {
      var first = Samples.samples[0];
      state.configs.A = normalizeForEditor(first.setupA);
      state.configs.B = normalizeForEditor(first.setupB);
      state.sampleId = first.id;
    }
    state.batchRuns = state.batchRuns || defaultBatchRuns();
    state.batchSeed = state.batchSeed || '1000';

    renderEditors();
    showValidation();

    $('#sample-select').value = state.sampleId || '';
    if (state.sampleId) {
      var sample = Samples.getSample(state.sampleId);
      if (sample) {
        $('#sample-note').hidden = false;
        $('#sample-note-title').textContent = sample.name;
        $('#sample-note-desc').textContent = sample.description;
      }
    }

    $('#run-both').addEventListener('click', runBoth);
    $('#run-A').addEventListener('click', function () { runOne('A'); });
    $('#run-B').addEventListener('click', function () { runOne('B'); });
    $('#export-config').addEventListener('click', exportConfig);
    $('#import-config').addEventListener('change', function (ev) {
      if (ev.target.files && ev.target.files[0]) importConfig(ev.target.files[0]);
      ev.target.value = '';
    });

    window.addEventListener('resize', debounce(function () {
      if (state.results.A || state.results.B) drawTimelineCharts();
    }, 200));
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
