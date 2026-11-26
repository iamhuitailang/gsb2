import type { ResolvedCameraState } from '../core/types';
import { EASING_OPTIONS } from '../core/easing';
import { h, section } from './dom';

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}
function vec(n: readonly number[]): string {
  return `(${n.map((v) => fmt(v)).join(', ')})`;
}

const KIND_LABEL: Record<string, { text: string; cls: string }> = {
  clear: { text: '通畅', cls: 'ok' },
  'pull-in': { text: '前移避让', cls: 'warn' },
  'side-shift': { text: '侧向避让', cls: 'warn' },
  raise: { text: '抬高避让', cls: 'warn' },
  combined: { text: '组合避让', cls: 'warn' },
  forced: { text: '强制贴近', cls: 'danger' },
};

export class Inspector {
  readonly el: HTMLElement;

  private zoneValue = h('span', { id: 'insp-zone', class: 'zone-badge' }, '—');
  private overlapValue = h('div', { id: 'insp-overlap', class: 'chip-row' });
  private hystValue = h('div', { class: 'muted tiny' });
  private transBar = h('div', { id: 'insp-trans-bar', class: 'progress-bar' }, h('i'));
  private transInfo = h('div', { id: 'insp-trans-info', class: 'muted tiny' }, '无过渡');

  private targetPos = h('span', { id: 'insp-target-pos' });
  private targetYaw = h('span', { id: 'insp-target-yaw' });

  private finalPos = h('span', { id: 'insp-final-pos' });
  private lookAt = h('span', { id: 'insp-lookat' });
  private finalDist = h('span', { id: 'insp-final-dist' });
  private fov = h('span', { id: 'insp-fov' });
  private bounds = h('span', { id: 'insp-bounds' });

  private pDistance = h('span', { id: 'insp-p-distance' });
  private pHeight = h('span', {});
  private pShoulder = h('span', {});
  private pPitch = h('span', {});
  private pYawOff = h('span', {});
  private pLookAhead = h('span', {});

  private occBadge = h('span', { id: 'insp-occ-badge', class: 'occ-badge ok' }, '通畅');
  private occReason = h('div', { id: 'insp-occ-reason', class: 'reason-text' }, '—');
  private occDetail = h('div', { id: 'insp-occ-detail', class: 'muted tiny' });
  private attempts = h('div', { id: 'insp-attempts', class: 'attempt-list' });
  private lastAttemptKey = '';

  constructor() {
    const zoneSec = section(
      '当前镜头区域',
      h(
        'div',
        { class: 'inspect-block' },
        h('div', { class: 'inspect-line big' }, this.zoneValue),
        this.overlapValue,
        this.hystValue,
        h('div', { class: 'progress' }, this.transBar),
        this.transInfo,
      ),
    );

    const targetSec = section(
      '跟随目标（假角色）',
      h(
        'div',
        { class: 'kv' },
        kv('坐标', this.targetPos),
        kv('朝向 yaw', this.targetYaw),
      ),
    );

    const finalSec = section(
      '最终镜头参数',
      h(
        'div',
        {},
        h(
          'div',
          { class: 'kv' },
          kv('机位', this.finalPos),
          kv('注视点', this.lookAt),
          kv('实际距离', this.finalDist),
          kv('FOV', this.fov),
          kv('边界', this.bounds),
        ),
        h('div', { class: 'param-grid' }, [
          miniParam('距离', this.pDistance),
          miniParam('高度', this.pHeight),
          miniParam('肩偏', this.pShoulder),
          miniParam('俯仰', this.pPitch),
          miniParam('角偏', this.pYawOff),
          miniParam('前视', this.pLookAhead),
        ]),
      ),
    );

    const occSec = section(
      '遮挡与避让',
      h(
        'div',
        {},
        h('div', { class: 'inspect-line' }, this.occBadge),
        this.occReason,
        this.occDetail,
        h('div', { class: 'attempt-head tiny muted' }, '候选机位探测（绿=视线通畅）'),
        this.attempts,
      ),
    );

    const tip = h(
      'div',
      { class: 'help-box' },
      h('p', { class: 'muted tiny' }, '暂停时间轴后仍可旋转调试视角检查；拖动进度条会把镜头精确吸附到该帧。顶部可切换到「游戏镜头视角」。'),
    );

    this.el = h('div', { class: 'inspector-inner', id: 'inspector' }, zoneSec, targetSec, finalSec, occSec, tip);
  }

