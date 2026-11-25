/*
 * app.js — 主控：方案管理、情境切换、绑定表格、冲突面板、
 *           捕获录入、导入导出、模拟设备与预览的串联。
 */
(function () {
  'use strict';

  var store = StorageLayer.load();
  var currentContextId = activeProfile().contexts[0].id;
  var capture = null;

  var bus = new InputBus();
  bus.attachKeyboard();
  bus.startGamepadPolling();
  bus.attachBlurReset();

  var simulator = new Simulator(bus);
  var preview = new PreviewEngine(
    document.getElementById('previewCanvas'),
    bus,
    function () { return currentContext(); },
    document.getElementById('actionBar')
  );
  preview.start();

  /* ---------------- 基础查询 ---------------- */

  function activeProfile() {
    return StorageLayer.getActiveProfile(store);
  }

  function currentContext() {
    var p = activeProfile();
    return StorageLayer.findContext(p, currentContextId) || p.contexts[0];
  }

  function persist() {
    pruneAcknowledgements();
    StorageLayer.save(store);
  }

  // 清理已经不存在的冲突确认记录
  function pruneAcknowledgements() {
    var p = activeProfile();
    var valid = {};
    p.contexts.forEach(function (ctx) {
      Bindings.detectConflicts(ctx).forEach(function (c) {
        valid[Bindings.conflictAckKey(c)] = true;
      });
    });
    p.acknowledgedConflicts = (p.acknowledgedConflicts || []).filter(function (k) {
      return valid[typeof k === 'string' ? k : k.key];
    });
  }

  /* ---------------- 渲染 ---------------- */

  function renderAll() {
    renderProfileSelect();
    renderContextTabs();
    renderBindingTable();
    renderConflicts();
    renderSceneTabs();
  }

  function renderProfileSelect() {
    var sel = document.getElementById('profileSelect');
    sel.innerHTML = '';
    store.profiles.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === store.activeProfileId) opt.selected = true;
      sel.appendChild(opt);
    });
    document.getElementById('btnDeleteProfile').disabled = store.profiles.length <= 1;
  }

  function renderContextTabs() {
    var tabs = document.getElementById('contextTabs');
    tabs.innerHTML = '';
    activeProfile().contexts.forEach(function (ctx) {
      var btn = document.createElement('button');
      btn.className = ctx.id === currentContextId ? 'active' : '';
      var conflicts = activeConflicts(ctx);
      btn.innerHTML = ctx.icon + ' ' + Modal.escapeHtml(ctx.name);
      if (conflicts.length > 0) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = conflicts.length;
        btn.appendChild(badge);
      }
      btn.addEventListener('click', function () {
        currentContextId = ctx.id;
        cancelCaptureIfAny('context-switch');
        renderAll();
      });
      tabs.appendChild(btn);
    });
    document.getElementById('contextName').textContent =
      '— ' + currentContext().name + '（' + currentContext().description + '）';
  }

  function conflictMap(ctx) {
    var all = Bindings.detectConflicts(ctx);
    var map = {};
    all.forEach(function (c) {
      c.entries.forEach(function (e) {
        var key = e.actionId + ':' + e.slot;
        (map[key] = map[key] || []).push(c);
      });
    });
    return { all: all, map: map };
  }

  function activeConflicts(ctx) {
    var p = activeProfile();
    return Bindings.detectConflicts(ctx).filter(function (c) {
      return !Bindings.isAcked(c, p.acknowledgedConflicts);
    });
  }

  function renderBindingTable() {
    var ctx = currentContext();
    var info = conflictMap(ctx);
    var body = document.getElementById('bindingTableBody');
    body.innerHTML = '';

    ctx.actions.forEach(function (action) {
      var tr = document.createElement('tr');

      var tdAction = document.createElement('td');
      tdAction.innerHTML = '<div class="action-name">' + Modal.escapeHtml(action.name) + '</div>' +
        '<div class="action-desc">' + Modal.escapeHtml(action.desc || '') +
        ' <code style="color:var(--muted)">' + Modal.escapeHtml(action.id) + '</code></div>';
      tr.appendChild(tdAction);

      ['primary', 'secondary'].forEach(function (slot) {
        var td = document.createElement('td');
        var cell = document.createElement('div');
        cell.className = 'binding-cell';

        var raw = action.bindings && action.bindings[slot];
        var binding = raw ? Bindings.normalizeBinding(raw) : null;
        if (binding) {
          cell.appendChild(buildChip(binding, info.map[action.id + ':' + slot]));
        } else {
          var empty = document.createElement('span');
          empty.className = 'empty-bind';
          empty.textContent = '未绑定';
          cell.appendChild(empty);
        }

        var btns = document.createElement('div');
        btns.className = 'cell-btns';
        var capBtn = document.createElement('button');
        capBtn.className = 'btn btn-sm btn-primary';
        capBtn.textContent = binding ? '重新录入' : '录入';
        capBtn.addEventListener('click', function () { startCapture(action, slot); });
        var clearBtn = document.createElement('button');
        clearBtn.className = 'btn btn-sm btn-danger';
        clearBtn.textContent = '清除';
        clearBtn.disabled = !binding;
        clearBtn.addEventListener('click', function () {
          action.bindings[slot] = null;
          persist();
          Toast.info('已清除「' + action.name + '」的' + (slot === 'primary' ? '主' : '副') + '绑定');
          renderAll();
        });
        btns.appendChild(capBtn);
        btns.appendChild(clearBtn);
        cell.appendChild(btns);

        td.appendChild(cell);
        tr.appendChild(td);
      });

      body.appendChild(tr);
    });
  }

  function buildChip(binding, conflictsHere) {
    var chip = document.createElement('span');
    chip.className = 'key-chip ' + binding.type;
    chip.textContent = binding.display;
    if (conflictsHere && conflictsHere.length) {
      var acked = conflictsHere.every(function (c) {
        return Bindings.isAcked(c, activeProfile().acknowledgedConflicts);
      });
      var warn = document.createElement('span');
      warn.textContent = acked ? '✓' : '⚠';
      warn.title = conflictsHere.map(function (c) { return conflictTypeLabel(c.kind); }).join('；');
      warn.style.color = acked ? 'var(--ok)' : 'var(--warn)';
      warn.style.marginLeft = '4px';
      chip.appendChild(warn);
      if (acked) chip.classList.add('shadow');
    }
    return chip;
  }

  /* ---------------- 冲突面板 ---------------- */

  function conflictTypeLabel(kind) {
    return kind === 'duplicate' ? '重复按键冲突'
      : kind === 'prefix' ? '组合键前缀冲突'
      : '手柄按钮冲突';
  }

  function conflictDescription(c) {
    if (c.kind === 'duplicate') {
      return '「' + c.display + '」被多个操作占用，按下时这些操作会同时触发。';
    }
    if (c.kind === 'prefix') {
      return '前缀操作会在按键按下瞬间立即触发，可能导致后续组合键难以按出。';
    }
    return '手柄「' + c.display + '」被多个操作占用，按下时会同时触发。';
  }

  function renderConflicts() {
    var ctx = currentContext();
    var p = activeProfile();
    var all = Bindings.detectConflicts(ctx);
    var listEl = document.getElementById('conflictList');
    var summaryEl = document.getElementById('conflictSummary');
    listEl.innerHTML = '';

    // 汇总
    var counts = { duplicate: 0, prefix: 0, gamepad: 0, acked: 0 };
    all.forEach(function (c) {
      if (Bindings.isAcked(c, p.acknowledgedConflicts)) counts.acked++;
      else counts[c.kind]++;
    });
    var pills = [];
    if (all.length === 0) {
      pills.push('<span class="pill ok">✓ 当前情境无冲突</span>');
    } else {
      if (counts.duplicate) pills.push('<span class="pill dup">重复 ' + counts.duplicate + '</span>');
      if (counts.prefix) pills.push('<span class="pill prefix">前缀 ' + counts.prefix + '</span>');
      if (counts.gamepad) pills.push('<span class="pill gp">手柄 ' + counts.gamepad + '</span>');
      if (counts.acked) pills.push('<span class="pill ok muted">已确认复用 ' + counts.acked + '</span>');
    }
    summaryEl.innerHTML = pills.join(' ');

    if (all.length === 0) {
      var clear = document.createElement('div');
      clear.className = 'all-clear';
      clear.textContent = '当前情境的所有绑定互不冲突 ✓';
      listEl.appendChild(clear);
      return;
    }

    all.forEach(function (c) {
      var acked = Bindings.isAcked(c, p.acknowledgedConflicts);
      var card = document.createElement('div');
      card.className = 'conflict-card ' + c.kind + (acked ? ' acked' : '');

      var head = document.createElement('div');
      head.className = 'cc-head';
      var type = document.createElement('span');
      type.className = 'cc-type';
      type.textContent = conflictTypeLabel(c.kind);
      head.appendChild(type);
      if (acked) {
        var note = document.createElement('span');
        note.className = 'ack-note';
        note.textContent = '已标记为有意复用';
        head.appendChild(note);
      }

      var desc = document.createElement('div');
      desc.className = 'cc-desc';
      desc.textContent = conflictDescription(c);

      var involved = document.createElement('div');
      involved.className = 'cc-desc';
      involved.innerHTML = c.entries.map(function (e) {
        return '• ' + Modal.escapeHtml(e.actionName) +
          '（' + (e.slot === 'primary' ? '主' : '副') + '绑定：' +
          Modal.escapeHtml(e.display) + '）';
      }).join('<br>');

      var actions = document.createElement('div');
      actions.className = 'cc-actions';
      var ackBtn = document.createElement('button');
      ackBtn.className = 'btn btn-sm ' + (acked ? '' : 'btn-warn');
      ackBtn.textContent = acked ? '撤销“有意复用”' : '标记为有意复用';
      ackBtn.addEventListener('click', function () {
        var key = Bindings.conflictAckKey(c);
        if (acked) {
          p.acknowledgedConflicts = p.acknowledgedConflicts.filter(function (k) {
            return (typeof k === 'string' ? k : k.key) !== key;
          });
        } else {
          p.acknowledgedConflicts.push(key);
        }
        persist();
        renderAll();
      });
      actions.appendChild(ackBtn);

      card.appendChild(head);
      card.appendChild(desc);
      card.appendChild(involved);
      card.appendChild(actions);
      listEl.appendChild(card);
    });
  }

  /* ---------------- 捕获录入 ---------------- */

  function startCapture(action, slot) {
    if (capture) return;
    var bar = document.getElementById('captureBar');
    document.getElementById('captureTitle').textContent =
      '为「' + action.name + ' · ' + (slot === 'primary' ? '主绑定' : '副绑定') + '」捕获输入';
    document.getElementById('captureChord').textContent = '（等待按键 / 手柄按钮，Esc 取消）';
    bar.hidden = false;

    capture = new CaptureSession(bus, {
      onUpdate: function (chordText) {
        document.getElementById('captureChord').textContent =
          chordText ? '当前组合：' + chordText + '（继续按主键完成，松开修饰键则绑定修饰键本身）'
                    : '（等待按键 / 手柄按钮，Esc 取消）';
      },
      onDone: function (binding) {
        finishCapture();
        action.bindings[slot] = {
          type: binding.type, code: binding.code, modifiers: binding.modifiers.slice()
        };
        persist();
        Toast.success('已绑定：' + action.name + ' ' + (slot === 'primary' ? '主' : '副') +
          '绑定 → ' + binding.display);
        renderAll();
      },
      onCancel: function (reason) {
        finishCapture();
        if (reason === 'esc') Toast.info('已取消录入');
        else if (reason === 'gamepad-back') Toast.info('手柄 Back 取消录入');
        else Toast.info('已取消录入');
      }
    });
    capture.start();
  }

  function finishCapture() {
    capture = null;
    document.getElementById('captureBar').hidden = true;
  }

  function cancelCaptureIfAny(reason) {
    if (capture) capture.cancel(reason || 'external');
  }

  document.getElementById('btnCancelCapture').addEventListener('click', function () {
    cancelCaptureIfAny('button');
  });

  /* ---------------- 方案管理 ---------------- */

  document.getElementById('profileSelect').addEventListener('change', function (e) {
    store.activeProfileId = e.target.value;
    currentContextId = activeProfile().contexts[0].id;
    cancelCaptureIfAny('profile-switch');
    persist();
    renderAll();
    Toast.info('已切换到方案「' + activeProfile().name + '」');
  });

  document.getElementById('btnNewProfile').addEventListener('click', function () {
    Modal.prompt('新建玩家方案', '方案名称', '玩家 ' + (store.profiles.length + 1)).then(function (name) {
      if (name == null) return;
      Modal.confirm('新建方式', '新方案要如何初始化？\n确定 = 复制当前方案的全部绑定；取消 = 使用系统默认映射。',
        '复制当前方案').then(function (copyCurrent) {
        var profile = StorageLayer.createProfile(
          store, name, copyCurrent ? activeProfile() : null);
        store.activeProfileId = profile.id;
        currentContextId = profile.contexts[0].id;
        persist();
        renderAll();
        Toast.success('已创建方案「' + profile.name + '」');
      });
    });
  });

  document.getElementById('btnRenameProfile').addEventListener('click', function () {
    var p = activeProfile();
    Modal.prompt('重命名方案', '新名称', p.name).then(function (name) {
      if (name == null) return;
      StorageLayer.renameProfile(p, name);
      persist();
      renderAll();
      Toast.success('方案已重命名为「' + p.name + '」');
    });
  });

  document.getElementById('btnDeleteProfile').addEventListener('click', function () {
    var p = activeProfile();
    Modal.confirm('删除方案', '确定删除方案「' + p.name + '」吗？此操作不可恢复。', '删除', true)
      .then(function (ok) {
        if (!ok) return;
        if (!StorageLayer.deleteProfile(store, p.id)) {
          Toast.error('至少需要保留一个方案');
          return;
        }
        currentContextId = activeProfile().contexts[0].id;
        persist();
        renderAll();
        Toast.success('方案已删除');
      });
  });

  document.getElementById('btnResetProfile').addEventListener('click', function () {
    var p = activeProfile();
    Modal.confirm('恢复默认映射',
      '将把方案「' + p.name + '」的全部情境绑定与冲突确认记录重置为系统默认，确定吗？',
      '恢复默认', true).then(function (ok) {
      if (!ok) return;
      StorageLayer.resetProfile(p);
      currentContextId = p.contexts[0].id;
      persist();
      renderAll();
      Toast.success('已恢复默认映射');
    });
  });

  /* ---------------- 导入 / 导出 ---------------- */

  document.getElementById('btnExport').addEventListener('click', function () {
    ImportExport.exportProfile(activeProfile());
    Toast.success('配置文件已导出');
  });

  document.getElementById('btnImport').addEventListener('click', function () {
    document.getElementById('importFile').click();
  });

  document.getElementById('importFile').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    ImportExport.readFile(file).then(function (text) {
      var report = ImportExport.analyzeImport(text, activeProfile());
      if (!report.ok) {
        Toast.error('导入失败：' + report.error);
        return;
      }
      ImportExport.showImportPreview(report, {
        profile: activeProfile(),
        callback: function (appliedCount) {
          persist();
          renderAll();
          Toast.success('已应用 ' + appliedCount + ' 条绑定，请检查新的冲突提示');
        }
      });
    }).catch(function (err) {
      Toast.error('读取文件失败：' + (err && err.message ? err.message : err));
    });
  });

  /* ---------------- 预览场景切换 ---------------- */

  function renderSceneTabs() {
    var tabs = document.getElementById('sceneTabs');
    var scenes = [
      { id: null, name: '跟随情境' },
      { id: 'menu', name: '📋 菜单' },
      { id: 'onFoot', name: '🚶 步行' },
      { id: 'driving', name: '🚗 驾驶' }
    ];
    tabs.innerHTML = '';
    scenes.forEach(function (s) {
      var btn = document.createElement('button');
      var isActive = preview.autoScene ? s.id === null : preview.scene === s.id;
      if (isActive) btn.className = 'active';
      btn.textContent = s.name;
      btn.addEventListener('click', function () {
        preview.setScene(s.id);
        renderSceneTabs();
      });
      tabs.appendChild(btn);
    });

    var hint = document.getElementById('previewHint');
    var ctx = currentContext();
    hint.textContent = '用模拟设备或真实键盘/手柄操作，下方动作灯与配置实时一致';
  }

  /* ---------------- 启动 ---------------- */

  // 调试/自动化测试句柄（页面内无其它全局状态入口）
  window.__inputBus = bus;

  renderAll();
})();
