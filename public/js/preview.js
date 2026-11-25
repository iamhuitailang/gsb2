/*
 * preview.js —— 预览渲染：
 *  - ImageData 画到 canvas（最近邻，方便看像素）
 *  - 尺寸策略叠加层（留边区/裁切区）
 *  - WebGL 球面法线预览：同一法线图按 OpenGL / DirectX 即时对比表面效果
 */
(function (global) {
  "use strict";
  const MT = global.MT || (global.MT = {});
  const core = MT.core;

  function drawImageData(canvas, imageData) {
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(imageData, 0, 0);
  }

  /**
   * 在输出预览上叠加尺寸策略提示。
   * pad: 留边区域用斜线标红；crop: 被裁掉的源区域用文字与边框提示。
   */
  function drawResizeOverlay(canvas, resizeInfos, tw, th) {
    const ctx = canvas.getContext("2d");
    const seen = new Set();
    for (const info of resizeInfos || []) {
      if (!info.mismatch) continue;
      const key = info.policy + JSON.stringify(info.rect);
      if (seen.has(key)) continue;
      seen.add(key);
      const { rect, policy } = info;
      ctx.save();
      ctx.lineWidth = 2;
      ctx.font = "bold 14px sans-serif";
      if (policy === "pad") {
        ctx.strokeStyle = "rgba(255,80,80,0.95)";
        ctx.fillStyle = "rgba(255,80,80,0.12)";
        ctx.fillRect(0, 0, tw, th);
        ctx.strokeRect(rect.dx + 1, rect.dy + 1, rect.dw - 2, rect.dh - 2);
        ctx.fillStyle = "rgba(255,80,80,0.95)";
        ctx.fillText("留边区域（填充色）", 6, 18);
      } else if (policy === "crop") {
        ctx.strokeStyle = "rgba(255,170,0,0.95)";
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(rect.dx + 1, rect.dy + 1, rect.dw - 2, rect.dh - 2);
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(255,170,0,0.95)";
        ctx.fillText("等比放大后居中裁切", 6, 18);
      } else {
        ctx.fillStyle = "rgba(80,160,255,0.95)";
        ctx.fillText("拉伸铺满（可能变形）", 6, 18);
      }
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ //
  // WebGL 法线球面预览
  // ------------------------------------------------------------------ //

  const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uMVP;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  vNormal = aNormal;
  // 单位球：位置与法线同向；aPos 参与运算避免被编译器优化成 -1 location
  vec3 pos = normalize(aPos + aNormal * 0.0001);
  vec4 wp = uMVP * vec4(pos, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = uMVP * vec4(aNormal, 1.0);
}`;

  const FRAG = `
precision mediump float;
uniform sampler2D uNormalMap;
uniform vec2 uUVScale;
uniform vec2 uUVOffset;
uniform float uFlipY;      // directx 时为 -1
uniform vec3 uLightDir;
uniform vec3 uCameraPos;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  vec2 uv = vNormal.xy * 0.5 + 0.5;
  uv = uv * uUVScale + uUVOffset;
  vec3 tn = texture2D(uNormalMap, uv).rgb * 2.0 - 1.0;
  tn.y *= uFlipY;
  if (length(tn) < 0.01) tn = vec3(0.0, 0.0, 1.0);
  tn = normalize(tn);
  // 用球面法线构造简单 TBN（球心在原点）
  vec3 N = normalize(vNormal);
  vec3 T = normalize(cross(N, vec3(0.0, 1.0, 0.0)));
  vec3 B = cross(N, T);
  vec3 mapped = normalize(T * tn.x + B * tn.y + N * tn.z);
  vec3 L = normalize(uLightDir);
  float diff = max(dot(mapped, L), 0.0);
  vec3 V = normalize(uCameraPos - vWorldPos);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(mapped, H), 0.0), 24.0) * 0.5;
  vec3 base = vec3(0.72, 0.74, 0.8);
  vec3 color = base * (0.25 + 0.75 * diff) + vec3(1.0) * spec;
  gl_FragColor = vec4(color, 1.0);
}`;

  function compileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error("shader 编译失败: " + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function makeSphere(latBands, lonBands) {
    const positions = [];
    const normals = [];
    const indices = [];
    for (let lat = 0; lat <= latBands; lat++) {
      const theta = (lat * Math.PI) / latBands;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      for (let lon = 0; lon <= lonBands; lon++) {
        const phi = (lon * 2 * Math.PI) / lonBands;
        const x = sinT * Math.cos(phi);
        const y = cosT;
        const z = sinT * Math.sin(phi);
        positions.push(x, y, z);
        normals.push(x, y, z);
      }
    }
    for (let lat = 0; lat < latBands; lat++) {
      for (let lon = 0; lon < lonBands; lon++) {
        const first = lat * (lonBands + 1) + lon;
        const second = first + lonBands + 1;
        indices.push(first, second, first + 1, second, second + 1, first + 1);
      }
    }
    return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices) };
  }

  // 简易列主序矩阵（透视 + 视图）
  function mat4Perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  }
  function mat4LookAt(eye, center, up) {
    const sub = (a, b) => a.map((v, i) => v - b[i]);
    const cross = (a, b) => [
      a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
    ];
    const norm = (a) => {
      const l = Math.hypot(...a);
      return a.map((v) => v / l);
    };
    const z = norm(sub(eye, center));
    const x = norm(cross(up, z));
    const y = cross(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -x.reduce((s, v, i) => s + v * eye[i], 0),
      -y.reduce((s, v, i) => s + v * eye[i], 0),
      -z.reduce((s, v, i) => s + v * eye[i], 0),
      1,
    ]);
  }
  function mat4Mul(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] +
          a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] +
          a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  function NormalPreview(displayCanvas) {
    // WebGL 上下文与 canvas 元素绑定，而界面重绘会替换显示 canvas。
    // 因此 GL 固定渲染到离屏 canvas，每帧再 drawImage 拷到显示 canvas。
    this.displayCanvas = displayCanvas;
    this.canvas = document.createElement("canvas");
    this.canvas.width = displayCanvas.width;
    this.canvas.height = displayCanvas.height;
    this.gl = this.canvas.getContext("webgl", { antialias: true });
    this.ok = !!this.gl;
    if (!this.ok) return;
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      this.ok = false;
      return;
    }
    this.prog = prog;
    this.loc = {
      aPos: gl.getAttribLocation(prog, "aPos"),
      aNormal: gl.getAttribLocation(prog, "aNormal"),
      uMVP: gl.getUniformLocation(prog, "uMVP"),
      uNormalMap: gl.getUniformLocation(prog, "uNormalMap"),
      uUVScale: gl.getUniformLocation(prog, "uUVScale"),
      uUVOffset: gl.getUniformLocation(prog, "uUVOffset"),
      uFlipY: gl.getUniformLocation(prog, "uFlipY"),
      uLightDir: gl.getUniformLocation(prog, "uLightDir"),
      uCameraPos: gl.getUniformLocation(prog, "uCameraPos"),
    };
    const sphere = makeSphere(32, 48);
    this.sphere = sphere;
    this.bufPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
    gl.bufferData(gl.ARRAY_BUFFER, sphere.positions, gl.STATIC_DRAW);
    this.bufNormal = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufNormal);
    gl.bufferData(gl.ARRAY_BUFFER, sphere.normals, gl.STATIC_DRAW);
    this.bufIndex = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIndex);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphere.indices, gl.STATIC_DRAW);
    this.indexCount = sphere.indices.length;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }

  NormalPreview.prototype.updateTexture = function (imageData) {
    if (!this.ok) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
  };

  /**
   * @param orientations ["opengl"] 或 ["opengl","directx"]；后者左右分屏对比
   * @param lightAngleDeg 光源方位角（可由滑块控制）
   */
  NormalPreview.prototype.render = function (orientations, lightAngleDeg) {
    if (!this.ok) return;
    const gl = this.gl;
    const dcanvas = this.displayCanvas;
    if (this.canvas.width !== dcanvas.width || this.canvas.height !== dcanvas.height) {
      this.canvas.width = dcanvas.width;
      this.canvas.height = dcanvas.height;
    }
    const canvas = this.canvas;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.12, 0.13, 0.16, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = (canvas.width / orientations.length) / canvas.height;
    const proj = mat4Perspective(Math.PI / 4, aspect, 0.1, 10);
    const view = mat4LookAt([0, 0, 2.6], [0, 0, 0], [0, 1, 0]);
    const mvp = mat4Mul(proj, view);
    const ang = (lightAngleDeg * Math.PI) / 180;
    const lightDir = [Math.sin(ang) * 0.8, 0.55, Math.cos(ang) * 0.8];

    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
    if (this.loc.aPos >= 0) {
      gl.enableVertexAttribArray(this.loc.aPos);
      gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufNormal);
    gl.enableVertexAttribArray(this.loc.aNormal);
    gl.vertexAttribPointer(this.loc.aNormal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIndex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.loc.uNormalMap, 0);
    gl.uniformMatrix4fv(this.loc.uMVP, false, mvp);
    gl.uniform3fv(this.loc.uLightDir, lightDir);
    gl.uniform3f(this.loc.uCameraPos, 0, 0, 2.6);
    gl.uniform2f(this.loc.uUVScale, 1, 1);
    gl.uniform2f(this.loc.uUVOffset, 0, 0);

    const halfW = canvas.width / orientations.length;
    orientations.forEach((ori, i) => {
      gl.viewport(Math.round(i * halfW), 0, Math.round(halfW), canvas.height);
      gl.uniform1f(this.loc.uFlipY, ori === "directx" ? -1 : 1);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    });

    // 拷贝到显示 canvas
    const dctx = dcanvas.getContext("2d");
    dctx.clearRect(0, 0, dcanvas.width, dcanvas.height);
    dctx.drawImage(canvas, 0, 0);
    if (orientations.length === 2) {
      dctx.save();
      dctx.strokeStyle = "rgba(255,255,255,0.8)";
      dctx.lineWidth = 2;
      dctx.beginPath();
      dctx.moveTo(dcanvas.width / 2, 0);
      dctx.lineTo(dcanvas.width / 2, dcanvas.height);
      dctx.stroke();
      dctx.font = "bold 15px sans-serif";
      dctx.fillStyle = "rgba(255,255,255,0.95)";
      dctx.fillText("OpenGL", 12, 22);
      dctx.fillText("DirectX", dcanvas.width / 2 + 12, 22);
      dctx.restore();
    }
  };

  MT.preview = { drawImageData, drawResizeOverlay, NormalPreview };
})(typeof globalThis !== "undefined" ? globalThis : this);