  update(s: ResolvedCameraState, zoneColor?: string) {
    this.zoneValue.textContent = s.zoneName;
    if (zoneColor) {
      this.zoneValue.style.background = hexA(zoneColor, 0.18);
      this.zoneValue.style.borderColor = zoneColor;
      this.zoneValue.style.color = zoneColor;
    }

    this.overlapValue.innerHTML = '';
    if (s.overlappingZoneIds.length > 1) {
      s.overlappingZoneIds.forEach((id) =>
        this.overlapValue.append(h('span', { class: 'chip' }, id)),
      );
    }
    this.hystValue.textContent = s.hysteresisKept ? '目标短暂越界，当前区域由滞回保持' : '';

    const barInner = this.transBar.firstElementChild as HTMLElement;
    barInner.style.width = `${fmt(s.transition.t * 100, 1)}%`;
    if (s.transition.active) {
      const easingLabel = EASING_OPTIONS.find((e) => e.value === s.transition.easing)?.label ?? s.transition.easing;
      this.transInfo.textContent = `${s.fromZoneName ?? '默认'} → ${s.zoneName}：${s.transition.elapsed.toFixed(2)} / ${s.transition.duration.toFixed(2)}s · ${easingLabel}`;
    } else {
      this.transInfo.textContent = s.fromZoneName ? `已过渡到「${s.zoneName}」` : '无过渡（默认参数）';
      barInner.style.width = '100%';
    }

    this.targetPos.textContent = vec(s.target);
    this.targetYaw.textContent = `${fmt((s.targetYaw * 180) / Math.PI, 0)}°`;

    this.finalPos.textContent = vec(s.finalPosition);
    this.lookAt.textContent = vec(s.lookAt);
    this.finalDist.textContent = `${fmt(distance(s.finalPosition, s.target), 2)} m（到脚底）`;
    this.fov.textContent = `${fmt(s.fov, 1)}°`;
    if (!s.boundsActive) {
      this.bounds.textContent = '未启用';
      this.bounds.className = 'bounds-state';
    } else if (s.boundsClamped) {
      this.bounds.textContent = '生效中 · 本帧触发 clamp';
      this.bounds.className = 'bounds-state clamp';
    } else {
      this.bounds.textContent = '生效中 · 未触边';
      this.bounds.className = 'bounds-state active';
    }

    this.pDistance.textContent = fmt(s.params.distance, 2);
    this.pHeight.textContent = fmt(s.params.height, 2);
    this.pShoulder.textContent = fmt(s.params.shoulder, 2);
    this.pPitch.textContent = `${fmt(s.params.pitch, 0)}°`;
    this.pYawOff.textContent = `${fmt(s.params.yawOffset, 0)}°`;
    this.pLookAhead.textContent = fmt(s.params.lookAhead, 2);

    const kind = KIND_LABEL[s.occlusion.kind] ?? KIND_LABEL.clear;
    this.occBadge.textContent = kind.text;
    this.occBadge.className = `occ-badge ${kind.cls}`;
    this.occReason.textContent = s.occlusion.reason;
    if (s.occlusion.hitObjectName) {
      this.occDetail.textContent = `命中：${s.occlusion.hitObjectName} · 命中距离 ${s.occlusion.hitDistance?.toFixed(2)}m · 期望 ${s.occlusion.desiredDistance.toFixed(2)}m → 最终 ${s.occlusion.finalDistance.toFixed(2)}m`;
    } else {
      this.occDetail.textContent = `期望距离 ${s.occlusion.desiredDistance.toFixed(2)}m`;
    }

    // 候选列表只在内容变化时重建
    const key = s.occlusion.attempts
      .map((a) => `${a.label}|${a.clear}|${a.hitName ?? ''}`)
      .join(';;');
    if (key !== this.lastAttemptKey) {
      this.lastAttemptKey = key;
      this.attempts.innerHTML = '';
      s.occlusion.attempts.slice(0, 14).forEach((a) => {
        this.attempts.append(
          h(
            'div',
            { class: `attempt-row ${a.clear ? 'clear' : 'blocked'}` },
            h('span', { class: 'dot2' }),
            h('span', { class: 'attempt-label' }, a.label),
            h('span', { class: 'attempt-hit' }, a.clear ? '✓' : (a.hitName ?? '遮挡')),
          ),
        );
      });
    }
  }
}

function kv(label: string, valueEl: HTMLElement) {
  return h('div', { class: 'kv-row' }, h('dt', {}, label), h('dd', {}, valueEl));
}

function miniParam(label: string, valueEl: HTMLElement) {
  return h('div', { class: 'mini-param' }, h('span', { class: 'mp-label' }, label), valueEl);
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
