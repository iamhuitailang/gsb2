import { rasterToCanvas } from './rasterCanvas.ts';
import type { Project, RasterImage } from '../core/types.ts';

export interface PreviewHost {
  getProject(): Project;
  getImage(): RasterImage | undefined;
  getStatus(): { stale: boolean; errors: { nodeName: string; message: string }[] };
  resolutionChanged(resolution: number): void;
  zoomChanged(zoom: number): void;
  exportPng(): void;
}

export interface PreviewPanel {
  root: HTMLElement;
  refresh(): void;
}

export const RESOLUTIONS = [128, 256, 384, 512, 768];
export const ZOOM_STEPS = [0, 0.5, 1, 2, 4];

export function createPreviewPanel(host: PreviewHost): PreviewPanel {
  const root = document.createElement('section');
  root.className = 'preview-panel';

  const head = document.createElement('div');
  head.className = 'panel-head';
  const title = document.createElement('div');
  title.className = 'panel-title';
  title.textContent = '输出预览';
  const exportButton = document.createElement('button');
  exportButton.className = 'btn small';
  exportButton.textContent = '导出 PNG';
  exportButton.addEventListener('click', () => host.exportPng());
  head.append(title, exportButton);

  const controls = document.createElement('div');
  controls.className = 'preview-controls';

  const resLabel = document.createElement('label');
  resLabel.textContent = '尺寸';
  const resSelect = document.createElement('select');
  resSelect.className = 'select';
  for (const size of RESOLUTIONS) {
    const option = document.createElement('option');
    option.value = String(size);
    option.textContent = `${size} × ${size}`;
    resSelect.append(option);
  }
  resSelect.addEventListener('change', () => host.resolutionChanged(Number(resSelect.value)));

  const zoomLabel = document.createElement('label');
  zoomLabel.textContent = '缩放';
  const zoomSelect = document.createElement('select');
  zoomSelect.className = 'select';
  for (const step of ZOOM_STEPS) {
    const option = document.createElement('option');
    option.value = String(step);
    option.textContent = step === 0 ? '自适应' : `${Math.round(step * 100)}%`;
    zoomSelect.append(option);
  }
  zoomSelect.addEventListener('change', () => host.zoomChanged(Number(zoomSelect.value)));

  const fitButton = document.createElement('button');
  fitButton.className = 'btn small';
  fitButton.textContent = '适应';
  fitButton.title = '将预览缩放到面板大小';
  fitButton.addEventListener('click', () => {
    host.zoomChanged(0);
  });

  controls.append(resLabel, resSelect, zoomLabel, zoomSelect, fitButton);

  const stage = document.createElement('div');
  stage.className = 'preview-stage';
  const canvas = document.createElement('canvas');
  canvas.id = 'preview-canvas';
  const empty = document.createElement('div');
  empty.className = 'preview-empty';
  empty.textContent = '还没有可预览的输出。选中「输出」节点并连接一个输入，或从左侧加载示例项目。';
  stage.append(canvas, empty);

  const meta = document.createElement('div');
  meta.className = 'preview-meta';
  const metaLeft = document.createElement('span');
  const metaRight = document.createElement('span');
  meta.append(metaLeft, metaRight);

  const errorsBox = document.createElement('div');
  errorsBox.className = 'preview-errors';
  errorsBox.style.display = 'none';

  root.append(head, controls, stage, meta, errorsBox);

  const ctx = canvas.getContext('2d');

  const draw = (): void => {
    const image = host.getImage();
    if (!image) {
      canvas.style.display = 'none';
      empty.style.display = 'block';
      metaLeft.textContent = '无输出';
      metaRight.textContent = '';
      return;
    }
    empty.style.display = 'none';
    canvas.style.display = 'block';
    if (canvas.width !== image.width || canvas.height !== image.height) {
      canvas.width = image.width;
      canvas.height = image.height;
    }
    ctx?.clearRect(0, 0, image.width, image.height);
    ctx?.drawImage(rasterToCanvas(image), 0, 0);
    applyZoom();
    metaLeft.textContent = `${image.width} × ${image.height}`;
  };

  const applyZoom = (): void => {
    const image = host.getImage();
    if (!image) return;
    const project = host.getProject();
    let scale = project.preview.zoom;
    const stageRect = stage.getBoundingClientRect();
    if (scale === 0) {
      const availableWidth = Math.max(80, stageRect.width - 22);
      const availableHeight = Math.max(80, Math.min(window.innerHeight * 0.38, stageRect.height));
      scale = Math.min(availableWidth / image.width, availableHeight / image.height, 2);
      scale = Math.max(0.1, scale);
    }
    canvas.style.width = `${Math.round(image.width * scale)}px`;
    canvas.style.height = `${Math.round(image.height * scale)}px`;
    canvas.classList.toggle('pixelated', scale >= 2);
    metaRight.textContent = `${Math.round(scale * 100)}%`;
  };

  const refresh = (): void => {
    const project = host.getProject();
    resSelect.value = String(project.preview.resolution);
    zoomSelect.value = String(project.preview.zoom);
    draw();
    const status = host.getStatus();
    // Keep it simple: errors are listed, and a note explains why the image
    // shown may be older than the current graph.
    if (status.errors.length === 0 && !status.stale) {
      errorsBox.style.display = 'none';
      errorsBox.replaceChildren();
      return;
    }
    errorsBox.style.display = 'block';
    errorsBox.replaceChildren();
    for (const item of status.errors.slice(0, 4)) {
      const line = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = item.nodeName;
      line.append(name, document.createTextNode(`：${item.message}`));
      errorsBox.append(line);
    }
    if (status.errors.length > 4) {
      const more = document.createElement('div');
      more.textContent = `还有 ${status.errors.length - 4} 个节点报错`;
      errorsBox.append(more);
    }
    if (status.stale) {
      const stale = document.createElement('span');
      stale.className = 'stale';
      stale.textContent = '当前显示的是上一次可用的预览。';
      errorsBox.append(stale);
    }
  };

  window.addEventListener('resize', () => {
    if (host.getProject().preview.zoom === 0) applyZoom();
  });
  new ResizeObserver(() => {
    if (host.getProject().preview.zoom === 0) applyZoom();
  }).observe(stage);

  return {
    root,
    refresh,
  };
}
