/*
 * Small dependency-free WebGL1 renderer. It uses world-space chunk meshes and
 * two line batches: ordinary seam heatmap and always-visible selection detail.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TerrainViewer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function identity() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  }

  function multiply(a, b) {
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

  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
  }

  function normalize(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function lookAt(eye, center, up) {
    const z = normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
    const x = normalize(cross(up, z));
    const y = cross(z, x);
    const m = identity();
    m[0] = x[0]; m[1] = y[0]; m[2] = z[0];
    m[4] = x[1]; m[5] = y[1]; m[6] = z[1];
    m[8] = x[2]; m[9] = y[2]; m[10] = z[2];
    m[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
    m[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
    m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
    return m;
  }

  function compileShader(gl, type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const msg = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile error: ' + msg);
    }
    return s;
  }

  function createProgram(gl, vsSource, fsSource) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vsSource));
    gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  const terrainVS = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    uniform mat4 uViewProj;
    uniform float uBias;
    varying vec3 vPos;
    varying vec3 vNormal;
    void main() {
      vec3 p = aPosition + aNormal * uBias;
      vPos = p;
      vNormal = aNormal;
      gl_Position = uViewProj * vec4(p, 1.0);
    }
  `;

  const terrainFS = `
    precision highp float;
    varying vec3 vPos;
    varying vec3 vNormal;
    uniform vec3 uCamera;
    uniform float uLodMode;
    uniform vec3 uLodColor;
    uniform float uLineMode;

    void main() {
      vec3 n = normalize(vNormal);
      float slope = 1.0 - clamp(n.y, 0.0, 1.0);
      float h = vPos.y;

      vec3 lowGrass = vec3(0.22, 0.43, 0.18);
      vec3 highGrass = vec3(0.43, 0.49, 0.22);
      vec3 dryEarth = vec3(0.55, 0.46, 0.30);
      vec3 rock = vec3(0.50, 0.47, 0.42);
      vec3 snow = vec3(0.91, 0.93, 0.91);

      vec3 color = mix(lowGrass, highGrass, smoothstep(-2.0, 15.0, h));
      color = mix(color, dryEarth, smoothstep(0.18, 0.42, slope) * 0.65);
      color = mix(color, rock, smoothstep(0.38, 0.68, slope));
      color = mix(color, snow, smoothstep(25.0, 34.0, h) * smoothstep(0.45, 0.78, n.y));

      // Fine elevation bands make terrace treads/risers readable.
      float band = abs(fract((h + 0.2) / 2.65) - 0.5);
      color *= 1.0 - 0.055 * smoothstep(0.455, 0.5, band);

      vec3 sunDir = normalize(vec3(-0.42, 0.82, 0.38));
      float diffuse = max(dot(n, sunDir), 0.0);
      float hemi = 0.50 + 0.34 * n.y;
      color *= hemi + 0.46 * diffuse;

      if (uLodMode > 0.5) {
        color = uLodColor * (0.66 + 0.34 * max(dot(n, sunDir), 0.0));
      }
      if (uLineMode > 0.5) {
        color *= 0.55;
      }

      float dist = length(uCamera - vPos);
      float fog = smoothstep(105.0, 245.0, dist);
      vec3 fogColor = vec3(0.70, 0.79, 0.88);
      color = mix(color, fogColor, fog);
      color = pow(clamp(color, 0.0, 1.0), vec3(0.9));
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  const lineVS = `
    attribute vec3 aPosition;
    attribute vec4 aColor;
    uniform mat4 uViewProj;
    varying vec4 vColor;
    void main() {
      vColor = aColor;
      gl_Position = uViewProj * vec4(aPosition, 1.0);
    }
  `;

  const lineFS = `
    precision mediump float;
    varying vec4 vColor;
    void main() { gl_FragColor = vColor; }
  `;

  class TerrainViewer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl', { antialias: true, alpha: false }) ||
        canvas.getContext('experimental-webgl', { antialias: true });
      if (!gl) throw new Error('当前浏览器/环境没有可用 WebGL');
      this.gl = gl;
      this.terrainProgram = createProgram(gl, terrainVS, terrainFS);
      this.lineProgram = createProgram(gl, lineVS, lineFS);

      this.loc = {
        terrainVP: gl.getUniformLocation(this.terrainProgram, 'uViewProj'),
        terrainCamera: gl.getUniformLocation(this.terrainProgram, 'uCamera'),
        terrainLodMode: gl.getUniformLocation(this.terrainProgram, 'uLodMode'),
        terrainLodColor: gl.getUniformLocation(this.terrainProgram, 'uLodColor'),
        terrainLineMode: gl.getUniformLocation(this.terrainProgram, 'uLineMode'),
        terrainBias: gl.getUniformLocation(this.terrainProgram, 'uBias'),
        pos: gl.getAttribLocation(this.terrainProgram, 'aPosition'),
        normal: gl.getAttribLocation(this.terrainProgram, 'aNormal'),
      };
      this.lineLoc = {
        vp: gl.getUniformLocation(this.lineProgram, 'uViewProj'),
        pos: gl.getAttribLocation(this.lineProgram, 'aPosition'),
        color: gl.getAttribLocation(this.lineProgram, 'aColor'),
      };

      this.gpuMeshes = new Map();
      this.debugBatch = null;
      this.viewProj = identity();
      this.view = identity();
      this.proj = identity();
      this.renderScale = 1;

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.clearColor(0.68, 0.78, 0.88, 1);
    }

    setRenderScale(scale) {
      this.renderScale = scale || 1;
      this.resize();
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr * this.renderScale));
      const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr * this.renderScale));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.gl.viewport(0, 0, w, h);
    }

    upsertMesh(mesh) {
      const gl = this.gl;
      this.removeMesh(mesh.id);
      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);

      const normalBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);

      const indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

      const lineBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.lineIndices, gl.STATIC_DRAW);

      this.gpuMeshes.set(mesh.id, {
        positionBuffer,
        normalBuffer,
        indexBuffer,
        lineBuffer,
        indexCount: mesh.indices.length,
        lineCount: mesh.lineIndices.length,
      });
    }

    removeMesh(id) {
      const old = this.gpuMeshes.get(id);
      if (!old) return;
      const gl = this.gl;
      gl.deleteBuffer(old.positionBuffer);
      gl.deleteBuffer(old.normalBuffer);
      gl.deleteBuffer(old.indexBuffer);
      gl.deleteBuffer(old.lineBuffer);
      this.gpuMeshes.delete(id);
    }

    clearMeshes() {
      for (const id of Array.from(this.gpuMeshes.keys())) this.removeMesh(id);
    }

    setDebugBatch(vertices) {
      // vertices: flat [x,y,z,r,g,b,a, ...], two vertices per line.
      const gl = this.gl;
      if (this.debugBatch) {
        gl.deleteBuffer(this.debugBatch.buffer);
        this.debugBatch = null;
      }
      if (!vertices || vertices.length < 14) return;
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
      this.debugBatch = { buffer, count: vertices.length / 7 };
    }

    render(camera, settings) {
      settings = settings || {};
      const gl = this.gl;
      this.resize();

      const eye = [camera.eye.x, camera.eye.y, camera.eye.z];
      const target = [camera.target.x, camera.target.y, camera.target.z];
      this.view = lookAt(eye, target, [0, 1, 0]);
      this.proj = perspective(Math.PI / 180 * 58, this.canvas.width / this.canvas.height, 0.1, 500);
      this.viewProj = multiply(this.proj, this.view);

      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.terrainProgram);
      gl.uniformMatrix4fv(this.loc.terrainVP, false, this.viewProj);
      gl.uniform3f(this.loc.terrainCamera, eye[0], eye[1], eye[2]);

      this.gpuMeshes.forEach((gpu, id) => {
        // Position + normal attributes are shared by triangle and line draws.
        gl.bindBuffer(gl.ARRAY_BUFFER, gpu.positionBuffer);
        gl.enableVertexAttribArray(this.loc.pos);
        gl.vertexAttribPointer(this.loc.pos, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, gpu.normalBuffer);
        gl.enableVertexAttribArray(this.loc.normal);
        gl.vertexAttribPointer(this.loc.normal, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.indexBuffer);
        gl.uniform1f(this.loc.terrainBias, 0);
        gl.uniform1f(this.loc.terrainLineMode, 0);
        gl.uniform1f(this.loc.terrainLodMode, settings.crack ? 1 : 0);
        const color = settings.lodColorById && settings.lodColorById.get(id);
        if (color) gl.uniform3f(this.loc.terrainLodColor, color[0], color[1], color[2]);
        else gl.uniform3f(this.loc.terrainLodColor, 0.3, 0.7, 0.3);
        gl.drawElements(gl.TRIANGLES, gpu.indexCount, gl.UNSIGNED_SHORT, 0);

        if (settings.crack || settings.wireframe) {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.lineBuffer);
          gl.uniform1f(this.loc.terrainBias, settings.crack ? 0.035 : 0.025);
          gl.uniform1f(this.loc.terrainLineMode, 1);
          if (settings.crack) {
            const c = settings.lodColorById && settings.lodColorById.get(id);
            if (c) gl.uniform3f(this.loc.terrainLodColor, Math.min(1, c[0] + 0.08), Math.min(1, c[1] + 0.08), Math.min(1, c[2] + 0.08));
          } else {
            gl.uniform1f(this.loc.terrainLodMode, 0);
          }
          gl.drawElements(gl.LINES, gpu.lineCount, gl.UNSIGNED_SHORT, 0);
        }
      });

      if (this.debugBatch) {
        gl.useProgram(this.lineProgram);
        gl.uniformMatrix4fv(this.lineLoc.vp, false, this.viewProj);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.debugBatch.buffer);
        gl.enableVertexAttribArray(this.lineLoc.pos);
        gl.vertexAttribPointer(this.lineLoc.pos, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(this.lineLoc.color);
        gl.vertexAttribPointer(this.lineLoc.color, 4, gl.FLOAT, false, 28, 12);
        gl.disable(gl.DEPTH_TEST);
        gl.drawArrays(gl.LINES, 0, this.debugBatch.count);
        gl.enable(gl.DEPTH_TEST);
      }
    }

    project(world) {
      const m = this.viewProj;
      const x = world.x, y = world.y, z = world.z;
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 0.001) return null;
      const nx = cx / cw;
      const ny = cy / cw;
      const cssW = this.canvas.clientWidth;
      const cssH = this.canvas.clientHeight;
      return {
        x: (nx * 0.5 + 0.5) * cssW,
        y: (-ny * 0.5 + 0.5) * cssH,
        visible: nx >= -1.1 && nx <= 1.1 && ny >= -1.1 && ny <= 1.1,
      };
    }
  }

  TerrainViewer.mat4 = { identity, multiply, perspective, lookAt };
  return TerrainViewer;
});
