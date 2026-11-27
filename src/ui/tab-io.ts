import { CURRENT_POOL, POOL_V1, POOL_V2, type PoolVersion } from '../pool';
import { store } from '../state';
import { deckFromPreview, exportDeck, previewImport, SAMPLE_OLD_EXPORT, type ImportPreview, type PreviewRow } from '../io';
import { h, clear } from './dom';
import { deckPicker } from './common';

let importText = '';
let targetVersion = POOL_V2.version;
let preview: ImportPreview | null = null;
let previewError: string | null = null;
let importedId: string | null = null;

function targetPool(): PoolVersion {
  return targetVersion === POOL_V1.version ? POOL_V1 : POOL_V2;
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function statusBadge(row: PreviewRow) {
  if (row.status === 'exact') return h('span', { class: 'tag tag-ok' }, '✓ 完全匹配');
  if (row.status === 'printing-missing') return h('span', { class: 'tag tag-warn' }, '印次缺失');
  if (row.status === 'same-name') return h('span', { class: 'tag tag-danger' }, '同名异 id · 未替换');
  return h('span', { class: 'tag tag-danger' }, '新版本无此牌');
}

function rowControls(row: PreviewRow, rerender: () => void) {
  const pool = targetPool();
  if (row.status === 'exact') return h('span', { class: 'muted small' }, '按原 id 与印次导入');

  if (row.status === 'printing-missing' && row.resolvedCardId) {
    const card = pool.cardById.get(row.resolvedCardId)!;
    const sel = h(
      'select',
      {
        class: 'mini-select',
        onchange: (e: Event) => {
          row.fallbackPrintingId = (e.target as HTMLSelectElement).value;
          row.choice = { mode: 'default' };
        },
      },
      ...card.printings.map((p) => h('option', { value: p.id, selected: p.id === row.fallbackPrintingId }, `手动确认印次：${p.label} · ${p.set}`)),
    ) as HTMLSelectElement;
    sel.value = row.fallbackPrintingId ?? '';
    return h('span', { class: 'row-map' }, h('span', { class: 'muted small' }, '原印次不会被静默改写，请确认现行印次：'), sel);
  }

  if (row.status === 'same-name') {
    const mapSel = h(
      'select',
      {
        class: 'mini-select',
        onchange: (e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          if (!v) {
            row.choice = { mode: 'unresolved' };
          } else {
            const c = pool.cardById.get(v)!;
            row.choice = { mode: 'map', cardId: v, printingId: c.printings[0]?.id ?? '' };
          }
          rerender();
        },
      },
      h('option', { value: '' }, '保持缺失（不自动替换）'),
      ...row.candidates.map((c) => h('option', { value: c.id, selected: row.choice.mode === 'map' && row.choice.cardId === c.id }, `手动映射到新版：♦ ${c.name}（${c.id}）`)),
    ) as HTMLSelectElement;
    const choice = row.choice.mode === 'map' ? row.choice : null;
    let printingSel: HTMLElement | null = null;
    if (choice) {
      const card = pool.cardById.get(choice.cardId)!;
      printingSel = h(
        'select',
        {
          class: 'mini-select',
          onchange: (e: Event) => {
            if (row.choice.mode === 'map') row.choice.printingId = (e.target as HTMLSelectElement).value;
          },
        },
        ...card.printings.map((p) => h('option', { value: p.id, selected: p.id === choice.printingId }, p.label)),
      ) as HTMLSelectElement;
    }
    return h('span', { class: 'row-map' }, mapSel, printingSel, h('span', { class: 'muted small' }, '默认保持缺失，导入后在校验页持续报错。'));
  }

  return h('span', { class: 'muted small' }, '只能保持缺失；不会按同名猜测替换。');
}

export function createIoTab(goTab: (tab: string) => void) {
  const el = h('div', { class: 'tab-io' });

  function update() {
    clear(el);
    const deck = store.selectedDeck;
    const exported = exportDeck(deck, CURRENT_POOL);

    // ---------------- 导出 ----------------
    const exportArea = h('textarea', { class: 'json-box', rows: 14, spellcheck: 'false' }) as HTMLTextAreaElement;
    exportArea.value = exported;

    const exportPanel = h(
      'section',
      { class: 'card-panel' },
      h('h2', { class: 'section-title' }, '导出牌组与印次'),
      h('p', { class: 'section-sub' }, 'JSON 同时保存稳定 cardId、每条选择的 printingId，以及一份名字 / 印次名快照。认牌只认 id，不认名字。'),
      h('div', { class: 'tab-toolbar compact' },
        deckPicker(deck.id, (id) => store.select(id), store.decks),
        h('button', { class: 'btn btn-small btn-primary', onclick: () => download(`${deck.id}.json`, exported) }, '下载 .json'),
        h('button', {
          class: 'btn btn-small',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(exported);
              alert('已复制到剪贴板');
            } catch {
              exportArea.select();
              document.execCommand('copy');
            }
          },
        }, '复制 JSON')),
      exportArea,
    );

    // ---------------- 导入 ----------------
    const importArea = h('textarea', {
      class: 'json-box',
      rows: 10,
      spellcheck: 'false',
      placeholder: '把导出的 JSON 粘贴到这里，或选择 .json 文件…',
      oninput: (e: Event) => { importText = (e.target as HTMLTextAreaElement).value; },
    }) as HTMLTextAreaElement;
    importArea.value = importText;

    const fileInput = h('input', {
      type: 'file',
      accept: '.json,application/json',
      style: 'display:none',
      onchange: (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          importText = String(reader.result ?? '');
          preview = null;
          previewError = null;
          update();
        };
        reader.readAsText(file);
      },
    }) as HTMLInputElement;

    const importPanel = h(
      'section',
      { class: 'card-panel' },
      h('h2', { class: 'section-title' }, '导入与版本差异预览'),
      h('div', { class: 'tab-toolbar compact wrap' },
        h('label', { class: 'picker-label' }, '按哪个卡池版本预览：'),
        (() => {
          const sel = h('select', {
            onchange: (e: Event) => { targetVersion = (e.target as HTMLSelectElement).value; preview = null; importedId = null; update(); },
          },
            h('option', { value: POOL_V2.version, selected: targetVersion === POOL_V2.version }, `${POOL_V2.version} ${POOL_V2.label}（新版本）`),
            h('option', { value: POOL_V1.version, selected: targetVersion === POOL_V1.version }, `${POOL_V1.version} ${POOL_V1.label}（旧版本）`)) as HTMLSelectElement;
          sel.value = targetVersion;
          return sel;
        })(),
        h('button', { class: 'btn btn-small', onclick: () => fileInput.click() }, '选择 JSON 文件'),
        h('button', { class: 'btn btn-small', onclick: () => { importText = SAMPLE_OLD_EXPORT; preview = null; previewError = null; importedId = null; update(); } }, '填入内置 v1 旧牌组示例'),
        h('button', {
          class: 'btn btn-small btn-primary',
          onclick: () => {
            importedId = null;
            try {
              preview = previewImport(importText, targetPool());
              previewError = null;
            } catch (err) {
              preview = null;
              previewError = (err as Error).message;
            }
            update();
          },
        }, '生成差异预览')),
      fileInput,
      importArea,
      previewError ? h('div', { class: 'hit hit-error' }, h('span', { class: 'hit-icon' }, '✕'), previewError) : null,
    );

    el.appendChild(exportPanel);
    el.appendChild(importPanel);

    if (preview) {
      const counts = {
        exact: preview.rows.filter((r) => r.status === 'exact').length,
        printing: preview.rows.filter((r) => r.status === 'printing-missing').length,
        sameName: preview.rows.filter((r) => r.status === 'same-name').length,
        removed: preview.rows.filter((r) => r.status === 'removed').length,
      };
      const previewPanel = h(
        'section',
        { class: 'card-panel preview-panel' },
        h('h2', { class: 'section-title' }, `差异预览：${preview.deckName}`),
        h('div', { class: 'preview-meta muted small' },
          preview.sourcePoolVersion ? `导出来源卡池 ${preview.sourcePoolVersion} → ` : '',
          `目标卡池 ${targetPool().version} ${targetPool().label}`,
          ` · 共 ${preview.rows.length} 条`,
          ` · 匹配 ${counts.exact}`,
          counts.printing ? ` · 印次缺失 ${counts.printing}` : '',
          counts.sameName ? ` · 同名异 id ${counts.sameName}` : '',
          counts.removed ? ` · 完全消失 ${counts.removed}` : ''),
        h('div', { class: 'preview-rows' },
          ...preview.rows.map((r) =>
            h('div', { class: `preview-row status-${r.status}` },
              h('div', { class: 'preview-row-main' },
                h('span', { class: 'zone-chip' }, r.zone === 'main' ? '主' : '备'),
                h('span', { class: 'qty' }, `×${r.count}`),
                h('span', { class: 'card-title' }, h('span', { class: 'diamond' }, '♦'), h('span', { class: 'card-name-text' }, r.exportedName)),
                h('span', { class: 'printing-pill' }, r.exportedPrintingLabel ?? r.printingId ?? '默认印次'),
                h('span', { class: 'mono tiny muted' }, r.cardId)),
              h('div', { class: 'preview-row-status' }, statusBadge(r), h('span', { class: 'muted small' }, r.statusText)),
              h('div', { class: 'preview-row-action' }, rowControls(r, update))))),
        h('div', { class: 'preview-confirm' },
          h('button', {
            class: 'btn btn-primary',
            onclick: () => {
              const next = deckFromPreview(preview!, targetPool());
              store.addDeck(next);
              importedId = next.id;
              update();
            },
          }, '按以上选择确认导入为新牌组'),
          importedId
            ? h('span', { class: 'ok-text' }, '已导入。',
                h('button', { class: 'link-btn', onclick: () => goTab('decks') }, '前往牌组校验 →'))
            : h('span', { class: 'muted small' }, '保持缺失的条目会以红色占位进入牌组，并在校验中持续报错，直到你手动处理。')),
      );
      el.appendChild(previewPanel);
    }
  }

  update();
  return { el, onStoreChange: update };
}
