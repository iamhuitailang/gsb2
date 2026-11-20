import './style.css';
import { App } from './app';

const boot = (): void => {
  try {
    const app = new App();
    const params = new URLSearchParams(window.location.search);

    // 自动化/演示钩子：普通使用不受影响
    if (params.get('selftest') === '1') {
      void app.runSelfCheck();
    } else if (params.get('sample') === '1') {
      const mode = params.get('mode');
      if (mode === 'wireframe' || mode === 'normal' || mode === 'material') {
        app.setDisplayModeForBoot(mode);
      }
      const env = params.get('env');
      if (env === 'studio' || env === 'daylight' || env === 'night') {
        app.setEnvironmentForBoot(env);
      }
      void app.loadSample();
    }
  } catch (err) {
    const empty = document.getElementById('empty-state');
    if (empty) {
      empty.innerHTML = '';
      empty.append(
        Object.assign(document.createElement('p'), {
          textContent: `初始化失败：${(err as Error).message}`,
        }),
      );
      empty.classList.remove('hidden');
    }
    console.error(err);
  }
};

boot();
