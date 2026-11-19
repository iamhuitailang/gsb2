/* 项目持久化：序列化为 JSON，可保存到 localStorage 或导出为文件；
 * 恢复时还原图层树结构、图像引用（生成器 id）与全部编辑参数。 */
window.App = window.App || {};

App.persistence = (function () {
  const STORAGE_KEY = 'compositor.project.v1';

  function serialize(state) {
    return JSON.stringify({
      version: 1,
      doc: { width: state.doc.width, height: state.doc.height },
      layers: state.root.children.map(App.model.serializeLayer)
    });
  }

  /* 把 JSON 字符串恢复进 state（替换整个图层树），并清空撤销栈 */
  function restore(state, json) {
    const data = JSON.parse(json);
    state.doc.width = data.doc.width;
    state.doc.height = data.doc.height;
    const onMaskLoaded = () => App.requestRender && App.requestRender();
    state.root.children = (data.layers || []).map(o =>
      App.model.deserializeLayer(o, state.doc.width, state.doc.height, onMaskLoaded));
    state.selectedId = null;
    state.maskEditId = null;
    App.history.clear();
    App.refreshUI();
    App.requestRender();
  }

  function saveToLocal(state) {
    localStorage.setItem(STORAGE_KEY, serialize(state));
  }

  function loadFromLocal(state) {
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) return false;
    try {
      restore(state, json);
      return true;
    } catch (e) {
      console.error('本地项目恢复失败', e);
      return false;
    }
  }

  function hasLocal() {
    return !!localStorage.getItem(STORAGE_KEY);
  }

  function exportFile(state) {
    App.util.downloadText(serialize(state), 'project.compositor.json');
  }

  function exportPNG(state) {
    const comp = App.render.renderDocument(state);
    App.util.download(comp.toDataURL('image/png'), 'composite.png');
  }

  return { serialize, restore, saveToLocal, loadFromLocal, hasLocal, exportFile, exportPNG };
})();
