/*
 * issues.js — 排版问题列表：定位打架的两个约束，提供修复建议
 */
(function (root) {
  'use strict';

  var KIND_META = {
    error: { label: '错误', cls: 'iss-error' },
    conflict: { label: '约束冲突', cls: 'iss-conflict' },
    warning: { label: '警告', cls: 'iss-warning' }
  };

  function IssuesView(opts) {
    this.el = opts.el;
    this.onSelect = opts.onSelect;
    this.onApplyFix = opts.onApplyFix;
    this.onLocate = opts.onLocate;
  }

  IssuesView.prototype.render = function (result, nodes, filter) {
    var self = this;
    var groups = ['error', 'conflict', 'warning'];
    var html = '';
    groups.forEach(function (kind) {
      var list = result.issues.filter(function (i) { return i.kind === kind; });
      if (filter !== 'all' && filter !== kind) return;
      if (!list.length) return;
      var meta = KIND_META[kind];
      html += '<div class="iss-group ' + meta.cls + '"><h5>' + meta.label + '（' + list.length + '）</h5>';
      list.forEach(function (iss, idx) {
        html += '<div class="iss-item" data-issue-idx="' + result.issues.indexOf(iss) + '">' +
          '<div class="iss-msg">' + esc(iss.message) + '</div>';
        if (iss.nodeIds.length) {
          html += '<div class="iss-nodes">' + iss.nodeIds.map(function (id) {
            var n = root.ULCModel.findNode(nodes, id);
            return '<button class="iss-node" data-node="' + id + '">' + esc(n ? n.name : id) + '</button>';
          }).join('') + '</div>';
        }
        if (iss.fixSuggestions && iss.fixSuggestions.length) {
          html += '<div class="iss-fixes">' + iss.fixSuggestions.map(function (fx, fi) {
            return '<button class="iss-fix" data-fix-issue="' + result.issues.indexOf(iss) + '" data-fix-idx="' + fi + '">🔧 ' + esc(fx.label) + '</button>';
          }).join('') + '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    });
    if (!html) html = '<div class="iss-ok">✓ 当前屏幕与状态下没有发现排版问题</div>';
    this.el.innerHTML = html;

    this.el.querySelectorAll('.iss-node').forEach(function (btn) {
      btn.onclick = function () {
        self.onSelect(btn.dataset.node);
        self.onLocate(btn.dataset.node);
      };
    });
    this.el.querySelectorAll('.iss-fix').forEach(function (btn) {
      btn.onclick = function () {
        var iss = result.issues[Number(btn.dataset.fixIssue)];
        var fx = iss.fixSuggestions[Number(btn.dataset.fixIdx)];
        self.onApplyFix(fx, iss);
      };
    });
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  root.ULCIssuesView = IssuesView;
})(typeof self !== 'undefined' ? self : this);
