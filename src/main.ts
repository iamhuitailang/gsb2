import './styles.css';
import { App } from './app.js';

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const app = new App({
  viewport: $<HTMLCanvasElement>('viewport'),
  uvPreview: $<HTMLCanvasElement>('uv-preview'),
  hint: $<HTMLDivElement>('hint'),
  objectSelect: $<HTMLSelectElement>('select-object'),
  materialSelect: $<HTMLSelectElement>('select-material'),
  chkPaintOnly: $<HTMLInputElement>('chk-paint-only'),
  chkUv: $<HTMLInputElement>('chk-uv'),
  chkSeams: $<HTMLInputElement>('chk-seams'),
  btnPaintMode: $<HTMLButtonElement>('btn-paint-mode'),
  btnNavMode: $<HTMLButtonElement>('btn-nav-mode'),
  color: $<HTMLInputElement>('brush-color'),
  size: $<HTMLInputElement>('brush-size'),
  hardness: $<HTMLInputElement>('brush-hardness'),
  opacity: $<HTMLInputElement>('brush-opacity'),
  valSize: $<HTMLSpanElement>('val-size'),
  valHardness: $<HTMLSpanElement>('val-hardness'),
  valOpacity: $<HTMLSpanElement>('val-opacity'),
  btnEraser: $<HTMLButtonElement>('btn-eraser'),
  btnUndo: $<HTMLButtonElement>('btn-undo'),
  btnRedo: $<HTMLButtonElement>('btn-redo'),
  resolution: $<HTMLSelectElement>('select-resolution'),
  btnNewLayer: $<HTMLButtonElement>('btn-new-layer'),
  btnChecker: $<HTMLButtonElement>('btn-checker'),
  btnOpen: $<HTMLButtonElement>('btn-open'),
  fileOpen: $<HTMLInputElement>('file-open'),
  btnSave: $<HTMLButtonElement>('btn-save'),
  btnLoad: $<HTMLButtonElement>('btn-load'),
  fileProject: $<HTMLInputElement>('file-project'),
  btnExport: $<HTMLButtonElement>('btn-export'),
});

// 暴露给控制台调试
(window as unknown as { app: App }).app = app;
