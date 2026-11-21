/* 全局常量与默认数据。所有模块通过 window.JR 命名空间访问，保证 file:// 直接打开可用。 */
(function () {
  const JR = (window.JR = window.JR || {});

  JR.C = {
    SUBSTEPS: 60, // 每秒物理子步数（固定步长，分析与试玩共用）
    DT: 1 / 60,
    GRID: 16,
    EDGE_TOLERANCE: 4, // 贴边容差：角色脚底与平台边缘水平重叠 >= 该值才算站住（像素）
    MAX_SIM_SECONDS: 12, // 单次模拟最长时间，防止无限飞行
    FALL_MARGIN: 200, // 角色低于关卡最低处该距离后判定落出
    // 分析器枚举网格
    DIR_SAMPLES: [-1, 1],
    HOLD_SAMPLES: [0.06, 0.12, 0.2, 0.3, 0.45, 0.7, 1.05], // 按住跳跃的时长（秒）
    MOVE_SAMPLES: [0, 0.35, 0.6, 0.8, 1.0], // 空中横移输入强度
  };

  // 默认角色参数 A：标准手感
  JR.DEFAULT_PARAMS_A = {
    name: '参数A·标准',
    width: 20,
    height: 32,
    jumpSpeed: 430, // 起跳瞬间垂直速度 px/s
    gravity: 1200, // 重力 px/s²
    jumpCut: 0.45, // 松开跳跃键后垂直速度乘该系数（可变跳高）
    maxHold: 0.22, // 跳跃键最长生效窗口（秒）
    moveSpeed: 210, // 最大水平速度 px/s
    groundAccel: 1800,
    airAccel: 1300,
    groundFriction: 1600,
    airFriction: 250,
  };

  // 角色参数 B：弱弹跳（演示连通性差异）
  JR.DEFAULT_PARAMS_B = {
    name: '参数B·弱弹跳',
    width: 20,
    height: 32,
    jumpSpeed: 350,
    gravity: 1350,
    jumpCut: 0.45,
    maxHold: 0.2,
    moveSpeed: 195,
    groundAccel: 1800,
    airAccel: 1300,
    groundFriction: 1600,
    airFriction: 250,
  };

  JR.ENTITY_TYPES = {
    platform: { color: '#4a86c5', label: '水平平台' },
    overhead: { color: '#c56a4a', label: '上方障碍' },
    start: { color: '#57b26b', label: '起跳区域' },
  };
})();
