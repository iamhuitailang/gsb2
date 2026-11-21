import {
  comparisonBounds,
  invertMatrix,
  matrixFromAlignment,
} from '../src/core/alignment.js';

const BACKGROUND = '#0a0e14';
const PANEL_GAP = 18;
const FIT_MARGIN = 72;

/**
 * Canvas renderer + pointer interaction for the comparison stage.
 *
 * Coordinate model
 *  - A-space ("world") is image A's native pixel grid. B is placed in world
 *    space by a similarity transform world = R·s·b + t.
 *  - Single-panel modes (overlay / blink / diff) draw both images in world
 *    space, so alignment edits are directly visible.
 *  - Side-by-side mode shows A in the left panel and B in the right panel,
 *    each centred on its own image and sharing one zoom + pan. That makes it
 *    the natural place to mark corresponding corners: a click on the left
 *    panel yields A pixels, a click on the right yields B pixels.
 */
export class Viewport {
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    this.ctx = canvas.getContext('2d');
    this.state = null;
    this.handlers = {};
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.hover = null;
    this.panning = null;
    this.aligning = null;
    this.stroking = null;
    this.width = 1;
    this.height = 1;
    this.diffCanvas = null;
    this.diffCanvasKey = '';
    this.baseCanvas = null;
    this.baseCanvasKey = '';
    this.ignoreCanvas = null;
    this.ignoreKey = '';
    this.ignoreBounds = null;
    this.checkerPattern = null;
    this.setupEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  setCallbacks(handlers) {
    this.handlers = handlers;
  }

  getState() {
    return this.state;
  }

  setState(state) {
    this.state = state;
    this.canvas.style.cursor = this.cursorFor();
    this.render();
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    if (this.state) this.render();
    this.handlers.onResize?.(this.width, this.height);
  }

  /* ------------------------------ geometry ------------------------------ */

  panels() {
    const { width, height } = this;
    if (!this.state || this.state.mode !== 'side') {
      return [{ id: 'single', x: 0, y: 0, width, height }];
    }
    const half = Math.floor((width - PANEL_GAP) / 2);
    return [
      { id: 'a', x: 0, y: 0, width: half, height },
      { id: 'b', x: width - half, y: 0, width: half, height },
    ];
  }

  /** Image dimensions displayed in a panel (side B shows B, others show A). */
  panelImageSize(panel) {
    const s = this.state;
    if (panel.id === 'b') return { w: s.wB, h: s.hB };
    return { w: s.wA, h: s.hA };
  }

  /** Screen position of the panel's image origin at the given zoom, no pan. */
  baseFor(panel, scale) {
    const { w, h } = this.panelImageSize(panel);
    return {
      x: panel.x + (panel.width - w * scale) / 2,
      y: panel.y + (panel.height - h * scale) / 2,
    };
  }

  worldToScreen(panel, scale, panX, panY, x, y) {
    const base = this.baseFor(panel, scale);
    return { x: base.x + panX + x * scale, y: base.y + panY + y * scale };
  }

  /** Screen point -> image point for that panel's displayed image. */
  screenToImage(panel, localX, localY) {
    const s = this.state;
    const base = this.baseFor(panel, s.view.scale);
    return {
      x: (localX - base.x - s.view.panX) / s.view.scale,
      y: (localY - base.y - s.view.panY) / s.view.scale,
    };
  }

