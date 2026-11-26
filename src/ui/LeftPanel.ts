import type { AppDeps } from './deps';
import { h } from './dom';
import { renderCameraTab } from './CameraTab';
import { renderRouteTab } from './RouteTab';
import { renderZoneTab } from './ZoneTab';

type TabId = 'zones' | 'camera' | 'route';

export class LeftPanel {
  readonly el: HTMLElement;
  private body = h('div', { class: 'tab-body' });
  private active: TabId = 'zones';

  constructor(private deps: AppDeps) {
    const tabs: { id: TabId; label: string }[] = [
      { id: 'zones', label: '镜头区域' },
      { id: 'camera', label: '跟随 / 遮挡' },
      { id: 'route', label: '测试路线' },
    ];
    const tabBar = h(
      'div',
      { class: 'tab-bar' },
      ...tabs.map((t) =>
        h(
          'button',
          {
            class: `tab-btn ${this.active === t.id ? 'active' : ''}`,
            onclick: (ev: MouseEvent) => {
              this.active = t.id;
              this.el.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
              (ev.currentTarget as HTMLElement).classList.add('active');
              this.rerender();
            },
          },
          t.label,
        ),
      ),
    );
    this.el = h('div', { class: 'left-panel-inner' }, tabBar, this.body);
    this.rerender();
  }

  rerender() {
    this.body.innerHTML = '';
    if (this.active === 'zones') this.body.append(renderZoneTab(this.deps));
    if (this.active === 'camera') this.body.append(renderCameraTab(this.deps));
    if (this.active === 'route') this.body.append(renderRouteTab(this.deps));
  }
}
