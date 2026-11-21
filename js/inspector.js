/*
 * inspector.js — 右侧属性检查器
 */
(function (root) {
  'use strict';
  var M = root.ULCModel;
  var E = root.ULCEngine;

  function Inspector(opts) {
    this.el = opts.el;
    this.nodes = [];
    this.node = null;
    this.onEdit = opts.onEdit; // (ops[])
    this._bind();
  }

  Inspector.prototype.render = function (nodes, node) {
    this.nodes = nodes;
    this.node = node;
    if (!node) {
      this.el.innerHTML = '<div class="ins-empty">在组件树或预览中点选一个组件进行编辑</div>';
      return;
    }
    var n = node;
    var refOptions = this._refOptions(n);
    var html = '';

    html += section('基础',
      field('名称', textInput('name', n.name)) +
      '<label class="ins-field"><span>类型</span><b>' +
      ({ panel: '容器 panel', text: '文本 text', icon: '图标 icon', bar: '条形 bar', edge: '边缘 edge' })[n.type] +
      '</b></label>' +
      '<label class="ins-field"><span>优先级</span>' + numberInput('priority', n.priority, 0) +
      '<small class="ins-hint">窄屏冲突时，低优先级组件先被压缩/隐藏</small></label>' +
      '<label class="ins-check"><input type="checkbox" data-prop="previewOnly"' + (n.previewOnly ? ' checked' : '') +
      '> 仅预览组件（导出运行配置时剔除）</label>' +
      (n.type === 'panel' ? '<label class="ins-check"><input type="checkbox" data-prop="overlay"' +
        (n.overlay ? ' checked' : '') + '> 模态遮罩层（覆盖下层不报遮挡）</label>' : '')
    );

    if (n.type === 'panel') {
      html += section('容器布局',
        '<label class="ins-field"><span>排列</span><select data-prop="layout">' +
        M.LAYOUTS.map(function (l) {
          return '<option value="' + l + '"' + (l === n.layout ? ' selected' : '') + '>' +
            ({ none: '不排列（锚点定位）', row: '横向流式', column: '纵向流式' })[l] + '</option>';
        }).join('') + '</select></label>' +
        '<label class="ins-field"><span>间距</span>' + numberInput('gap', n.gap, 0) + '</label>' +
        '<label class="ins-field"><span>内边距(垂直/水平)</span>' +
        numberInput('padV', n.padding[0], 0) + numberInput('padH', n.padding[1], 0) + '</label>'
      );
    }

    html += section('定位锚点',
      M.anchorSlots().map(function (slot) {
        return anchorEditor(slot, n, refOptions);
      }).join('') +
      '<div class="ins-hint">参照可选择屏幕边缘、安全边缘组件或其它组件；参照被删除会报“断”，互相参照会报“环”</div>'
    );

    html += section('尺寸',
      sizeEditor('width', '宽度', n.width) +
      sizeEditor('height', '高度', n.height) +
      '<div class="ins-grid2">' +
      '<label class="ins-field"><span>最小可读宽</span>' + numberInput('minWidth', n.minWidth, 0) + '</label>' +
      '<label class="ins-field"><span>最大宽(0不限)</span>' + numberInput('maxWidth', n.maxWidth, 0) + '</label>' +
      '<label class="ins-field"><span>最小高</span>' + numberInput('minHeight', n.minHeight, 0) + '</label>' +
      '</div>'
    );

    if (n.type === 'text') {
      html += section('文本内容',
        field('静态文本', textInput('text', n.text)) +
        field('绑定变量', textInput('textVar', n.textVar, '如 nickname；无 dataBinding 时导出会剥离')) +
        field('数据绑定(dataBinding)', textInput('dataBinding', n.dataBinding, '运行时真实数据路径，留空=假数据')) +
        colorField('颜色', n.color)
      );
    } else if (n.type === 'icon') {
      html += section('图标',
        '<label class="ins-field"><span>图标</span><select data-prop="icon">' +
        root.ULCIcons.names.map(function (nm) {
          return '<option value="' + nm + '"' + (nm === n.icon ? ' selected' : '') + '>' + nm + '</option>';
        }).join('') + '</select></label>' + colorField('颜色', n.color) +
        '<div class="ins-icon-preview" style="color:' + n.color + '">' + root.ULCIcons.svg(n.icon, 28) + '</div>'
      );
    } else if (n.type === 'bar') {
      html += section('条形',
        '<label class="ins-field"><span>当前值</span>' + numberInput('fill', n.fill, 0) + '</label>' +
        field('值绑定变量', textInput('fillVar', n.fillVar, '如 hp')) +
        '<label class="ins-field"><span>最大值</span>' + numberInput('fillMax', n.fillMax, 1) + '</label>' +
        '<label class="ins-field"><span>条高</span>' + numberInput('barHeight', n.barHeight, 2) + '</label>' +
        colorField('颜色', n.color)
      );
    } else if (n.type === 'edge') {
      html += section('边缘组件', colorField('颜色', n.color) +
        '<div class="ins-hint">边缘组件本身不参与遮挡检测，只作为其它组件的定位参照</div>');
    } else {
      html += section('外观', colorField('背景色', n.color) +
        '<div class="ins-hint">填 transparent 表示透明容器</div>');
    }

    html += section('主动隐藏条件', conditionEditor(n) +
      '<div class="ins-hint">条件满足时组件主动隐藏，依赖它定位的组件会收到参照隐藏报错并提示改锚屏幕</div>');

    this.el.innerHTML = html;
  };

  Inspector.prototype._refOptions = function (n) {
    var self = this;
    var opts = '<option value="' + M.SCREEN_ID + '">屏幕边缘（含安全区）</option>';
    this.nodes.forEach(function (x) {
      if (x.id === n.id) return;
      if (M.ancestorIds(self.nodes, n.id).indexOf(x.id) >= 0) return;
      opts += '<option value="' + x.id + '">' + escapeHtml(x.name) +
        (x.type === 'edge' ? '（边缘）' : '') + '</option>';
    });
    return opts;
  };

  Inspector.prototype._bind = function () {
    var self = this;
    this.el.addEventListener('input', function (ev) {
      if (!self.node) return;
      var t = ev.target;
      var prop = t.dataset.prop;
      if (!prop) return;
      var rawVal = t.type === 'checkbox' ? t.checked
        : t.type === 'number' ? Number(t.value) : t.value;
      if (prop === 'widthValue' || prop === 'heightValue') {
        var sizeProp = prop === 'widthValue' ? 'width' : 'height';
        var spec = JSON.parse(JSON.stringify(self.node[sizeProp]));
        spec.value = Number(rawVal);
        self.onEdit([{ kind: 'setNodeProp', nodeId: self.node.id, prop: sizeProp, value: spec }]);
        return;
      }
      if (prop === 'padV' || prop === 'padH') {
        var pad = self.node.padding.slice();
        pad[prop === 'padV' ? 0 : 1] = Number(rawVal);
        self.onEdit([{ kind: 'setNodeProp', nodeId: self.node.id, prop: 'padding', value: pad }]);
        return;
      }
      self.onEdit([{ kind: 'setNodeProp', nodeId: self.node.id, prop: prop, value: rawVal }]);
    });
    this.el.addEventListener('change', function (ev) {
      if (!self.node) return;
      var t = ev.target;
      // 尺寸模式
      if (t.dataset.sizeprop) {
        var sp = t.dataset.sizeprop;
        var spec = JSON.parse(JSON.stringify(self.node[sp]));
        spec.mode = t.value;
        self.onEdit([{ kind: 'setNodeProp', nodeId: self.node.id, prop: sp, value: spec }]);
        return;
      }
      if (t.dataset.anchorslot) {
        self._anchorChange(t);
        return;
      }
      if (t.dataset.condop) {
        self._condChange(t);
      }
    });
    this.el.addEventListener('click', function (ev) {
      if (!ev.target.matches('.ins-cond-add')) return;
      var cond = self.node.hiddenWhen ? JSON.parse(JSON.stringify(self.node.hiddenWhen))
        : { any: [{ var: '__screenWidth__', op: '<', value: 360 }] };
      if (!cond.any) cond = { any: [cond] };
      cond.any.push({ var: '__screenWidth__', op: '<', value: 360 });
      self.onEdit([{ kind: 'setNodeProp', nodeId: self.node.id, prop: 'hiddenWhen', value: cond }]);
    });
  };

  Inspector.prototype._anchorChange = function (t) {
    var slot = t.dataset.anchorslot;
    var field = t.dataset.anchorfield;
    var cur = this.node[slot] ? JSON.parse(JSON.stringify(this.node[slot])) : null;
    if (field === 'enabled') {
      if (t.checked) {
        cur = E.screenAnchorFor(slot);
      } else cur = null;
    } else if (!cur) return;
    else if (field === 'ref') cur.ref = t.value;
    else if (field === 'edge') cur.edge = t.value;
    else if (field === 'mode') cur.mode = t.value;
    else if (field === 'align') cur.align = t.value;
    else if (field === 'value') cur.value = Number(t.value) || 0;
    this.onEdit([{ kind: 'setAnchor', nodeId: this.node.id, slot: slot, anchor: cur }]);
  };

  Inspector.prototype._condChange = function (t) {
    var idx = Number(t.dataset.condidx);
    var cond = JSON.parse(JSON.stringify(this.node.hiddenWhen || { any: [] }));
    if (!cond.any) cond = { any: [cond] };
    var item = cond.any[idx];
    if (!item) return;
    var f = t.dataset.condfield;
    if (f === 'var') item.var = t.value;
    else if (f === 'op') item.op = t.value;
    else if (f === 'value') {
      item.value = t.value === 'true' ? true : t.value === 'false' ? false : isNaN(Number(t.value)) ? t.value : Number(t.value);
    }
    this.onEdit([{ kind: 'setNodeProp', nodeId: this.node.id, prop: 'hiddenWhen', value: cond }]);
  };

  /* ---------- 片段构造 ---------- */

  function section(title, body) {
    return '<div class="ins-section"><h4>' + title + '</h4>' + body + '</div>';
  }
  function field(label, input) {
    return '<label class="ins-field"><span>' + label + '</span>' + input + '</label>';
  }
  function textInput(prop, val, placeholder) {
    return '<input type="text" data-prop="' + prop + '" value="' + escapeHtml(val || '') + '"' +
      (placeholder ? ' placeholder="' + escapeHtml(placeholder) + '"' : '') + '>';
  }
  function numberInput(prop, val, min) {
    return '<input type="number" data-prop="' + prop + '" value="' + (val || 0) + '"' +
      (min != null ? ' min="' + min + '"' : '') + '>';
  }
  function colorField(label, val) {
    return '<label class="ins-field"><span>' + label + '</span>' +
      '<input type="text" data-prop="color" value="' + escapeHtml(val || '') + '"></label>';
  }
  function sizeEditor(prop, label, spec) {
    return '<label class="ins-field"><span>' + label + '模式</span><select data-sizeprop="' + prop + '">' +
      ['content', 'fixed', 'fill'].map(function (m) {
        return '<option value="' + m + '"' + (m === spec.mode ? ' selected' : '') + '>' +
          ({ content: '随内容', fixed: '固定值', fill: '填满参照' })[m] + '</option>';
      }).join('') + '</select></label>' +
      (spec.mode === 'fixed'
        ? '<label class="ins-field"><span>' + label + '数值</span>' +
          '<input type="number" data-prop="' + prop + 'Value" value="' + spec.value + '"></label>'
        : '');
  }

  function anchorEditor(slot, n, refOptions) {
    var a = n[slot];
    var edges = slot.indexOf('left') >= 0 || slot.indexOf('right') >= 0
      ? [['left', '左边缘'], ['right', '右边缘']]
      : [['top', '上边缘'], ['bottom', '下边缘']];
    var checked = a ? ' checked' : '';
    var body = a ? (
      '<div class="ins-anchor-body">' +
      '<select data-anchor-slot="' + slot + '" data-anchorfield="ref">' +
      refOptions.replace('value="' + a.ref + '"', 'value="' + a.ref + '" selected') + '</select>' +
      '<select data-anchor-slot="' + slot + '" data-anchorfield="edge">' +
      edges.map(function (e) { return '<option value="' + e[0] + '"' + (e[0] === a.edge ? ' selected' : '') + '>' + e[1] + '</option>'; }).join('') +
      '</select>' +
      '<select data-anchor-slot="' + slot + '" data-anchorfield="mode">' +
      [['fixed', '固定边距'], ['ratio', '比例位置']].map(function (e) {
        return '<option value="' + e[0] + '"' + (e[0] === a.mode ? ' selected' : '') + '>' + e[1] + '</option>';
      }).join('') + '</select>' +
      (a.mode === 'ratio'
        ? '<select data-anchor-slot="' + slot + '" data-anchorfield="align">' +
          [['start', '起点对齐'], ['center', '居中'], ['end', '末端对齐']].map(function (e) {
            return '<option value="' + e[0] + '"' + ((a.align || 'start') === e[0] ? ' selected' : '') + '>' + e[1] + '</option>';
          }).join('') + '</select>' : '') +
      '<label class="ins-anchor-value"><span>' + (a.mode === 'ratio' ? '比例(0~1)' : '边距px') + '</span>' +
      '<input type="number" step="0.01" data-anchor-slot="' + slot + '" data-anchorfield="value" value="' + a.value + '"></label>' +
      '</div>'
    ) : '';
    return '<div class="ins-anchor"><label class="ins-check"><input type="checkbox" data-anchor-slot="' + slot +
      '" data-anchorfield="enabled"' + checked + '> ' + E.slotLabel(slot) + '</label>' + body + '</div>';
  }

  function conditionEditor(n) {
    if (!n.hiddenWhen) {
      return '<button class="ins-cond-add">＋ 添加隐藏条件</button>';
    }
    var cond = n.hiddenWhen;
    var items = (cond.any || cond.all || [cond]).filter(function (c) { return c.var; });
    var vars = [
      ['__screenWidth__', '屏幕宽度'], ['__screenHeight__', '屏幕高度'], ['__orientation__', '屏幕方向'],
      ['paused', '暂停中'], ['rightSidebarVisible', '右侧栏可见'], ['nicknameLong', '长昵称'], ['hp', '生命值']
    ];
    var ops = [['==', '等于'], ['!=', '不等于'], ['<', '小于'], ['>', '大于'], ['<=', '不大于'], ['>=', '不小于']];
    return '<div class="ins-conds">' + items.map(function (c, i) {
      return '<div class="ins-cond-row">' +
        '<select data-condop data-condidx="' + i + '" data-condfield="var">' +
        vars.map(function (v) { return '<option value="' + v[0] + '"' + (v[0] === c.var ? ' selected' : '') + '>' + v[1] + '</option>'; }).join('') +
        '</select>' +
        '<select data-condop data-condidx="' + i + '" data-condfield="op">' +
        ops.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === c.op ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
        '</select>' +
        '<input data-condop data-condidx="' + i + '" data-condfield="value" value="' + escapeHtml(String(c.value)) + '">' +
        '</div>';
    }).join('') + '<button class="ins-cond-add">＋ 添加条件（任一满足即隐藏）</button></div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  root.ULCInspector = Inspector;
})(typeof self !== 'undefined' ? self : this);
