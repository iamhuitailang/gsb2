/*
 * import-export.js — 配置文件导入 / 导出
 *
 * 导出：当前方案（含全部情境、冲突确认名单、schema 版本）打包为 JSON。
 * 导入：不直接覆盖任何内容，先逐项解析并分类——
 *   add       目标槽位为空 -> 新增
 *   overwrite 目标槽位已有绑定 -> 覆盖（默认勾选，用户可取消）
 *   unknown   操作/情境/编码无法识别 -> 无法识别（默认不勾选，不可应用）
 * 在预览弹窗中逐项确认后才写回当前方案。
 */
(function (global) {
  'use strict';

  function buildExport(profile) {
    return {
      app: 'game-input-mapping-configurator',
      schemaVersion: global.Defaults.SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      profile: {
        name: profile.name,
        contexts: profile.contexts,
        acknowledgedConflicts: profile.acknowledgedConflicts
      }
    };
  }

  function exportProfile(profile) {
    var payload = buildExport(profile);
    var json = JSON.stringify(payload, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var safeName = profile.name.replace(/[\\/:*?"<>|\s]+/g, '_');
    a.href = url;
    a.download = 'input-mapping-' + safeName + '-' +
      new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsText(file);
    });
  }

  /*
   * 解析导入文本，生成逐项报告：
   * { ok, error, items: [{ status, checked, contextId, contextName, actionId,
   *    actionName, slot, slotName, incomingBinding, incomingText, currentBinding, reason }],
   *   counts:{add,overwrite,unknown} }
   */
  function analyzeImport(text, currentProfile) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: '文件不是合法 JSON：' + e.message };
    }

    // 兼容两种形态：完整导出包 { profile: {...} } 或裸 profile
    var profileData = data && data.profile ? data.profile : data;
    if (!profileData || !Array.isArray(profileData.contexts)) {
      return { ok: false, error: '缺少 profile.contexts 字段，无法识别为映射配置文件' };
    }

    var items = [];
    var counts = { add: 0, overwrite: 0, unknown: 0 };
    var knownContexts = {};
    currentProfile.contexts.forEach(function (c) { knownContexts[c.id] = c; });

    profileData.contexts.forEach(function (inCtx) {
      if (!inCtx || !inCtx.id) {
        items.push(unknownItem(null, null, null, null, null, '缺少情境 id'));
        counts.unknown++;
        return;
      }
      var localCtx = knownContexts[inCtx.id];
      var ctxName = localCtx ? localCtx.name : (inCtx.name || inCtx.id);
      if (!localCtx) {
        // 整个情境在当前方案中不存在 -> 其中每个绑定都归为无法识别
        (inCtx.actions || []).forEach(function (act) {
          (act && act.bindings ? ['primary', 'secondary'] : []).forEach(function (slot) {
            if (act.bindings[slot] == null) return;
            items.push(unknownItem(inCtx.id, ctxName, act.id, act.id, slot,
              '当前方案中不存在情境「' + ctxName + '」'));
            counts.unknown++;
          });
        });
        return;
      }

      var knownActions = {};
      localCtx.actions.forEach(function (a) { knownActions[a.id] = a; });

      (inCtx.actions || []).forEach(function (inAct) {
        if (!inAct || !inAct.id || !inAct.bindings) return;
        var localAction = knownActions[inAct.id];
        var actionName = localAction ? localAction.name : inAct.id;

        ['primary', 'secondary'].forEach(function (slot) {
          var raw = inAct.bindings[slot];
          if (raw == null || raw === '') return;

          if (!localAction) {
            items.push(unknownItem(inCtx.id, ctxName, inAct.id, actionName, slot,
              '情境「' + ctxName + '」中不存在该操作'));
            counts.unknown++;
            return;
          }

          var result = global.Bindings.validateBinding(raw);
          if (!result.ok) {
            items.push(unknownItem(inCtx.id, ctxName, inAct.id, actionName, slot,
              describeReason(result.reason), raw));
            counts.unknown++;
            return;
          }

          var current = localAction.bindings[slot];
          var currentNorm = current ? global.Bindings.normalizeBinding(current) : null;
          var status = currentNorm ? 'overwrite' : 'add';
          counts[status]++;
          items.push({
            status: status,
            checked: true,
            contextId: inCtx.id,
            contextName: ctxName,
            actionId: inAct.id,
            actionName: actionName,
            slot: slot,
            slotName: slot === 'primary' ? '主绑定' : '副绑定',
            incomingBinding: result.binding,
            incomingText: bindingText(raw),
            currentBinding: currentNorm,
            reason: null
          });
        });
      });
    });

    if (items.length === 0) {
      return { ok: false, error: '文件中没有可导入的绑定条目' };
    }
    return { ok: true, items: items, counts: counts, profileData: profileData };
  }

  function unknownItem(ctxId, ctxName, actionId, actionName, slot, reason, raw) {
    return {
      status: 'unknown', checked: false,
      contextId: ctxId, contextName: ctxName,
      actionId: actionId, actionName: actionName,
      slot: slot, slotName: slot === 'primary' ? '主绑定' : (slot === 'secondary' ? '副绑定' : '—'),
      incomingBinding: null,
      incomingText: raw == null ? '' : bindingText(raw),
      currentBinding: null,
      reason: reason
    };
  }

  function describeReason(reason) {
    switch (reason) {
      case 'malformed': return '绑定格式无法解析';
      case 'unknown-key': return '按键编码不在支持的键盘码表内';
      case 'unknown-gamepad': return '手柄按钮/轴编码不在支持范围内';
      case 'unknown-modifier': return '组合键修饰键无法识别';
      case 'empty': return '绑定为空';
      default: return '无法识别的绑定';
    }
  }

  function bindingText(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    try {
      var b = global.Bindings.normalizeBinding(raw);
      return b ? b.display : JSON.stringify(raw);
    } catch (e) {
      return JSON.stringify(raw);
    }
  }

  // 把勾选的条目应用到当前方案
  function applyItems(items, profile) {
    var applied = 0;
    items.forEach(function (item) {
      if (!item.checked || item.status === 'unknown' || !item.incomingBinding) return;
      var ctx = profile.contexts.find(function (c) { return c.id === item.contextId; });
      if (!ctx) return;
      var action = ctx.actions.find(function (a) { return a.id === item.actionId; });
      if (!action) return;
      action.bindings[item.slot] = {
        type: item.incomingBinding.type,
        code: item.incomingBinding.code,
        modifiers: item.incomingBinding.modifiers.slice()
      };
      applied++;
    });
    return applied;
  }

  function showImportPreview(report, onApplied) {
    var groups = [
      { key: 'add', title: '新增绑定', cls: 'add' },
      { key: 'overwrite', title: '覆盖绑定', cls: 'overwrite' },
      { key: 'unknown', title: '无法识别', cls: 'unknown' }
    ];

    var node = document.createElement('div');
    node.innerHTML =
      '<p style="margin:0 0 12px;color:var(--muted);font-size:12.5px">' +
      '共解析 ' + report.items.length + ' 条：新增 ' + report.counts.add +
      ' · 覆盖 ' + report.counts.overwrite + ' · 无法识别 ' + report.counts.unknown +
      '。勾选要应用的条目，无法识别项不可勾选。</p>';

    groups.forEach(function (g) {
      var list = report.items.filter(function (i) { return i.status === g.key; });
      if (list.length === 0) return;
      var section = document.createElement('div');
      section.className = 'import-group';
      var h = document.createElement('h4');
      h.innerHTML = '<span class="tag ' + g.cls + '">' + g.title + '</span> ' + list.length + ' 条';
      section.appendChild(h);

      var table = document.createElement('table');
      table.className = 'import-table';
      table.innerHTML = '<thead><tr><th style="width:34px"></th><th>情境 / 操作</th>' +
        '<th>槽位</th><th>导入内容</th><th>' + (g.key === 'overwrite' ? '当前内容' : '说明') + '</th></tr></thead>';
      var tbody = document.createElement('tbody');

      list.forEach(function (item) {
        var tr = document.createElement('tr');
        var tdCheck = document.createElement('td');
        if (item.status !== 'unknown') {
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'import-toggle';
          cb.checked = item.checked;
          cb.addEventListener('change', function () { item.checked = cb.checked; });
          tdCheck.appendChild(cb);
        }
        tr.appendChild(tdCheck);

        var tdAction = document.createElement('td');
        tdAction.innerHTML = '<div>' + Modal.escapeHtml(item.actionName || '—') + '</div>' +
          '<div class="import-context">' + Modal.escapeHtml(item.contextName || '—') + '</div>';
        tr.appendChild(tdAction);

        var tdSlot = document.createElement('td');
        tdSlot.textContent = item.slotName;
        tr.appendChild(tdSlot);

        var tdIn = document.createElement('td');
        if (item.incomingBinding) {
          tdIn.textContent = item.incomingBinding.display;
        } else {
          tdIn.innerHTML = '<span style="color:var(--muted)">' +
            Modal.escapeHtml(item.incomingText || '（空）') + '</span>';
        }
        tr.appendChild(tdIn);

        var tdNote = document.createElement('td');
        if (g.key === 'overwrite' && item.currentBinding) {
          tdIn.className = '';
          tdNote.textContent = item.currentBinding.display;
        } else {
          tdNote.style.color = g.key === 'unknown' ? 'var(--danger)' : 'var(--muted)';
          tdNote.textContent = item.reason || '';
        }
        tr.appendChild(tdNote);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      section.appendChild(table);
      node.appendChild(section);
    });

    global.Modal.open({
      title: '导入预览 —— 逐项确认',
      bodyNode: node,
      okText: '应用勾选项',
      onOk: function () {
        var checked = report.items.filter(function (i) { return i.checked && i.status !== 'unknown'; });
        if (checked.length === 0) {
          global.Toast.warn('没有勾选任何可应用的绑定');
          return false;
        }
        var n = applyItems(report.items, onApplied.profile);
        onApplied.callback(n);
      }
    });
  }

  global.ImportExport = {
    exportProfile: exportProfile,
    readFile: readFile,
    analyzeImport: analyzeImport,
    showImportPreview: showImportPreview,
    applyItems: applyItems,
    buildExport: buildExport
  };
})(window);