  /** Fit A (and B for side-by-side) into every panel. */
  fitView() {
    const s = this.state;
    if (!s || !s.imgA || !s.imgB) return;
    const panel = this.panels()[0];
    let scale;
    if (s.mode === 'side') {
      scale = Math.min(
        (panel.width - FIT_MARGIN) / Math.max(1, s.wA),
        (panel.height - FIT_MARGIN) / Math.max(1, s.hA),
        (panel.width - FIT_MARGIN) / Math.max(1, s.wB),
        (panel.height - FIT_MARGIN) / Math.max(1, s.hB),
      );
    } else {
      const b = comparisonBounds(s.wA, s.hA, s.alignment, s.wB, s.hB);
      scale = Math.min(
        (panel.width - FIT_MARGIN) / Math.max(1, b.width),
        (panel.height - FIT_MARGIN) / Math.max(1, b.height),
      );
    }
    scale = clamp(scale, 0.002, 64);
    if (s.mode === 'side') {
      // Each image is centred by its own base; no pan needed.
      this.handlers.onViewChange?.({ scale, panX: 0, panY: 0 });
      return;
    }
    // Centre the union of A and aligned B inside the A-centred frame.
    const b = comparisonBounds(s.wA, s.hA, s.alignment, s.wB, s.hB);
    const panelBase = this.baseFor(panel, scale);
    const panX = (panel.width - b.width * scale) / 2 - b.minX * scale - panelBase.x;
    const panY = (panel.height - b.height * scale) / 2 - b.minY * scale - panelBase.y;
    this.handlers.onViewChange?.({ scale, panX, panY });
  }

  zoomAt(factor, clientX, clientY) {
    const s = this.state;
    if (!s) return;
    const local = this.localPoint(clientX, clientY);
    const panel = this.panelAt(local.x, local.y) || this.panels()[0];
    const oldScale = s.view.scale;
    const newScale = clamp(oldScale * factor, 0.002, 64);
    if (newScale === oldScale) return;
    const imagePoint = this.screenToImage(panel, local.x, local.y);
    const baseNew = this.baseFor(panel, newScale);
    this.handlers.onViewChange?.({
      scale: newScale,
      panX: local.x - baseNew.x - imagePoint.x * newScale,
      panY: local.y - baseNew.y - imagePoint.y * newScale,
    });
  }

  zoomCenter(factor) {
    const panel = this.panels()[0];
    const rect = this.canvas.getBoundingClientRect();
    this.zoomAt(
      factor,
      rect.left + panel.x + panel.width / 2,
      rect.top + panel.y + panel.height / 2,
    );
  }

