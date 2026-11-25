// 共享几何缓冲:一个单位立方体(所有栅栏板条/方块/遮挡物复用,实例化绘制),
// 一个大四边形(静止细线墙),一个全屏三角形(所有后处理 pass)。
// 位置与法线交错存储,模型矩阵走逐实例 attribute。

export function createCube(gl) {
  // 6 面 * 2 三角形 * 3 顶点;position(3) + normal(3)
  const p = 0.5;
  const faces = [
    { n: [0, 0, 1], v: [[-p, -p, p], [p, -p, p], [p, p, p], [-p, p, p]] },
    { n: [0, 0, -1], v: [[p, -p, -p], [-p, -p, -p], [-p, p, -p], [p, p, -p]] },
    { n: [1, 0, 0], v: [[p, -p, p], [p, -p, -p], [p, p, -p], [p, p, p]] },
    { n: [-1, 0, 0], v: [[-p, -p, -p], [-p, -p, p], [-p, p, p], [-p, p, -p]] },
    { n: [0, 1, 0], v: [[-p, p, p], [p, p, p], [p, p, -p], [-p, p, -p]] },
    { n: [0, -1, 0], v: [[-p, -p, -p], [p, -p, -p], [p, -p, p], [-p, -p, p]] },
  ];
  const data = [];
  for (const f of faces) {
    const idx = [0, 1, 2, 0, 2, 3];
    for (const i of idx) {
      data.push(...f.v[i], ...f.n);
    }
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  gl.bindVertexArray(null);
  return { vao, vertexCount: 36 };
}

export function createQuad(gl) {
  // 墙面:xz 不缩放,直接用 xy 平面 + 模型矩阵定位
  const p = 1;
  const data = [
    -p, -p, 0, 0, 0, 1,
    p, -p, 0, 0, 0, 1,
    p, p, 0, 0, 0, 1,
    -p, -p, 0, 0, 0, 1,
    p, p, 0, 0, 0, 1,
    -p, p, 0, 0, 0, 1,
  ];
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  gl.bindVertexArray(null);
  return { vao, vertexCount: 6 };
}

export function createFullscreenTriangle(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 3, -1, -1, 3,
  ]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
  gl.bindVertexArray(null);
  return { vao, vertexCount: 3 };
}

// 实例化立方体 VAO:几何(loc 0/1)与两套实例矩阵(loc 2-5 当前、
// loc 6-9 前一帧)必须记录在同一个 VAO 里,否则切换 VAO 后实例属性
// 处于禁用状态,矩阵读成 0,板条会全部退化到原点。
export function createInstancedCube(gl, maxInstances) {
  const base = createCube(gl);
  gl.bindVertexArray(base.vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, maxInstances * 32 * 4, gl.DYNAMIC_DRAW);
  for (let i = 0; i < 4; i++) {
    const loc = 2 + i;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 128, i * 16);
    gl.vertexAttribDivisor(loc, 1);
  }
  for (let i = 0; i < 4; i++) {
    const loc = 6 + i;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 128, 64 + i * 16);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);
  return { vao: base.vao, vertexCount: base.vertexCount, vbo, maxInstances };
}

export function uploadInstances(gl, ic, matrices, prevMatrices) {
  gl.bindBuffer(gl.ARRAY_BUFFER, ic.vbo);
  const flat = new Float32Array(matrices.length * 32);
  matrices.forEach((m, i) => {
    flat.set(m, i * 32);
    flat.set(prevMatrices[i], i * 32 + 16);
  });
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, flat);
}
