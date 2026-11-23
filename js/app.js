/* 主应用：钢琴卷帘编辑、播放、轨道管理、导入导出 */
(() => {
  const $ = id => document.getElementById(id);

  /* ---------- 状态 ---------- */
  let project = Model.createProject();
  let selectedTrack = 0;
  let selection = new Set(); // note id
  let clipboard = [];
  let pxPerBeat = 48;
  let snapDiv = 4; // 每拍几分音符网格（4 = 十六分）
  let playheadTick = 0;
  let issues = [];

  const ROW_H = 13;
  const KEYS_W = 56;
  const RULER_H = 30;
  const PITCHES = 128;
  const TRACK_COLORS = ['#4da3ff', '#ff9f43', '#2ecc71', '#e056a0', '#a06bff', '#ff5b5b', '#22c1c3', '#d4c94a'];

  const undoStack = [];
  const redoStack = [];

  /* ---------- 播放器 ---------- */
  const player = { playing: false, startCtxTime: 0, startTick: 0, timer: null, lastTick: 0 };

  function audibleTracks() {
    const anySolo = project.tracks.some(t => t.solo);
    return project.tracks.filter(t => !t.muted && (!anySolo || t.solo));
  }

  function currentTick() {
    if (!player.playing) return playheadTick;
    const sec = Model.ticksToSeconds(project, player.startTick) + (Synth.now() - player.startCtxTime);
    return Model.secondsToTicks(project, sec);
  }

  function play() {
    if (player.playing) return;
    Synth.ensure();
    player.playing = true;
    player.startTick = playheadTick;
    player.startCtxTime = Synth.now() + 0.05;
    player.lastTick = playheadTick;
    const startSec = Model.ticksToSeconds(project, playheadTick);
    player.timer = setInterval(() => {
      const horizonSec = Model.ticksToSeconds(project, player.startTick) + (Synth.now() + 0.15 - player.startCtxTime);
      const horizonTick = Model.secondsToTicks(project, horizonSec);
      for (const tr of audibleTracks()) {
        for (const n of tr.notes) {
          if (n.tick >= player.lastTick && n.tick < horizonTick) {
            const when = player.startCtxTime + (Model.ticksToSeconds(project, n.tick) - startSec);
            const durSec = Model.ticksToSeconds(project, n.tick + n.dur) - Model.ticksToSeconds(project, n.tick);
            Synth.playNote(tr.instrument, n.pitch, n.vel, Math.max(when, Synth.now()), durSec);
          }
        }
      }
      player.lastTick = horizonTick;
      if (player.lastTick >= Model.totalTicks(project)) stop(true);
    }, 25);
    $('btnPlay').textContent = '⏸ 暂停';
  }

  function stop(ended) {
    if (!player.playing) return;
    player.playing = false;
    clearInterval(player.timer);
    playheadTick = ended ? 0 : Math.min(Math.round(currentTick()), Model.totalTicks(project));
    $('btnPlay').textContent = '▶ 播放';
    draw();
    updateStatus();
  }

  function togglePlay() { player.playing ? stop(false) : play(); }

  /* ---------- 撤销/重做 ---------- */
  function pushUndo() {
    undoStack.push(JSON.stringify(project));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(project));
    project = JSON.parse(undoStack.pop());
    selection.clear();
    refresh();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(project));
    project = JSON.parse(redoStack.pop());
    selection.clear();
    refresh();
  }
  function mutate(fn) { pushUndo(); fn(); refresh(); }

  /* ---------- 几何换算 ---------- */
  const pxPerTick = () => pxPerBeat / project.ppq;
  const gridTicks = () => Math.max(1, Math.round(project.ppq / snapDiv));
  const snapTick = t => Math.round(t / gridTicks()) * gridTicks();
  const tickToX = t => t * pxPerTick();
  const xToTick = x => x / pxPerTick();
  const pitchToY = p => (PITCHES - 1 - p) * ROW_H;
  const yToPitch = y => PITCHES - 1 - Math.floor(y / ROW_H);

  /* ---------- 画布 ---------- */
  const roll = $('roll'), ruler = $('ruler'), keysCv = $('keys');
  const rollScroll = $('rollScroll');

  function fitCanvas(cv, w, h) {
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function rollWidth() { return Math.ceil(tickToX(Model.totalTicks(project))) + 40; }
  function rollHeight() { return PITCHES * ROW_H; }

  const BLACK = new Set([1, 3, 6, 8, 10]);

  function drawKeys() {
    const ctx = fitCanvas(keysCv, KEYS_W, rollHeight());
    for (let p = 0; p < PITCHES; p++) {
      const y = pitchToY(p);
      const black = BLACK.has(p % 12);
      ctx.fillStyle = black ? '#2b2b33' : '#e8e8ee';
      ctx.fillRect(0, y, KEYS_W, ROW_H);
      ctx.strokeStyle = '#999';
      ctx.beginPath(); ctx.moveTo(0, y + ROW_H); ctx.lineTo(KEYS_W, y + ROW_H); ctx.stroke();
      if (p % 12 === 0) {
        ctx.fillStyle = '#333';
        ctx.font = '9px sans-serif';
        ctx.fillText('C' + (Math.floor(p / 12) - 1), 4, y + ROW_H - 3);
      }
    }
  }

  function drawRuler() {
    const w = rollWidth();
    const ctx = fitCanvas(ruler, w, RULER_H);
    ctx.fillStyle = '#1e1e26';
    ctx.fillRect(0, 0, w, RULER_H);
    const bounds = Model.measureBoundaries(project);
    ctx.font = '10px sans-serif';
    bounds.forEach((b, i) => {
      const x = tickToX(b.tick);
      ctx.strokeStyle = '#888';
      ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, RULER_H); ctx.stroke();
      ctx.fillStyle = '#ccc';
      ctx.fillText(String(i + 1), x + 3, 11);
      ctx.fillStyle = '#7fd0ff';
      ctx.fillText(`${b.num}/${b.den}`, x + 3, 23);
    });
    // 变速标记
    for (const t of project.tempoMap) {
      if (t.tick === 0) continue;
      const x = tickToX(t.tick);
      ctx.fillStyle = '#ffb347';
      ctx.fillRect(x - 1, 0, 2, RULER_H);
      ctx.fillText(`♩=${t.bpm}`, x + 3, 11);
    }
    // 播放头
    drawPlayheadOn(ctx, RULER_H);
  }

  function drawPlayheadOn(ctx, h) {
    const x = tickToX(playheadTick);
    ctx.strokeStyle = '#ff4d4d';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.lineWidth = 1;
  }

  function drawRoll() {
    const w = rollWidth(), h = rollHeight();
    const ctx = fitCanvas(roll, w, h);
    // 行背景
    for (let p = 0; p < PITCHES; p++) {
      const y = pitchToY(p);
      ctx.fillStyle = BLACK.has(p % 12) ? '#26262e' : '#2f2f38';
      ctx.fillRect(0, y, w, ROW_H);
      if (p % 12 === 0) {
        ctx.fillStyle = '#3d3d4a';
        ctx.fillRect(0, y, w, 1);
      }
    }
    // 竖线：细分 / 拍 / 小节
    const bounds = Model.measureBoundaries(project);
    const grid = gridTicks();
    const showGrid = tickToX(grid) >= 5;
    for (const b of bounds) {
      const beatLen = (project.ppq * 4) / b.den;
      for (let t = b.tick; t < b.tick + b.length; t += grid) {
        const x = Math.round(tickToX(t)) + 0.5;
        const isMeasure = t === b.tick;
        const isBeat = (t - b.tick) % beatLen === 0;
        if (!showGrid && !isMeasure && !isBeat) continue;
        ctx.strokeStyle = isMeasure ? '#8a8a9a' : isBeat ? '#4c4c5c' : '#3a3a46';
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    }
    // 音符：先画非选中轨（淡），再画选中轨
    project.tracks.forEach((tr, ti) => {
      if (ti === selectedTrack) return;
      drawTrackNotes(ctx, tr, ti, 0.22);
    });
    if (project.tracks[selectedTrack]) drawTrackNotes(ctx, project.tracks[selectedTrack], selectedTrack, 1);
    drawPlayheadOn(ctx, h);
  }

  function drawTrackNotes(ctx, tr, ti, alpha) {
    const color = TRACK_COLORS[ti % TRACK_COLORS.length];
    for (const n of tr.notes) {
      const x = tickToX(n.tick);
      const y = pitchToY(n.pitch);
      const w = Math.max(2, tickToX(n.dur));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(x, y + 1, w, ROW_H - 2);
      if (selection.has(n.id)) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 2, w - 2, ROW_H - 4);
        ctx.lineWidth = 1;
      }
      if (n.allowOverlap) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffffff';
        ctx.font = '8px sans-serif';
        ctx.fillText('≈', x + 2, y + ROW_H - 3);
      }
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    drawKeys();
    drawRuler();
    drawRoll();
  }

  /* ---------- 命中检测与编辑 ---------- */
  function noteAt(tr, x, y) {
    const tick = xToTick(x);
    const pitch = yToPitch(y);
    for (let i = tr.notes.length - 1; i >= 0; i--) {
      const n = tr.notes[i];
      if (n.pitch === pitch && tick >= n.tick && tick <= n.tick + n.dur) return n;
    }
    return null;
  }

  let drag = null;

  roll.addEventListener('mousedown', e => {
    const rect = roll.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const tr = project.tracks[selectedTrack];
    if (!tr) return;
    const hit = noteAt(tr, x, y);
    if (hit) {
      if (!selection.has(hit.id)) {
        if (!e.shiftKey) selection.clear();
        selection.add(hit.id);
      }
      const nearRight = xToTick(x) > hit.tick + hit.dur - gridTicks() / 2 &&
        (x - tickToX(hit.tick + hit.dur)) > -6;
      pushUndo(); // 拖动可能修改音符，先存快照（未拖动时快照无害）
      redoStack.length = 0;
      drag = {
        mode: nearRight ? 'resize' : 'move',
        startX: x, startY: y,
        orig: new Map([...selection].map(id => {
          const n = tr.notes.find(nn => nn.id === id);
          return [id, n ? { tick: n.tick, pitch: n.pitch, dur: n.dur } : null];
        }).filter(([, v]) => v)),
        moved: false,
      };
    } else {
      if (!e.shiftKey) selection.clear();
      const tick = Math.max(0, snapTick(xToTick(x)));
      const pitch = yToPitch(y);
      mutate(() => {
        const n = Model.newNote(tr, tick, pitch, Math.max(gridTicks(), project.ppq / 4), 100);
        selection.clear();
        selection.add(n.id);
      });
      drag = { mode: 'resize-new', startX: x, startY: y, newId: [...selection][0], moved: false };
    }
    draw();
    renderIssues();
  });

  window.addEventListener('mousemove', e => {
    if (!drag) return;
    const rect = roll.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const tr = project.tracks[selectedTrack];
    if (!tr) return;
    if (drag.mode === 'resize-new') {
      const n = tr.notes.find(nn => nn.id === drag.newId);
      if (n) {
        const end = Math.max(n.tick + gridTicks(), snapTick(xToTick(x)));
        n.dur = end - n.tick;
      }
    } else if (drag.mode === 'move') {
      const dTick = snapTick(xToTick(x)) - snapTick(xToTick(drag.startX));
      const dPitch = yToPitch(y) - yToPitch(drag.startY);
      if (dTick !== 0 || dPitch !== 0) drag.moved = true;
      for (const [id, o] of drag.orig) {
        const n = tr.notes.find(nn => nn.id === id);
        if (!n) continue;
        n.tick = Math.max(0, o.tick + dTick);
        n.pitch = Math.max(0, Math.min(127, o.pitch + dPitch));
      }
    } else if (drag.mode === 'resize') {
      for (const [id, o] of drag.orig) {
        const n = tr.notes.find(nn => nn.id === id);
        if (!n) continue;
        const end = Math.max(o.tick + gridTicks(), snapTick(xToTick(x)) + (o.tick - snapTick(xToTick(drag.startX))));
        n.dur = end - o.tick;
        drag.moved = true;
      }
    }
    draw();
  });

  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    refresh();
  });

  ruler.addEventListener('mousedown', e => {
    const rect = ruler.getBoundingClientRect();
    const set = ev => {
      playheadTick = Math.max(0, Math.min(Math.round(xToTick(ev.clientX - rect.left)), Model.totalTicks(project)));
      draw(); updateStatus();
    };
    set(e);
    const mv = ev => set(ev);
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });

  /* ---------- 编辑操作 ---------- */
  function selectedNotes() {
    const tr = project.tracks[selectedTrack];
    return tr ? tr.notes.filter(n => selection.has(n.id)) : [];
  }

  function deleteSelected() {
    if (!selection.size) return;
    mutate(() => {
      const tr = project.tracks[selectedTrack];
      tr.notes = tr.notes.filter(n => !selection.has(n.id));
      selection.clear();
    });
  }

  function copySelected() {
    const notes = selectedNotes();
    if (!notes.length) return;
    const t0 = Math.min(...notes.map(n => n.tick));
    clipboard = notes.map(n => ({ dt: n.tick - t0, pitch: n.pitch, dur: n.dur, vel: n.vel }));
    setStatus(`已复制 ${clipboard.length} 个音符`);
  }

  function paste() {
    if (!clipboard.length) return;
    mutate(() => {
      const tr = project.tracks[selectedTrack];
      const base = snapTick(playheadTick);
      selection.clear();
      for (const c of clipboard) {
        const n = Model.newNote(tr, base + c.dt, c.pitch, c.dur, c.vel);
        selection.add(n.id);
      }
    });
    setStatus(`已粘贴 ${clipboard.length} 个音符`);
  }

  function quantize() {
    const targets = selection.size ? selectedNotes() : (project.tracks[selectedTrack] || { notes: [] }).notes;
    if (!targets.length) return;
    mutate(() => {
      for (const n of targets) {
        const end = n.tick + n.dur;
        n.tick = Math.max(0, snapTick(n.tick));
        n.dur = Math.max(gridTicks(), snapTick(end) - n.tick);
      }
    });
    setStatus(`已量化 ${targets.length} 个音符（网格 1/${snapDiv * 4}）`);
  }

  function transpose(semi) {
    const tr = project.tracks[selectedTrack];
    if (!tr) return;
    if (tr.instrument === 'drums') { setStatus('鼓轨不参与移调'); return; }
    const targets = selection.size ? selectedNotes() : tr.notes;
    if (!targets.length) return;
    mutate(() => {
      for (const n of targets) n.pitch = Math.max(0, Math.min(127, n.pitch + semi));
    });
    setStatus(`已移调 ${semi > 0 ? '+' : ''}${semi} 半音（${targets.length} 个音符）`);
  }

  function allowOverlapSelected() {
    const notes = selectedNotes();
    if (!notes.length) { setStatus('请先选中要保留重叠的音符'); return; }
    mutate(() => { for (const n of notes) n.allowOverlap = true; });
    setStatus(`已将 ${notes.length} 个音符标记为“有意重叠”，不再提示`);
  }

  /* ---------- 轨道面板 ---------- */
  function renderTracks() {
    const el = $('trackList');
    el.innerHTML = '';
    project.tracks.forEach((tr, i) => {
      const row = document.createElement('div');
      row.className = 'track-row' + (i === selectedTrack ? ' selected' : '');
      row.innerHTML = `
        <span class="chip" style="background:${TRACK_COLORS[i % TRACK_COLORS.length]}"></span>
        <span class="tname" title="双击重命名">${tr.name}</span>
        <select class="inst">
          <option value="piano"${tr.instrument === 'piano' ? ' selected' : ''}>钢琴</option>
          <option value="drums"${tr.instrument === 'drums' ? ' selected' : ''}>鼓组</option>
        </select>
        <button class="mute${tr.muted ? ' on' : ''}" title="静音">M</button>
        <button class="solo${tr.solo ? ' on' : ''}" title="独奏">S</button>
        <button class="del" title="删除轨道">×</button>`;
      row.addEventListener('click', e => {
        if (e.target.closest('select,button')) return;
        selectedTrack = i;
        selection.clear();
        refresh();
      });
      row.querySelector('.tname').addEventListener('dblclick', () => {
        const name = prompt('轨道名称', tr.name);
        if (name) mutate(() => { tr.name = name; });
      });
      row.querySelector('.inst').addEventListener('change', e => {
        mutate(() => { tr.instrument = e.target.value; });
      });
      row.querySelector('.mute').addEventListener('click', () => mutate(() => { tr.muted = !tr.muted; }));
      row.querySelector('.solo').addEventListener('click', () => mutate(() => { tr.solo = !tr.solo; }));
      row.querySelector('.del').addEventListener('click', () => {
        if (!confirm(`删除轨道「${tr.name}」及其全部音符？`)) return;
        mutate(() => {
          project.tracks.splice(i, 1);
          if (!project.tracks.length) project.tracks.push(Model.createTrack('Piano', 'piano'));
          selectedTrack = Math.min(selectedTrack, project.tracks.length - 1);
          selection.clear();
        });
      });
      el.appendChild(row);
    });
  }

  /* ---------- 速度 / 拍号面板 ---------- */
  function renderTempoSig() {
    const tl = $('tempoList');
    tl.innerHTML = '';
    project.tempoMap.slice().sort((a, b) => a.tick - b.tick).forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'map-row';
      row.innerHTML = `<span>${Model.formatPosition(project, t.tick)}</span>
        <input type="number" min="20" max="300" step="1" value="${t.bpm}">
        ${i === 0 ? '<span></span>' : '<button title="删除">×</button>'}`;
      row.querySelector('input').addEventListener('change', e => {
        const bpm = Math.max(20, Math.min(300, +e.target.value || 120));
        mutate(() => { t.bpm = bpm; });
      });
      const del = row.querySelector('button');
      if (del) del.addEventListener('click', () => mutate(() => {
        project.tempoMap = project.tempoMap.filter(x => x !== t);
      }));
      tl.appendChild(row);
    });

    const sl = $('sigList');
    sl.innerHTML = '';
    project.timeSigs.slice().sort((a, b) => a.tick - b.tick).forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'map-row';
      row.innerHTML = `<span>${Model.formatPosition(project, s.tick)}</span>
        <input type="number" min="1" max="32" value="${s.num}" class="num">
        <span>/</span>
        <select class="den">${[1, 2, 4, 8, 16].map(d => `<option${d === s.den ? ' selected' : ''}>${d}</option>`).join('')}</select>
        ${i === 0 ? '<span></span>' : '<button title="删除">×</button>'}`;
      row.querySelector('.num').addEventListener('change', e => {
        mutate(() => { s.num = Math.max(1, Math.min(32, Math.round(+e.target.value) || 4)); });
      });
      row.querySelector('.den').addEventListener('change', e => {
        mutate(() => { s.den = +e.target.value; });
      });
      const del = row.querySelector('button');
      if (del) del.addEventListener('click', () => mutate(() => {
        project.timeSigs = project.timeSigs.filter(x => x !== s);
      }));
      sl.appendChild(row);
    });
  }

  function addTempoChange() {
    const tick = snapTick(playheadTick);
    mutate(() => {
      const exist = project.tempoMap.find(t => t.tick === tick);
      if (exist) exist.bpm = 120;
      else project.tempoMap.push({ tick, bpm: 120 });
    });
    setStatus(`已在 ${Model.formatPosition(project, tick)} 添加变速点，请在左侧面板修改 BPM`);
  }

  function addSigChange() {
    // 对齐到当前小节起点
    const pos = Model.tickToPosition(project, playheadTick);
    const bounds = Model.measureBoundaries(project);
    const tick = bounds[pos.measure].tick;
    mutate(() => {
      const exist = project.timeSigs.find(s => s.tick === tick);
      if (exist) { exist.num = 3; exist.den = 4; }
      else project.timeSigs.push({ tick, num: 3, den: 4 });
    });
    setStatus(`已在第 ${pos.measure + 1} 小节添加变拍（默认 3/4，可在左侧修改）`);
  }

  /* ---------- 问题面板 ---------- */
  function renderIssues() {
    issues = Model.validateProject(project);
    const el = $('issuesList');
    el.innerHTML = '';
    $('issueCount').textContent = issues.length ? `（${issues.length}）` : '';
    for (const it of issues) {
      const row = document.createElement('div');
      row.className = 'issue ' + it.type;
      const trName = it.trackIndex >= 0 && project.tracks[it.trackIndex] ? project.tracks[it.trackIndex].name : '?';
      row.textContent = `[${trName}] ${it.msg}`;
      if (it.noteId) {
        row.style.cursor = 'pointer';
        row.title = '点击定位该音符';
        row.addEventListener('click', () => {
          if (it.trackIndex >= 0) selectedTrack = it.trackIndex;
          selection.clear();
          selection.add(it.noteId);
          const n = project.tracks[selectedTrack].notes.find(nn => nn.id === it.noteId);
          if (n) {
            rollScroll.scrollLeft = Math.max(0, tickToX(n.tick) - 100);
            $('keysScroll').scrollTop = rollScroll.scrollTop = Math.max(0, pitchToY(n.pitch) - 150);
          }
          refresh();
        });
      }
      el.appendChild(row);
    }
  }

  /* ---------- 状态栏 ---------- */
  function setStatus(msg) { $('statusMsg').textContent = msg; }
  function updateStatus() {
    const total = Model.totalTicks(project);
    const sec = Model.ticksToSeconds(project, total);
    const count = project.tracks.reduce((s, t) => s + t.notes.length, 0);
    $('statusInfo').textContent =
      `播放头 ${Model.formatPosition(project, playheadTick)} ｜ 总长 ${Model.tickToPosition(project, total).measure + 1} 小节 / ${sec.toFixed(2)} 秒 ｜ ${project.tracks.length} 轨 / ${count} 音符`;
  }

  /* ---------- 工程保存 / 载入 ---------- */
  function download(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function saveProject() {
    const json = JSON.stringify(project, null, 2);
    download(`${project.name || 'project'}.mmaproj.json`, new Blob([json], { type: 'application/json' }));
    setStatus('工程已导出为 JSON，可随时重新打开继续编辑');
  }

  function openProjectFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { project: p, issues: loadIssues } = Model.normalizeProject(JSON.parse(reader.result));
        pushUndo();
        project = p;
        selectedTrack = 0;
        selection.clear();
        playheadTick = 0;
        refresh();
        if (loadIssues.length) {
          issues = loadIssues.concat(issues);
          const el = $('issuesList');
          for (const it of loadIssues) {
            const row = document.createElement('div');
            row.className = 'issue invalid-track';
            row.textContent = it.msg;
            el.prepend(row);
          }
          setStatus(`工程已打开，但有 ${loadIssues.length} 条数据问题（见问题面板）`);
        } else {
          setStatus('工程已打开');
        }
      } catch (err) {
        alert('打开工程失败：' + err.message);
      }
    };
    reader.readAsText(file);
  }

  function exportMidi() {
    const data = MidiFile.write(project);
    download(`${project.name || 'song'}.mid`, new Blob([data], { type: 'audio/midi' }));
    const total = Model.totalTicks(project);
    setStatus(`已导出 MIDI：${project.tracks.length} 轨，${Model.ticksToSeconds(project, total).toFixed(2)} 秒，PPQ=${project.ppq}`);
  }

  function importMidi(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = MidiFile.parse(reader.result);
        pushUndo();
        project = p;
        selectedTrack = 0;
        selection.clear();
        playheadTick = 0;
        refresh();
        const total = Model.totalTicks(p);
        const summary = p.tracks.map((t, i) => `轨${i + 1}「${t.name}」${t.instrument === 'drums' ? '(鼓)' : ''} ${t.notes.length} 音符`).join('；');
        setStatus(`MIDI 已导入：总长 ${Model.ticksToSeconds(p, total).toFixed(2)} 秒。${summary}`);
      } catch (err) {
        alert('导入 MIDI 失败：' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  /* ---------- 本地暂存（继续编辑） ---------- */
  let autosaveTimer = null;
  function autosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      try { localStorage.setItem('midi-arranger-project', JSON.stringify(project)); } catch (e) { /* 忽略配额错误 */ }
    }, 500);
  }

  function restoreAutosave() {
    try {
      const raw = localStorage.getItem('midi-arranger-project');
      if (!raw) return false;
      const { project: p } = Model.normalizeProject(JSON.parse(raw));
      project = p;
      return true;
    } catch (e) { return false; }
  }

  /* ---------- 刷新 ---------- */
  function refresh() {
    $('projectName').value = project.name;
    $('inputMeasures').value = project.lengthMeasures;
    renderTracks();
    renderTempoSig();
    draw();
    renderIssues();
    updateStatus();
    autosave();
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('btnPlay').addEventListener('click', togglePlay);
    $('btnStop').addEventListener('click', () => { stop(false); playheadTick = 0; draw(); updateStatus(); });
    $('btnNew').addEventListener('click', () => {
      if (!confirm('新建工程？未保存的修改将丢失（可先保存工程）。')) return;
      pushUndo();
      project = Model.createProject();
      selectedTrack = 0; selection.clear(); playheadTick = 0;
      refresh();
    });
    $('btnDemo').addEventListener('click', () => {
      pushUndo();
      project = Demo.build();
      selectedTrack = 0; selection.clear(); playheadTick = 0;
      refresh();
      setStatus('已载入示例曲：前 4 小节 4/4 @120，后 4 小节 3/4 @90');
    });
    $('btnSave').addEventListener('click', saveProject);
    $('btnOpen').addEventListener('click', () => $('fileOpen').click());
    $('fileOpen').addEventListener('change', e => {
      if (e.target.files[0]) openProjectFile(e.target.files[0]);
      e.target.value = '';
    });
    $('btnExportMidi').addEventListener('click', exportMidi);
    $('btnImportMidi').addEventListener('click', () => $('fileMidi').click());
    $('fileMidi').addEventListener('change', e => {
      if (e.target.files[0]) importMidi(e.target.files[0]);
      e.target.value = '';
    });

    $('projectName').addEventListener('change', e => {
      mutate(() => { project.name = e.target.value || '未命名工程'; });
    });
    $('inputMeasures').addEventListener('change', e => {
      const v = Math.max(1, Math.min(999, Math.round(+e.target.value) || 8));
      mutate(() => { project.lengthMeasures = v; });
    });

    $('selSnap').addEventListener('change', e => { snapDiv = +e.target.value; draw(); });
    $('btnZoomIn').addEventListener('click', () => { pxPerBeat = Math.min(192, pxPerBeat * 1.25); draw(); });
    $('btnZoomOut').addEventListener('click', () => { pxPerBeat = Math.max(8, pxPerBeat / 1.25); draw(); });

    $('btnQuantize').addEventListener('click', quantize);
    $('btnTransUp').addEventListener('click', () => transpose(1));
    $('btnTransDown').addEventListener('click', () => transpose(-1));
    $('btnOctUp').addEventListener('click', () => transpose(12));
    $('btnOctDown').addEventListener('click', () => transpose(-12));
    $('btnCopy').addEventListener('click', copySelected);
    $('btnPaste').addEventListener('click', paste);
    $('btnDelete').addEventListener('click', deleteSelected);
    $('btnAllowOverlap').addEventListener('click', allowOverlapSelected);
    $('btnAddTempo').addEventListener('click', addTempoChange);
    $('btnAddSig').addEventListener('click', addSigChange);
    $('btnAddTrack').addEventListener('click', () => {
      mutate(() => {
        project.tracks.push(Model.createTrack(`Track ${project.tracks.length + 1}`, 'piano'));
        selectedTrack = project.tracks.length - 1;
      });
    });

    // 滚动同步
    rollScroll.addEventListener('scroll', () => {
      $('keysScroll').scrollTop = rollScroll.scrollTop;
      $('rulerScroll').scrollLeft = rollScroll.scrollLeft;
    });

    window.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
      else if ((e.metaKey || e.ctrlKey) && e.key === 'c') copySelected();
      else if ((e.metaKey || e.ctrlKey) && e.key === 'v') paste();
      else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); }
    });

    // 播放时刷新播放头
    (function raf() {
      if (player.playing) {
        playheadTick = Math.round(currentTick());
        draw();
        updateStatus();
      }
      requestAnimationFrame(raf);
    })();
  }

  /* ---------- 启动 ---------- */
  if (!restoreAutosave()) project = Demo.build();
  bind();
  refresh();
  // 初始滚动到 C4 附近
  rollScroll.scrollTop = $('keysScroll').scrollTop = pitchToY(72) - 100;
})();
