import { composeViewProjection, trs } from './math.js';
import { getDrawList, summarizeDrawList } from './visibility.js';

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uModel;
uniform mat4 uViewProj;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uViewProj * world;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vWorld;
uniform vec3 uColor;
uniform vec3 uEye;
uniform vec3 uFogColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(-0.38, 0.86, 0.42));
  float diffuse = max(dot(n, lightDir), 0.0);
  float fill = max(dot(n, normalize(vec3(0.55, 0.25, -0.65))), 0.0) * 0.16;
  float sky = 0.34 + 0.16 * max(n.y, 0.0);
  vec3 color = uColor * (sky + 0.62 * diffuse + fill);
  float dist = distance(vWorld, uEye);
  float fog = smoothstep(22.0, 52.0, dist);
  color = mix(color, uFogColor, fog * 0.72);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function createCubeBuffer(gl) {
  const positions = [];
  const normals = [];
  const indices = [];

  function face(normal, corners) {
    const base = positions.length / 3;
    for (const p of corners) {
      positions.push(...p);
      normals.push(...normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const a = -0.5, b = 0.5;
  face([0, 0, 1], [[a, a, b], [b, a, b], [b, b, b], [a, b, b]]);
  face([0, 0, -1], [[b, a, a], [a, a, a], [a, b, a], [b, b, a]]);
  face([1, 0, 0], [[b, a, b], [b, a, a], [b, b, a], [b, b, b]]);
  face([-1, 0, 0], [[a, a, a], [a, a, b], [a, b, b], [a, b, a]]);
  face([0, 1, 0], [[a, b, b], [b, b, b], [b, b, a], [a, b, a]]);
  face([0, -1, 0], [[a, a, a], [b, a, a], [b, a, b], [a, a, b]]);

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

  const normalBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);

  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

  return { positionBuffer, normalBuffer, indexBuffer, count: indices.length };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', {
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL');
    this.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(this.program));
    }
    gl.useProgram(this.program);

    this.loc = {
      position: gl.getAttribLocation(this.program, 'aPosition'),
      normal: gl.getAttribLocation(this.program, 'aNormal'),
      model: gl.getUniformLocation(this.program, 'uModel'),
      viewProj: gl.getUniformLocation(this.program, 'uViewProj'),
      color: gl.getUniformLocation(this.program, 'uColor'),
      eye: gl.getUniformLocation(this.program, 'uEye'),
      fogColor: gl.getUniformLocation(this.program, 'uFogColor'),
    };
    this.cube = createCubeBuffer(gl);
    gl.enableVertexAttribArray(this.loc.position);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cube.positionBuffer);
    gl.vertexAttribPointer(this.loc.position, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(this.loc.normal);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cube.normalBuffer);
    gl.vertexAttribPointer(this.loc.normal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.cube.indexBuffer);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
    this.aspect = width / height;
    return this.aspect;
  }

  render(scene, camera, mode, visibility, doorOpen) {
    const gl = this.gl;
    const aspect = this.resize();
    const { viewProj } = composeViewProjection(camera, aspect, 0.05, 80);

    gl.clearColor(0.76, 0.84, 0.90, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.loc.viewProj, false, viewProj);
    gl.uniform3f(this.loc.eye, camera.position[0], camera.position[1], camera.position[2]);
    gl.uniform3f(this.loc.fogColor, 0.76, 0.84, 0.90);

    const drawList = getDrawList(scene, mode, visibility);
    let drawCalls = 0;
    const propIds = new Set();

    for (const mesh of drawList) {
      let rotationY = mesh.rotationY || 0;
      if (mesh.kind === 'door') {
        rotationY = doorOpen?.[mesh.portalId] === false ? mesh.baseAngle : mesh.openAngle;
      }
      const model = trs({ ...mesh, rotationY });
      gl.uniformMatrix4fv(this.loc.model, false, model);
      const c = mesh.color || [0.7, 0.7, 0.7];
      gl.uniform3f(this.loc.color, c[0], c[1], c[2]);
      gl.drawElements(gl.TRIANGLES, this.cube.count, gl.UNSIGNED_SHORT, 0);
      drawCalls++;
      if (mesh.propId) propIds.add(mesh.propId);
    }

    const summary = summarizeDrawList(drawList);
    return { ...summary, drawCalls, aspect, width: this.canvas.width, height: this.canvas.height };
  }

  readFrame() {
    const gl = this.gl;
    const pixels = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }
}
