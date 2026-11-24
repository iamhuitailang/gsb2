namespace SamplerLab {
  // ---------- 侧边栏各面板 ----------

  export interface PanelCallbacks {
    onSceneMutate: () => void;
    onTriNudge: (triId: string, dx: number, dy: number) => void;
    onVertexEdit: (triId: string, index: number, axis: 'x' | 'y', value: number) => void;
    onReplay: (frame: number) => void;
    onScale: (scale: number) => void;
    onPlayToggle: () => void;
    onReplayRecord: () => void;
    onReplayClear: () => void;
    onSavePixel: () => void;
    onImport: (file: File) => void;
    onExportScene: () => void;
  }

  export class SidePanels {
    readonly el: HTMLElement;
    private triSection: HTMLElement;
    private diagSection: HTMLElement;
    private replaySection: HTMLElement;
    private sceneSection: HTMLElement;

    constructor(private cb: PanelCallbacks) {
      this.triSection = h('div', { className: 'panel' });
      this.diagSection = h('div', { className: 'panel' });
      this.replaySection = h('div', { className: 'panel' });
      this.sceneSection = h('div', { className: 'panel' });
      this.el = h('div', { className: 'side-panels' }, [
        this.sceneSection,
        this.triSection,
        this.diagSection,
        this.replaySection,
      ]);
    }

    // ---------- 场景设置 ----------

    renderScene(scene: SceneConfig, selected: { px: number; py: number } | null, scale: number): void {
      clear(this.sceneSection);
      const sizeRow = h('div', { className: 'row wrap' }, [
        labeledNumber('宽', scene.width, 1, (v) => this.resize(scene, v, scene.height), { min: 4, max: 40 }),
        labeledNumber('高', scene.height, 1, (v) => this.resize(scene, scene.width, v), { min: 4, max: 40 }),
      ]);

      const modeSel = h('select', {}, [
        h('option', { value: 'center', textContent: '中心采样 (1 点)' }),
        h('option', { value: 'msaa4', textContent: '多点采样 旋转网格 (4 点)' }),
      ]) as HTMLSelectElement;
      modeSel.value = scene.sampleMode;
      modeSel.addEventListener('change', () => {
        scene.sampleMode = modeSel.value as SampleMode;
        this.cb.onSceneMutate();
      });

      const blendSel = h('select', {}, [
        h('option', { value: 'linear', textContent: '按亮度线性混合' }),
        h('option', { value: 'stored', textContent: '直接混合存储值' }),
      ]) as HTMLSelectElement;
      blendSel.value = scene.blendMode;
      blendSel.addEventListener('change', () => {
        scene.blendMode = blendSel.value as BlendMode;
        this.cb.onSceneMutate();
      });

      const bg = h('input', { type: 'color', value: rgbToHex(scene.background) }) as HTMLInputElement;
      bg.addEventListener('input', () => {
        scene.background = hexToRGB(bg.value);
        this.cb.onSceneMutate();
      });

      const scaleRange = h('input', {
        type: 'range',
        min: '16',
        max: '64',
        step: '2',
        value: String(scale),
      }) as HTMLInputElement;
      scaleRange.addEventListener('input', () => this.cb.onScale(Number(scaleRange.value)));

      const saveBtn = h('button', {
        textContent: selected ? `保存像素 (${selected.px}, ${selected.py}) 记录` : '先点选一个像素再保存',
      }) as HTMLButtonElement;
      saveBtn.disabled = !selected;
      saveBtn.addEventListener('click', () => this.cb.onSavePixel());

      const importInput = h('input', { type: 'file', accept: 'application/json,.json' }) as HTMLInputElement;
      importInput.addEventListener('change', () => {
        if (importInput.files?.[0]) this.cb.onImport(importInput.files[0]);
        importInput.value = '';
      });
      const exportBtn = h('button', { textContent: '导出当前场景 JSON' });
      exportBtn.addEventListener('click', () => this.cb.onExportScene());

      this.sceneSection.append(
        h('h3', { textContent: '场景与采样' }),
        sizeRow,
        h('label', { className: 'sel-field' }, [h('span', { textContent: '采样模式' }), modeSel]),
        h('label', { className: 'sel-field' }, [h('span', { textContent: '颜色合并' }), blendSel]),
        h('label', { className: 'sel-field' }, [h('span', { textContent: '背景色（深背景便于观察边缘）' }), bg]),
        h('label', { className: 'sel-field' }, [h('span', { textContent: `显示缩放：${scale}px/像素` }), scaleRange]),
        h('div', { className: 'row wrap' }, [saveBtn]),
        h('div', { className: 'row wrap' }, [exportBtn, importInput]),
      );
    }

    private resize(scene: SceneConfig, w: number, hgt: number): void {
      scene.width = Math.max(4, Math.min(40, Math.round(w)));
      scene.height = Math.max(4, Math.min(40, Math.round(hgt)));
      this.cb.onSceneMutate();
    }

    // ---------- 三角形编辑 ----------

    renderTriangles(scene: SceneConfig, out: RasterOutput, activeId: string | null): void {
      clear(this.triSection);
      this.triSection.append(h('h3', { textContent: '三角形（1–3 个，可互相覆盖）' }));
      scene.triangles.forEach((t, idx) => {
        const card = h('div', {
          className: `tri-card ${activeId === t.id ? 'active' : ''} ${t.enabled ? '' : 'disabled'}`,
          dataset: { triId: t.id },
        });
        const head = h('div', { className: 'tri-head' }, [
          h('input', { type: 'checkbox', checked: t.enabled }),
          h('input', {
            type: 'color',
            value: rgbToHex(t.color),
            className: 'tri-color',
          }) as HTMLInputElement,
          h('strong', { textContent: t.name }),
          h('button', {
            textContent: idx === scene.triangles.length - 1 && scene.triangles.length < 3 ? '复制一个' : '',
            className: 'mini',
            title: '复制此三角形',
          }),
        ]);
        const [chk, colorInput] = [head.children[0] as HTMLInputElement, head.children[1] as HTMLInputElement];
        chk.addEventListener('change', () => {
          t.enabled = chk.checked;
          this.cb.onSceneMutate();
        });
        colorInput.addEventListener('input', () => {
          t.color = hexToRGB(colorInput.value);
          this.cb.onSceneMutate();
        });
        (head.children[3] as HTMLButtonElement).addEventListener('click', () => this.duplicate(scene, t.id));
        card.append(head);

        // 顶点坐标
        t.v.forEach((p, i) => {
          card.append(
            h('div', { className: 'vertex-row' }, [
              h('span', { className: 'vlabel', textContent: `V${i}` }),
              labeledNumber('x', p.x, 0.1, (v) => this.cb.onVertexEdit(t.id, i, 'x', v)),
              labeledNumber('y', p.y, 0.1, (v) => this.cb.onVertexEdit(t.id, i, 'y', v)),
            ]),
          );
        });

        // 深度与平移
        card.append(
          h('div', { className: 'row wrap' }, [
            labeledNumber('depth（小=靠前）', t.depth, 0.05, (v) => {
              t.depth = clamp01(v);
              this.cb.onSceneMutate();
            }, { min: 0, max: 1 }),
          ]),
        );
        const stepInput = h('input', { type: 'number', value: '0.25', step: '0.05', className: 'step-input' }) as HTMLInputElement;
        const nudgeBtn = (label2: string, dx: number, dy: number) => {
          const b = h('button', { textContent: label2, className: 'nudge' });
          b.addEventListener('click', () =>
            this.cb.onTriNudge(t.id, dx * Number(stepInput.value), dy * Number(stepInput.value)),
          );
          return b;
        };
        card.append(
          h('div', { className: 'nudge-grid' }, [
            h('span'),
            nudgeBtn('↑', 0, -1),
            h('span'),
            nudgeBtn('←', -1, 0),
            h('label', { className: 'step-wrap' }, [h('span', { textContent: '步长' }), stepInput]),
            nudgeBtn('→', 1, 0),
            h('span'),
            nudgeBtn('↓', 0, 1),
            h('span'),
          ]),
        );

        const d = out.diagnoses.get(t.id);
        if (d && d.kind !== 'ok') {
          card.append(h('div', { className: `diag-warn warn-${d.kind}` }, d.messages.map((m) => h('div', { textContent: '⚠ ' + m }))));
        }
        this.triSection.append(card);
      });

      if (scene.triangles.length < 3) {
        const add = h('button', { textContent: '＋ 添加三角形', className: 'add-tri' });
        add.addEventListener('click', () => this.addTri(scene));
        this.triSection.append(add);
      }
    }

    private addTri(scene: SceneConfig): void {
      const palette = [rgb(0.95, 0.4, 0.3), rgb(0.35, 0.8, 0.5), rgb(0.4, 0.6, 0.95)];
      const n = scene.triangles.length;
      scene.triangles.push({
        id: `t${Date.now()}`,
        name: `三角形 ${n + 1}`,
        v: [v2(2 + n, 2), v2(7 - n, 3 + n), v2(3 + n, 7)],
        depth: 0.3 + n * 0.2,
        color: palette[n % palette.length],
        enabled: true,
      });
      invalidateTrack(scene);
      this.cb.onSceneMutate();
    }

    private duplicate(scene: SceneConfig, id: string): void {
      if (scene.triangles.length >= 3) return;
      const src = scene.triangles.find((t) => t.id === id);
      if (!src) return;
      scene.triangles.push({
        ...JSON.parse(JSON.stringify(src)),
        id: `t${Date.now()}`,
        name: src.name + ' 副本',
        v: src.v.map((p) => v2(p.x + 0.6, p.y + 0.6)) as [Vec2, Vec2, Vec2],
      });
      invalidateTrack(scene);
      this.cb.onSceneMutate();
    }

    // ---------- 几何诊断 / 共享边（需求 3） ----------

    renderDiagnosis(out: RasterOutput): void {
      clear(this.diagSection);
      this.diagSection.append(h('h3', { textContent: '几何诊断与共享边' }));
      for (const d of out.diagnoses.values()) {
        const box = h('div', { className: `diag-box diag-${d.kind}` });
        box.append(h('div', { className: 'diag-title', textContent: d.triId }));
        for (const m of d.messages) box.append(h('div', { textContent: m }));
        box.append(
          h('div', {
            className: 'mono hint',
            textContent: `signedArea·2 = ${fmt(d.signedArea2, 4)}`,
          }),
        );
        this.diagSection.append(box);
      }

      if (out.sharedEdges.length === 0) {
        this.diagSection.append(
          h('p', {
            className: 'hint',
            textContent: '未检测到共用边。把两个三角形的一对顶点调成完全重合即可观察半开规则。',
          }),
        );
      }
      for (const se of out.sharedEdges) {
        this.diagSection.append(
          h('div', { className: `diag-box ${se.oppositeDirection ? 'diag-ok' : 'diag-reversed-winding'}` }, [
            h('div', { className: 'diag-title', textContent: `共享边：${se.triA} ↔ ${se.triB}` }),
            h('div', {
              className: 'mono',
              textContent: `(${fmt(se.a.x, 2)},${fmt(se.a.y, 2)}) → (${fmt(se.b.x, 2)},${fmt(se.b.y, 2)})${se.exact ? '' : '（端点近似重合）'}`,
            }),
            h('div', { textContent: se.note }),
          ]),
        );
      }

      this.diagSection.append(
        h('details', { className: 'rule-explain' }, [
          h('summary', { textContent: '填充规则说明（左上规则 / 半开边）' }),
          h('p', {
            textContent:
              '所有三角形先归一化为逆时针(CCW)。对每条有向边 p→q 计算边函数 E=cross(q−p, s−p)：内部 E>0。左边(dy<0)与水平上边(dy=0 且 dx>0)为闭边，允许 E=0 的点落在边上；其余边为开边，E=0 不算。共用一条边的两个 CCW 三角形必沿相反方向遍历它，于是边上的采样点恰好被一侧收下，既不重复也不留洞。',
          }),
          h('p', {
            textContent:
              '重复顶点或面积接近零的三角形被标记为退化、不参与光栅化；顺时针(CW)输入会自动交换两个顶点归一化，并在上方给出提示。',
          }),
        ]),
      );
    }

    // ---------- 平移重放（需求 1） ----------

    renderReplay(scene: SceneConfig, frame: number, playing: boolean): void {
      clear(this.replaySection);
      const len = trackLength(scene);
      const recBtn = h('button', {
        textContent: hasTrack(scene) ? '重新开始录制' : '开始录制平移',
        className: hasTrack(scene) ? '' : 'primary',
      });
      recBtn.addEventListener('click', () => this.cb.onReplayRecord());
      const clearBtn = h('button', { textContent: '清空轨迹' });
      clearBtn.addEventListener('click', () => this.cb.onReplayClear());

      const slider = h('input', {
        type: 'range',
        min: '0',
        max: String(Math.max(1, len)),
        step: '1',
        value: String(frame),
        disabled: len === 0,
      }) as HTMLInputElement;
      slider.addEventListener('input', () => this.cb.onReplay(Number(slider.value)));

      const playBtn = h('button', { textContent: playing ? '⏸ 暂停' : '▶ 稳定重放' });
      playBtn.disabled = len === 0;
      playBtn.addEventListener('click', () => this.cb.onPlayToggle());

      this.replaySection.append(
        h('h3', { textContent: '平移录制与重放' }),
        h('p', {
          className: 'hint',
          textContent: '录制期间用方向按钮或直接在画布上拖动三角形，每一步增量都会被记录；重放从基底快照按固定步长逐步施加，结果与时序无关、可完全复现。手动修改顶点会使轨迹作废。',
        }),
        h('div', { className: 'row wrap' }, [recBtn, clearBtn]),
        h('div', { className: 'row wrap' }, [playBtn]),
        h('label', { className: 'sel-field' }, [
          h('span', { textContent: len ? `回放帧 ${frame} / ${len}` : '尚无轨迹（用上方逐小步平移按钮制造）' }),
          slider,
        ]),
      );
    }
  }
}
