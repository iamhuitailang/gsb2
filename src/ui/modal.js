/* modal.js — 通用弹窗（确认 / 表单 / 自定义内容）
 * 用弹窗栈 + 单一 document 监听器管理 Esc，避免监听器泄漏后误关后续弹窗。
 */
(function (global) {
  'use strict';

  var modalRoot = null;
  var stack = []; // 当前打开的弹窗实例（理论上同时只有一个，栈结构便于扩展）
  var docKeyBound = false;

  function ensureRoot() {
    if (!modalRoot) modalRoot = document.getElementById('modalRoot');
    return modalRoot;
  }

  function onDocumentKey(e) {
    if (e.key !== 'Escape' || stack.length === 0) return;
    var top = stack[stack.length - 1];
    if (top && top.handleCancel) top.handleCancel();
  }

  function close() {
    var instance = stack.pop();
    var root = ensureRoot();
    if (stack.length === 0) root.innerHTML = '';
    else {
      // 嵌套场景：移除本实例节点，保留下层
      if (instance && instance.backdrop && instance.backdrop.parentNode === root) {
        root.removeChild(instance.backdrop);
      }
    }
    if (stack.length === 0 && docKeyBound) {
      document.removeEventListener('keydown', onDocumentKey, true);
      docKeyBound = false;
    }
  }

  function open(options) {
    var root = ensureRoot();
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'modal';
    if (options.width) modal.style.width = typeof options.width === 'number' ? options.width + 'px' : options.width;

    var head = document.createElement('div');
    head.className = 'modal-head';
    var h = document.createElement('h2');
    h.style.fontSize = '16px';
    h.textContent = options.title || '';
    var x = document.createElement('button');
    x.className = 'modal-close';
    x.innerHTML = '&times;';
    x.setAttribute('aria-label', '关闭');
    head.appendChild(h); head.appendChild(x);

    var body = document.createElement('div');
    body.className = 'modal-body';
    if (typeof options.bodyHTML === 'string') body.innerHTML = options.bodyHTML;
    else if (options.bodyNode) body.appendChild(options.bodyNode);

    var foot = document.createElement('div');
    foot.className = 'modal-foot';
    var instance = { backdrop: backdrop, handleCancel: null };
    var closed = false;
    function handleOk() {
      if (closed) return;
      if (options.onOk && options.onOk(body, close) === false) return;
      closed = true; close();
    }
    function handleCancel() {
      if (closed) return;
      closed = true;
      if (options.onCancel) options.onCancel();
      close();
    }
    instance.handleCancel = handleCancel;
    x.addEventListener('click', handleCancel);

    if (options.customFooter) {
      options.customFooter(foot, close, body);
    } else {
      if (options.cancelText !== null) {
        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn';
        cancelBtn.textContent = options.cancelText || '取消';
        cancelBtn.addEventListener('click', handleCancel);
        foot.appendChild(cancelBtn);
      }
      var okBtn = document.createElement('button');
      okBtn.className = 'btn btn-primary';
      okBtn.textContent = options.okText || '确定';
      okBtn.addEventListener('click', handleOk);
      foot.appendChild(okBtn);
    }

    backdrop.addEventListener('mousedown', function (e) {
      if (e.target === backdrop && options.dismissOnBackdrop !== false) handleCancel();
    });

    modal.appendChild(head);
    modal.appendChild(body);
    modal.appendChild(foot);
    backdrop.appendChild(modal);
    root.innerHTML = '';
    root.appendChild(backdrop);

    stack.push(instance);
    if (!docKeyBound) {
      document.addEventListener('keydown', onDocumentKey, true);
      docKeyBound = true;
    }

    if (options.onOpen) options.onOpen(body);
    return { close: close, body: body, modal: modal };
  }

  function confirm(title, message, okText, danger) {
    return new Promise(function (resolve) {
      open({
        title: title,
        bodyHTML: '<p style="margin:4px 0;line-height:1.7">' + escapeHtml(message).replace(/\n/g, '<br>') + '</p>',
        okText: okText || '确定',
        onOk: function () { resolve(true); },
        onCancel: function () { resolve(false); }
      });
      if (danger) {
        setTimeout(function () {
          var b = modalRoot.querySelector('.modal-foot .btn-primary');
          if (b) { b.classList.remove('btn-primary'); b.classList.add('btn-danger'); }
        }, 0);
      }
    });
  }

  function prompt(title, label, initialValue) {
    return new Promise(function (resolve) {
      open({
        title: title,
        bodyHTML:
          '<div class="form-row"><label>' + escapeHtml(label || '名称') + '</label>' +
          '<input class="modal-input" type="text" value="' + escapeHtml(initialValue || '') + '"></div>',
        onOpen: function (body) {
          var input = body.querySelector('input');
          input.focus();
          input.select();
          input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
              var ok = modalRoot.querySelector('.modal-foot .btn-primary');
              if (ok) ok.click();
            }
          });
        },
        onOk: function (body) {
          resolve(body.querySelector('input').value);
        },
        onCancel: function () { resolve(null); }
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  global.Modal = { open: open, close: close, confirm: confirm, prompt: prompt, escapeHtml: escapeHtml };
})(window);
