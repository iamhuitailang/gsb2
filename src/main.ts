import './styles.css';
import { App } from './App';
import { store } from './state/store';
import { EXAMPLES } from './examples';

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 挂载点');

// 启动顺序：优先恢复本地自动保存，否则载入第一个示例（保证打开即有可运行内容）
const autosaved = store.loadAutosave();
if (autosaved) {
  store.loadProject(autosaved);
} else {
  store.loadProject(EXAMPLES[0].project);
}

new App(root);
