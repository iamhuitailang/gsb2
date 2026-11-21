/*
 * 导出游戏可读配置，并支持把同结构的 manifest 导回预览器。
 * 导出时把镜像替代关系、无法替代的缺口、帧级缺帧全部显式列出，
 * 游戏侧不需要再推断方向选择策略。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./angle.js'));
  else root.Exporter = factory(root.Angle);
})(typeof self !== 'undefined' ? self : this, function (Angle) {
  'use strict';

  const FORMAT = 'multi-angle-sprite-config/v1';

  function buildConfig(dataset, mirrorEnabled) {
    const audit = Angle.audit(dataset, mirrorEnabled);
    const sequences = {};

    for (const key of Object.keys(dataset.sequences)) {
      const seq = dataset.sequences[key];
      sequences[key] = {
        actionId: seq.actionId,
        directionId: seq.directionId,
        frames: seq.frames.map((f) => ({
          id: f.id,
          source: f.missing ? null : f.source,
          anchor: { x: f.anchorX, y: f.anchorY },
          durationMs: f.duration,
          missing: !!f.missing,
        })),
      };
    }

    const substitutions = [];
    const unresolved = [];
    for (const item of audit) {
      if (item.type === 'direction') {
        if (item.mirrorSource) {
          substitutions.push({
            actionId: item.actionId,
            directionId: item.directionId,
            sourceDirectionId: item.mirrorSource,
            mirror: true,
          });
        } else {
          unresolved.push({ actionId: item.actionId, directionId: item.directionId, reason: 'no-sequence' });
        }
      } else if (item.type === 'frame') {
        unresolved.push({
          actionId: item.actionId,
          directionId: item.directionId,
          reason: 'missing-frames',
          frameIndexes: item.indexes,
        });
      }
    }

    return {
      format: FORMAT,
      exportedAt: new Date().toISOString(),
      name: dataset.name,
      id: dataset.id,
      mirrorFallback: !!mirrorEnabled,
      angleConvention: '0=north, clockwise, degrees',
      frameWidth: dataset.frameWidth,
      frameHeight: dataset.frameHeight,
      directions: dataset.directions.map((d) => ({ id: d.id, name: d.name, angle: d.angle })),
      actions: dataset.actions.map((a) => ({ id: a.id, name: a.name })),
      sequences,
      substitutions,
      unresolved,
    };
  }

  function toJSON(dataset, mirrorEnabled, pretty) {
    return JSON.stringify(buildConfig(dataset, mirrorEnabled), null, pretty ? 2 : 0);
  }

  /** 把导出的 manifest 还原成预览器内部 dataset 结构 */
  function parseConfig(config) {
    if (!config || config.format !== FORMAT) {
      throw new Error('格式不匹配：期望 ' + FORMAT);
    }
    const sequences = {};
    for (const key of Object.keys(config.sequences || {})) {
      const seq = config.sequences[key];
      sequences[key] = {
        actionId: seq.actionId,
        directionId: seq.directionId,
        frames: seq.frames.map((f, i) => ({
          id: f.id || `${seq.actionId}-${seq.directionId}-${i}`,
          source: f.source,
          anchorX: f.anchor ? f.anchor.x : 0,
          anchorY: f.anchor ? f.anchor.y : 0,
          duration: f.durationMs != null ? f.durationMs : 200,
          missing: !!f.missing,
          phase: seq.frames.length ? i / seq.frames.length : 0,
        })),
      };
    }
    return {
      id: config.id || 'imported',
      name: config.name || '导入的配置',
      description: `从 manifest 导入（镜像补齐：${config.mirrorFallback ? '开' : '关'}）`,
      frameWidth: config.frameWidth,
      frameHeight: config.frameHeight,
      defaultAnchor: { x: config.frameWidth / 2, y: config.frameHeight - 8 },
      directions: config.directions,
      actions: config.actions,
      sequences,
      imported: true,
    };
  }

  return { FORMAT, buildConfig, toJSON, parseConfig };
});