  localPoint(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  panelAt(x, y) {
    for (const panel of this.panels()) {
      if (
        x >= panel.x &&
        x <= panel.x + panel.width &&
        y >= panel.y &&
        y <= panel.y + panel.height
      ) {
        return panel;
      }
    }
    return null;
  }

  /** Hit test: { panelId, panel, image, world }. */
  hitTest(localX, localY) {
    const panel = this.panelAt(localX, localY);
    if (!panel) return null;
    const image = this.screenToImage(panel, localX, localY);
    const isB = panel.id === 'b';
    // In side-by-side B shows B at native orientation, so "world" (A space)
    // for B means applying the alignment to the B pixel.
    const world =
      isB && this.state.mode === 'side'
        ? applyAlignment(this.state.alignment, image.x, image.y)
        : image;
    return { panelId: panel.id, panel, image, world };
  }

  invalidateDiff() {
    this.diffCanvas = null;
    this.diffCanvasKey = '';
    this.baseCanvas = null;
    this.baseCanvasKey = '';
  }

  invalidateIgnore() {
    this.ignoreKey = '';
  }

  /* -------------------------------- input ------------------------------- */

  setupEvents() {
    const canvas = this.canvas;
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.state) return;
        event.preventDefault();
        this.zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
      },
      { passive: false },
    );

    canvas.addEventListener('pointerdown', (event) => {
      if (!this.state?.imgA) return;
      const local = this.localPoint(event.clientX, event.clientY);
      const hit = this.hitTest(local.x, local.y);
      if (!hit) return;
      const tool = this.state.tool;
      canvas.setPointerCapture(event.pointerId);

      if (event.button === 1 || tool === 'hand') {
        this.panning = { x: event.clientX, y: event.clientY };
        this.canvas.style.cursor = 'grabbing';
        return;
      }

      if (tool === 'align') {
        // Side-by-side does not visualise the translation, so aligning there
        // would feel broken; overlay/diff are the places to drag B.
        if (this.state.mode === 'side') {
          this.handlers.onBlocked?.('align-side');
          return;
        }
        const pivot = { x: this.state.wB / 2, y: this.state.hB / 2 };
        this.aligning = {
          start: { ...this.state.alignment },
          startWorld: hit.world,
          pivot,
          startAngle: this.angleAround(pivot, hit.world, this.state.alignment),
          mode: event.altKey ? 'rotate' : 'move',
        };
        return;
      }

      if (tool === 'corner') {
        this.handlers.onCornerClick?.({
          panelId: hit.panelId,
          image: hit.image,
          world: hit.world,
        });
        return;
      }

      if (tool === 'ignore') {
        // Strokes are stored in A space and previewed on the A panel only, so
        // drawing on the B-only panel would appear to do nothing.
        if (this.state.mode === 'side' && hit.panelId === 'b') {
          this.handlers.onBlocked?.('ignore-side-b');
          return;
        }
        this.stroking = { last: hit.world };
        this.handlers.onStrokeStart?.(hit.world, this.state.brushMode);
        return;
      }

      this.panning = { x: event.clientX, y: event.clientY };
      this.canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!this.state) return;
      const local = this.localPoint(event.clientX, event.clientY);
      const hit = this.hitTest(local.x, local.y);

      if (this.panning) {
        const dx = event.clientX - this.panning.x;
        const dy = event.clientY - this.panning.y;
        this.panning = { x: event.clientX, y: event.clientY };
        this.handlers.onPan?.(dx, dy);
        return;
      }

      if (this.aligning && hit) {
        if (this.aligning.mode === 'rotate') {
          const angle = this.angleAround(
            this.aligning.pivot,
            hit.world,
            this.aligning.start,
          );
          this.handlers.onRotateDrag?.(
            this.aligning.start,
            angle - this.aligning.startAngle,
          );
        } else {
          let dx = hit.world.x - this.aligning.startWorld.x;
          let dy = hit.world.y - this.aligning.startWorld.y;
          if (event.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          this.handlers.onAlignDrag?.(this.aligning.start, dx, dy);
        }
        return;
      }

      if (this.stroking && hit) {
        const world = hit.world;
        if (
          Math.hypot(
            world.x - this.stroking.last.x,
            world.y - this.stroking.last.y,
          ) > Math.max(1, (this.state.brushSize || 24) * 0.12)
        ) {
          this.stroking.last = world;
          this.handlers.onStrokeMove?.(world);
        }
        return;
      }

      this.hover = hit ? { ...hit, local } : null;
      this.handlers.onHover?.(
        hit ? { panelId: hit.panelId, world: hit.world, image: hit.image, local } : null,
        this.state,
      );
      this.render();
    });

    const endPointer = () => {
      if (this.panning) {
        this.panning = null;
        this.canvas.style.cursor = this.cursorFor();
      }
      if (this.aligning) {
        this.aligning = null;
        this.handlers.onAlignEnd?.();
      }
      if (this.stroking) {
        this.stroking = null;
        this.handlers.onStrokeEnd?.();
      }
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('pointerleave', () => {
      if (!this.panning && !this.aligning && !this.stroking) {
        this.hover = null;
        this.handlers.onHover?.(null, this.state);
        this.render();
      }
    });
  }

  /** Angle of a world point around a B-space pivot under `alignment`. */
  angleAround(pivot, world, alignment) {
    const inv = invertMatrix(matrixFromAlignment(alignment));
    if (!inv) return 0;
    const bx = inv.a * world.x + inv.c * world.y + inv.e;
    const by = inv.b * world.x + inv.d * world.y + inv.f;
    return Math.atan2(by - pivot.y, bx - pivot.x);
  }

  cursorFor() {
    const tool = this.state?.tool || 'hand';
    if (tool === 'align') return 'move';
    if (tool === 'ignore' || tool === 'corner') return 'crosshair';
    return 'grab';
  }

  updateCursor() {
    this.canvas.style.cursor = this.cursorFor();
  }

  /* ------------------------------- canvases ----------------------------- */

  ensureDiffCanvas(result, withLayer) {
    if (!result) return null;
    const pixels = withLayer ? result.compositePixels : result.basePixels;
    if (!pixels) return null;
    // Scope by pair: two pairs can share dimensions and even alignment.
    const key = `${this.state?.pairId || ''}|${result.rasterKey || ''}|${result.width}x${result.height}`;
    if (withLayer && this.diffCanvasKey === key) return this.diffCanvas;
    if (!withLayer && this.baseCanvasKey === key) return this.baseCanvas;
    const canvas = document.createElement('canvas');
    canvas.width = result.width;
    canvas.height = result.height;
    canvas
      .getContext('2d')
      .putImageData(
        new ImageData(new Uint8ClampedArray(pixels), result.width, result.height),
        0,
        0,
      );
    if (withLayer) {
      this.diffCanvas = canvas;
      this.diffCanvasKey = key;
    } else {
      this.baseCanvas = canvas;
      this.baseCanvasKey = key;
    }
    return canvas;
  }

  ensureIgnoreCanvas() {
    const s = this.state;
    if (!s?.ignoreStrokes?.length) return null;
    const key = `${s.pairId || ''}|${s.ignoreRevision}|${s.ignoreStrokes.length}|${
      s.ignoreStrokes[0]?.id || ''
    }|${s.ignoreStrokes.at(-1)?.id || ''}`;
    if (this.ignoreKey === key && this.ignoreCanvas) {
      return { canvas: this.ignoreCanvas, bounds: this.ignoreBounds };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let pad = 8;
    for (const stroke of s.ignoreStrokes) {
      pad = Math.max(pad, (stroke.size || 24) / 2 + 4);
      for (const p of stroke.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    if (!Number.isFinite(minX)) {
      minX = 0;
      minY = 0;
      maxX = s.wA;
      maxY = s.hA;
    }
    const bounds = {
      minX: minX - pad,
      minY: minY - pad,
      width: Math.max(1, maxX - minX + pad * 2),
      height: Math.max(1, maxY - minY + pad * 2),
    };
    const factor = Math.min(1, 1800 / Math.max(bounds.width, bounds.height));
    const raw = document.createElement('canvas');
    raw.width = Math.max(1, Math.ceil(bounds.width * factor));
    raw.height = Math.max(1, Math.ceil(bounds.height * factor));
    const ctx = raw.getContext('2d');
    ctx.setTransform(
      factor,
      0,
      0,
      factor,
      -bounds.minX * factor,
      -bounds.minY * factor,
    );
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    for (const stroke of s.ignoreStrokes) {
      ctx.globalCompositeOperation =
        stroke.mode === 'erase' ? 'destination-out' : 'source-over';
      ctx.lineWidth = Math.max(0.5, stroke.size || 24);
      if (stroke.points.length === 1) {
        ctx.beginPath();
        ctx.arc(
          stroke.points[0].x,
          stroke.points[0].y,
          (stroke.size || 24) / 2,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        ctx.stroke();
      }
    }
    const tinted = document.createElement('canvas');
    tinted.width = raw.width;
    tinted.height = raw.height;
    const tctx = tinted.getContext('2d');
    tctx.fillStyle = '#44d6c4';
    tctx.fillRect(0, 0, tinted.width, tinted.height);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(raw, 0, 0);

    this.ignoreCanvas = tinted;
    this.ignoreBounds = bounds;
    this.ignoreKey = key;
    return { canvas: tinted, bounds };
  }

  /* -------------------------------- render ------------------------------ */

  render() {
    const ctx = this.ctx;
    const s = this.state;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, this.width, this.height);
    if (!s || !s.imgA || !s.imgB) return;

    const panels = this.panels();
    if (panels.length === 2) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(this.width / 2, 20);
      ctx.lineTo(this.width / 2, this.height - 20);
      ctx.stroke();
      ctx.restore();
    }
    for (const panel of panels) this.drawPanel(ctx, panel, s);
    this.drawHover(ctx, s);
  }

  applyView(ctx, panel) {
    const { view } = this.state;
    const base = this.baseFor(panel, view.scale);
    ctx.translate(base.x + view.panX, base.y + view.panY);
    ctx.scale(view.scale, view.scale);
  }

  drawPanel(ctx, panel, s) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(panel.x, panel.y, panel.width, panel.height);
    ctx.clip();
    this.drawChecker(ctx, panel);

    const mode = s.mode;
    ctx.save();
    this.applyView(ctx, panel);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (mode === 'side') {
      if (panel.id === 'b') {
        ctx.drawImage(s.imgB, 0, 0, s.wB, s.hB);
      } else {
        ctx.drawImage(s.imgA, 0, 0, s.wA, s.hA);
        // Ignore strokes are stored in A space; the B panel shows B natively,
        // so only the A panel gets the ignore preview.
        this.paintIgnore(ctx, s);
      }
    } else if (mode === 'diff') {
      // The diff composite already carries the ignored-area hatch.
      this.paintDiff(ctx, s);
    } else if (mode === 'blink') {
      if (s.blinkShowB || s.peekB) this.paintB(ctx, s);
      else ctx.drawImage(s.imgA, 0, 0, s.wA, s.hA);
    } else {
      // Overlay: opacity is the primary control; Space / 闪一下 peeks at B.
      if (s.peekB || s.blinkShowB) {
        this.paintB(ctx, s);
      } else {
        ctx.drawImage(s.imgA, 0, 0, s.wA, s.hA);
        ctx.globalAlpha = s.overlayOpacity;
        this.paintB(ctx, s);
        ctx.globalAlpha = 1;
      }
      this.paintIgnore(ctx, s);
    }
    ctx.restore();

    if (mode === 'diff' && s.diffResult) this.drawRegionOutlines(ctx, panel, s);
    if (mode === 'side') {
      if (panel.id === 'a') this.drawSideCorners(ctx, panel, s, 'a');
      else this.drawSideCorners(ctx, panel, s, 'b');
    } else {
      this.drawCorners(ctx, panel, s);
    }
    ctx.restore();

    this.drawPanelBadge(ctx, panel, s);
  }

  paintB(ctx, s) {
    const m = matrixFromAlignment(s.alignment);
    ctx.save();
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(s.imgB, 0, 0, s.wB, s.hB);
    ctx.restore();
  }

  paintDiff(ctx, s) {
    const result = s.diffResult;
    if (!result) {
      ctx.drawImage(s.imgA, 0, 0, s.wA, s.hA);
      ctx.globalAlpha = 0.5;
      this.paintB(ctx, s);
      ctx.globalAlpha = 1;
      return;
    }
    const canvas = this.ensureDiffCanvas(result, s.diffLayer !== false);
    if (canvas) {
      const b = result.bounds;
      ctx.drawImage(canvas, b.minX, b.minY, b.width, b.height);
    }
  }

  paintIgnore(ctx, s) {
    if (s.ignoreStrokes?.length) {
      const preview = this.ensureIgnoreCanvas();
      if (preview) {
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.drawImage(
          preview.canvas,
          preview.bounds.minX,
          preview.bounds.minY,
          preview.bounds.width,
          preview.bounds.height,
        );
        ctx.restore();
      }
    }
    // The live stroke is painted directly. Erase strokes use a lighter tint
    // instead of destination-out, which would punch through the canvas.
    const active = s.activeStroke;
    if (active?.points?.length) {
      ctx.save();
      const alpha = active.mode === 'erase' ? 0.22 : 0.5;
      ctx.strokeStyle = `rgba(68,214,196,${alpha})`;
      ctx.fillStyle = `rgba(68,214,196,${alpha})`;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(0.5, active.size || 24);
      if (active.points.length === 1) {
        ctx.beginPath();
        ctx.arc(
          active.points[0].x,
          active.points[0].y,
          (active.size || 24) / 2,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(active.points[0].x, active.points[0].y);
        for (let i = 1; i < active.points.length; i++) {
          ctx.lineTo(active.points[i].x, active.points[i].y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawRegionOutlines(ctx, panel, s) {
    const result = s.diffResult;
    if (!result?.regions?.length) return;
    const { view } = s;
    const showLabels = view.scale > 0.3;
    ctx.save();
    for (const region of result.regions.slice(0, 500)) {
      const topLeft = this.worldToScreen(
        panel,
        view.scale,
        view.panX,
        view.panY,
        region.bbox.x,
        region.bbox.y,
      );
      const w = region.bbox.width * view.scale;
      const h = region.bbox.height * view.scale;
      if (
        topLeft.x + w < panel.x ||
        topLeft.y + h < panel.y ||
        topLeft.x > panel.x + panel.width ||
        topLeft.y > panel.y + panel.height
      ) {
        continue;
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeRect(topLeft.x - 0.5, topLeft.y - 0.5, w + 1, h + 1);
      ctx.strokeStyle = 'rgba(255,214,120,0.85)';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(topLeft.x, topLeft.y, w, h);
      ctx.setLineDash([]);
      if (showLabels) {
        const label = String(region.index);
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        const tw = ctx.measureText(label).width + 9;
        ctx.fillStyle = 'rgba(10,14,20,0.85)';
        ctx.fillRect(topLeft.x, topLeft.y - 15, tw, 14);
        ctx.fillStyle = 'rgba(255,214,120,0.95)';
        ctx.fillText(label, topLeft.x + 4, topLeft.y - 4);
      }
    }
    ctx.restore();
  }

  /** Side-by-side: A markers in the A panel, B markers in the B panel. */
  drawSideCorners(ctx, panel, s, side) {
    const points = s.cornerPoints || [];
    const pending = s.pendingCorner;
    if (!points.length && !pending) return;
    const { view } = s;
    const toScreen = (x, y) =>
      this.worldToScreen(panel, view.scale, view.panX, view.panY, x, y);

    ctx.save();
    ctx.lineWidth = 1;
    points.forEach((point, index) => {
      if (side === 'a') {
        drawPointMarker(ctx, toScreen(point.ax, point.ay), 'rgba(255,193,94,0.95)', String(index + 1));
      } else {
        drawPointMarker(ctx, toScreen(point.bx, point.by), 'rgba(104,197,255,0.95)', String(index + 1));
      }
    });
    if (pending?.a && side === 'a') {
      drawPendingRing(ctx, toScreen(pending.a.x, pending.a.y), 'rgba(255,193,94,0.95)');
    }
    ctx.restore();
  }

  /** Single-panel modes: both markers plus the correspondence line. */
  drawCorners(ctx, panel, s) {
    const points = s.cornerPoints || [];
    const pending = s.pendingCorner;
    if (!points.length && !pending) return;
    const { view } = s;
    const m = matrixFromAlignment(s.alignment);
    const toScreen = (world) =>
      this.worldToScreen(panel, view.scale, view.panX, view.panY, world.x, world.y);

    ctx.save();
    ctx.lineWidth = 1;
    points.forEach((point, index) => {
      const a = toScreen({ x: point.ax, y: point.ay });
      const b = toScreen({
        x: m.a * point.bx + m.c * point.by + m.e,
        y: m.b * point.bx + m.d * point.by + m.f,
      });
      ctx.strokeStyle = 'rgba(255,193,94,0.35)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      drawPointMarker(ctx, a, 'rgba(255,193,94,0.95)', String(index + 1));
      drawPointMarker(ctx, b, 'rgba(104,197,255,0.95)', String(index + 1));
    });
    if (pending?.a) {
      drawPendingRing(ctx, toScreen(pending.a), 'rgba(255,193,94,0.95)');
    }
    ctx.restore();
  }

  drawHover(ctx, s) {
    if (!this.hover) return;
    const { local } = this.hover;
    const panels = this.panels();
    if (panels.length === 2) {
      ctx.save();
      ctx.strokeStyle = 'rgba(126,226,176,0.28)';
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      ctx.moveTo(local.x, panels[0].y);
      ctx.lineTo(local.x, this.height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    if (s.tool === 'ignore') {
      const r = ((s.brushSize || 32) / 2) * s.view.scale;
      ctx.save();
      ctx.beginPath();
      ctx.arc(local.x, local.y, Math.max(3, r), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(68,214,196,0.9)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = 'rgba(68,214,196,0.12)';
      ctx.fill();
      ctx.restore();
    }
  }

  drawChecker(ctx, panel) {
    if (!this.checkerPattern) {
      const tile = 22;
      const c = document.createElement('canvas');
      c.width = tile * 2;
      c.height = tile * 2;
      const tctx = c.getContext('2d');
      tctx.fillStyle = '#0b1017';
      tctx.fillRect(0, 0, tile * 2, tile * 2);
      tctx.fillStyle = '#0d131b';
      tctx.fillRect(0, 0, tile, tile);
      tctx.fillRect(tile, tile, tile, tile);
      this.checkerPattern = ctx.createPattern(c, 'repeat');
    }
    ctx.save();
    ctx.fillStyle = this.checkerPattern;
    ctx.translate(panel.x, panel.y);
    ctx.fillRect(0, 0, panel.width, panel.height);
    ctx.restore();
  }

  drawPanelBadge(ctx, panel, s) {
    const labels = [];
    if (s.mode === 'side') {
      labels.push(
        panel.id === 'b'
          ? `B · ${s.bLabel || '对比版本'}`
          : `A · ${s.aLabel || '基准版本'}`,
      );
    } else if (s.mode === 'blink') {
      labels.push(
        s.blinkShowB || s.peekB
          ? `B · ${s.bLabel || '对比版本'}`
          : `A · ${s.aLabel || '基准版本'}`,
      );
    } else if (s.mode === 'overlay') {
      labels.push(
        s.peekB || s.blinkShowB
          ? `B · ${s.bLabel || '对比版本'}（查看）`
          : `叠加 · B ${Math.round(s.overlayOpacity * 100)}%`,
      );
    } else if (s.mode === 'diff') {
      labels.push('差异图 · 彩色高亮');
    }
    if (!labels.length) return;
    ctx.save();
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    for (const [i, text] of labels.entries()) {
      const w = ctx.measureText(text).width + 18;
      const x = panel.x + 14;
      const y = panel.y + 14 + i * 26;
      ctx.fillStyle = 'rgba(8,12,17,0.74)';
      roundRect(ctx, x, y, w, 23, 7);
      ctx.fill();
      ctx.fillStyle = 'rgba(233,240,247,0.82)';
      ctx.fillText(text, x + 9, y + 16);
    }
    ctx.restore();
  }
}

function applyAlignment(alignment, x, y) {
  const m = matrixFromAlignment(alignment);
  return {
    x: m.a * x + m.c * y + m.e,
    y: m.b * x + m.d * y + m.f,
  };
}

function drawPointMarker(ctx, point, color, label) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(point.x, point.y, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(6,10,15,0.7)';
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(point.x - 12, point.y);
  ctx.lineTo(point.x - 4, point.y);
  ctx.moveTo(point.x + 4, point.y);
  ctx.lineTo(point.x + 12, point.y);
  ctx.moveTo(point.x, point.y - 12);
  ctx.lineTo(point.x, point.y - 4);
  ctx.moveTo(point.x, point.y + 4);
  ctx.lineTo(point.x, point.y + 12);
  ctx.stroke();
  if (label) {
    ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = color;
    ctx.fillText(label, point.x + 9, point.y - 8);
  }
  ctx.restore();
}

function drawPendingRing(ctx, point, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(point.x, point.y, 9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
