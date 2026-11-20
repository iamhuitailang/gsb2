/*
 * projectio.js — 工程保存/读取与点云导出
 * 工程文件(.pcproj.json)只保存源文件名、变换、裁剪/筛选后的索引与参数,
 * 不内嵌点数据;重新打开时按文件名重新载入本地文件即可还原。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PCProjectIO = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PROJECT_VERSION = 1;

  function scanToProject(scan) {
    return {
      name: scan.name,
      fileName: scan.fileName,
      format: scan.format,
      translation: scan.translation,
      rotationDeg: scan.rotationDeg,
      cropBox: scan.lastCropBox
        ? { min: scan.lastCropBox.min.slice(), max: scan.lastCropBox.max.slice() } : null,
      activeIndices: scan.activeIndices ? Array.from(scan.activeIndices) : null,
      originalCount: scan.originalCount(),
      visibleCount: scan.count(),
      historyLabels: scan.history.map(function (h) { return h.label; }),
      parseErrorLines: scan.parseErrors.map(function (e) { return e.line; })
    };
  }

  function saveProject(store, options) {
    options = options || {};
    return {
      type: 'pointcloud-inspector-project',
      version: PROJECT_VERSION,
      createdAt: new Date().toISOString(),
      note: options.note || '',
      layout: options.layout || 'overlay',
      registration: options.registration || null,
      scans: store.scans.map(scanToProject)
    };
  }

  // 读取工程: 需要调用方按 fileName 提供重新解析出的数据 loaders: {fileName: parsedData}
  function restoreProject(project, store, ScanState, loaders) {
    store.scans = [];
    store.activeId = null;
    for (const ps of project.scans) {
      const data = loaders && loaders[ps.fileName];
      if (!data) {
        const e = new Error('缺少源文件数据: ' + ps.fileName);
        e.code = 'MISSING_SOURCE';
        e.fileName = ps.fileName;
        throw e;
      }
      data.fileName = ps.fileName;
      const scan = store.add(data, ps.name);
      scan.translation = ps.translation.slice();
      scan.rotationDeg = ps.rotationDeg.slice();
      scan.activeIndices = ps.activeIndices ? Uint32Array.from(ps.activeIndices) : null;
      scan.lastCropBox = ps.cropBox
        ? { min: ps.cropBox.min.slice(), max: ps.cropBox.max.slice() } : null;
      scan.history = []; // 还原后的工程重新开始记录撤销栈
    }
    return project;
  }

  // 导出当前(变换后、筛选后)点云为 XYZ 文本;withColor 控制是否写颜色列
  function exportXYZ(scan, options) {
    options = options || {};
    const delimiter = options.delimiter === 'comma' ? ',' : ' ';
    const withColor = options.withColor !== false && !!scan.colors;
    const m = scan.matrix();
    const idx = scan.activeIndices;
    const n = idx ? idx.length : scan.points.length;
    const lines = [];
    lines.push('# 导出自点云检查工具 ' + new Date().toISOString());
    lines.push('# 源文件: ' + scan.fileName + '  原始点数: ' +
      scan.originalCount() + '  导出点数: ' + n);
    lines.push('# 平移: [' + scan.translation.map(fmt).join(', ') +
      '] 旋转(度): [' + scan.rotationDeg.map(fmt).join(', ') + ']');
    for (let i = 0; i < n; i++) {
      const oi = idx ? idx[i] : i;
      const wp = m ? applyExport(m, scan.points[oi]) : scan.points[oi];
      let row = [fmt(wp[0]), fmt(wp[1]), fmt(wp[2])];
      if (withColor) {
        const c = scan.colors[oi];
        row.push(String(c[0]), String(c[1]), String(c[2]));
      }
      lines.push(row.join(delimiter));
    }
    return lines.join('\n') + '\n';
  }

  function applyExport(m, p) {
    const x = p[0], y = p[1], z = p[2];
    return [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14]
    ];
  }

  function fmt(v) {
    if (Math.abs(v) >= 1e6 || (Math.abs(v) > 0 && Math.abs(v) < 1e-4)) {
      return v.toExponential(6);
    }
    return (Math.round(v * 1e6) / 1e6).toString();
  }

  // 人类可读的工程说明(Markdown)
  function exportProjectNote(store, project) {
    const out = [];
    out.push('# 点云检查工程说明');
    out.push('');
    out.push('- 生成时间: ' + new Date().toISOString());
    if (project && project.note) out.push('- 备注: ' + project.note);
    out.push('- 扫描数量: ' + store.scans.length);
    out.push('');
    store.scans.forEach(function (s, i) {
      out.push('## 扫描 ' + (i + 1) + ': ' + s.name);
      out.push('');
      out.push('- 源文件: `' + s.fileName + '` (' + s.format.toUpperCase() + ')');
      out.push('- 点数: ' + s.count() + ' / 原始 ' + s.originalCount());
      out.push('- 平移 (x,y,z): ' + s.translation.map(fmt).join(', '));
      out.push('- 旋转度 (rx,ry,rz): ' + s.rotationDeg.map(fmt).join(', '));
      if (s.lastCropBox) {
        out.push('- 裁剪范围(世界坐标) min: [' + s.lastCropBox.min.map(fmt).join(', ') +
          '] max: [' + s.lastCropBox.max.map(fmt).join(', ') + ']');
      }
      if (s.parseErrors.length) {
        out.push('- 解析坏行(' + s.parseErrors.length + '): 行号 ' +
          s.parseErrors.map(function (e) { return e.line; }).join(', '));
      }
      if (s.bbox) {
        out.push('- 原始包围盒: min [' + s.bbox.min.map(fmt).join(', ') +
          '] max [' + s.bbox.max.map(fmt).join(', ') + ']');
      }
      out.push('');
    });
    if (project && project.registration && project.registration.rmse !== null) {
      const r = project.registration;
      out.push('## 配准误差(最近邻)');
      out.push('');
      out.push('- 抽样点数: ' + r.samples + ' / 目标点数: ' + r.targetCount);
      out.push('- RMSE: ' + fmt(r.rmse));
      out.push('- 平均距离: ' + fmt(r.mean));
      out.push('- 中位数: ' + fmt(r.median));
      out.push('- 最大距离: ' + fmt(r.max));
      out.push('');
    }
    return out.join('\n');
  }

  return {
    saveProject: saveProject,
    restoreProject: restoreProject,
    exportXYZ: exportXYZ,
    exportProjectNote: exportProjectNote
  };
});
