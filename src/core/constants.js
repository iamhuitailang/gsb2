// 全局常量与默认配置。

export const CHUNK_SIZE = 32; // 每个分块的世界尺寸（米）
export const MIN_CELL_SIZE = 0.25; // 候选格最小边长，防止密度参数过大导致格点爆炸
export const SCHEMA_VERSION = 1;

// 笔刷工具
export const TOOL = {
  PAINT: 'paint', // 在笔刷区域重新生成（局部重刷）
  ERASE: 'erase', // 擦除区域内实例
  REPLACE: 'replace', // 只替换实例的模型类型，保留位置
  MASK: 'mask', // 手绘遮罩（加/减由 brush.params.maskMode 决定）
};

export const DEFAULT_SEED = 20240901;
