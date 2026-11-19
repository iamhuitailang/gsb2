import { AppState } from './app/state.js';
import { mountApp } from './ui/app.js';

function boot() {
  const state = new AppState();
  // 首次打开先载入程序绘制的样例，用户可直接看到循环效果。
  state.loadSample();
  state.setStatus('已载入样例「苔灯蘑菇」：8 帧非等时长循环，可随时新建空白工程');
  mountApp(state);
  // 方便在控制台调试，也让自动化测试能拿到状态。
  window.pixanim = state;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
