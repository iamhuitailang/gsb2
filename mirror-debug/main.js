import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// ---------- 基础 ----------
const container = document.getElementById('app');
const statusEl = document.getElementById('status');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
scene.fog = new THREE.Fog(0x14171c, 30, 80);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 2.2, 7.5);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1.2, 0);
orbit.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x3a3226, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(6, 10, 4);
scene.add(sun);

// ---------- 地面：网格 + 距离环 ----------
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x1d222b, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.002;
scene.add(ground);

const grid = new THREE.GridHelper(60, 60, 0x3a4354, 0x272e3a);
scene.add(grid);

for (const r of [2, 4, 6]) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(r - 0.02, r + 0.02, 96),
    new THREE.MeshBasicMaterial({ color: 0x4a5568, side: THREE.DoubleSide, transparent: true, opacity: 0.7 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.001;
  scene.add(ring);
}
scene.add(new THREE.AxesHelper(1.5));

// ---------- 地面标记（验证左右 / 远近 / 位置） ----------
const markerGroup = new THREE.Group();
scene.add(markerGroup);

function makeLabel(text, bg) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#fff';
  g.font = 'bold 72px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 68);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
  s.scale.set(1.5, 0.75, 1);
  return s;
}

function makeMarker(text, color, x, z) {
  const grp = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 1.4, 12),
    new THREE.MeshStandardMaterial({ color })
  );
  pole.position.y = 0.7;
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 12),
    new THREE.MeshStandardMaterial({ color })
  );
  ball.position.y = 1.45;
  const label = makeLabel(text, '#' + color.toString(16).padStart(6, '0'));
  label.position.y = 1.95;
  grp.add(pole, ball, label);
  grp.position.set(x, 0, z);
  markerGroup.add(grp);
}

makeMarker('A', 0xd84545, -2.5, 2.5);   // 近左
makeMarker('B', 0x3fae5a, 2.5, 2.5);    // 近右
makeMarker('C', 0x3f7fd8, -2.5, 5.5);   // 远左
makeMarker('D', 0xd8b13f, 2.5, 5.5);    // 远右

// ---------- 镜子 ----------
const mirrorVert = /* glsl */`
  uniform mat4 textureMatrix;
  varying vec4 vUvProj;
  varying vec2 vPlaneUv;
  void main() {
    vPlaneUv = uv;
    vUvProj = textureMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const mirrorFrag = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform float facing; // 1=相机在镜面正面, 0=在背面
  varying vec4 vUvProj;
  varying vec2 vPlaneUv;
  void main() {
    if (facing < 0.5) {
      // 背板规则：灰色网格，不采样反射
      vec2 g = abs(fract(vPlaneUv * 8.0) - 0.5);
      float line = step(0.46, max(g.x, g.y));
      vec3 back = mix(vec3(0.12, 0.13, 0.15), vec3(0.30, 0.33, 0.38), line);
      gl_FragColor = vec4(back, 1.0);
      return;
    }
    vec4 c = texture2DProj(tDiffuse, vUvProj);
    gl_FragColor = vec4(c.rgb * 0.94, 1.0);
  }
`;

const mirrors = [];

function createMirror(name, w = 3, h = 2) {
  const group = new THREE.Group();
  group.userData.selectable = true;
  group.userData.kind = 'mirror';
  group.userData.name = name;

  const rtMain = new THREE.WebGLRenderTarget(1024, 1024);
  const rtBounce = new THREE.WebGLRenderTarget(512, 512); // 第二级反射用低分辨率
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: rtMain.texture },
      facing: { value: 1 },
      textureMatrix: { value: new THREE.Matrix4() },
    },
    vertexShader: mirrorVert,
    fragmentShader: mirrorFrag,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(w + 0.16, h + 0.16),
    new THREE.MeshBasicMaterial({ color: 0x232a35, side: THREE.DoubleSide })
  );
  frame.position.z = -0.012;
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h)),
    new THREE.LineBasicMaterial({ color: 0xffcc00 })
  );
  edges.position.z = 0.002;
  group.add(frame, mesh, edges);

  group.userData.mesh = mesh;
  group.userData.edges = edges;
  group.userData.material = material;
  group.userData.rtMain = rtMain;
  group.userData.rtBounce = rtBounce;
  group.userData.vcam = new THREE.PerspectiveCamera();
  group.userData.vcamBounce = new THREE.PerspectiveCamera();
  group.userData.helper = null; // 裁切视锥 helper，按需创建

  scene.add(group);
  mirrors.push(group);
  return group;
}

const mirror1 = createMirror('镜子1');
const mirror2 = createMirror('镜子2');

// ---------- 道具 ----------
const props = [];

function createProp(name, mesh, x, z, y) {
  mesh.position.set(x, y, z);
  mesh.userData.selectable = true;
  mesh.userData.kind = 'prop';
  mesh.userData.name = name;
  scene.add(mesh);
  props.push(mesh);
  return mesh;
}

createProp('红箱子', new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0xc0524a })), -1.6, 3.2, 0.5);
createProp('绿球', new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 16),
  new THREE.MeshStandardMaterial({ color: 0x4aa86b })), 1.4, 2.6, 0.55);
createProp('蓝锥', new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.3, 24),
  new THREE.MeshStandardMaterial({ color: 0x4a6fc0 })), 0.2, 4.4, 0.65);
createProp('黄柱', new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.6, 20),
  new THREE.MeshStandardMaterial({ color: 0xc0a24a })), 3.2, 4.0, 0.8);

// ---------- 反射核心：虚拟相机 + 斜投影裁剪 ----------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _look = new THREE.Vector3(), _target = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _normal = new THREE.Vector3();
const _plane = new THREE.Plane();
const _clip = new THREE.Vector4();
const _q = new THREE.Vector4();
const CLIP_BIAS = 0.003;

// 返回 true 表示 sourceCamera 在镜面正面
function updateVirtualCamera(mirror, sourceCamera, vcam) {
  const mesh = mirror.userData.mesh;
  const mirrorPos = _v1.setFromMatrixPosition(mesh.matrixWorld);
  const camPos = _v2.setFromMatrixPosition(sourceCamera.matrixWorld);

  _rot.extractRotation(mesh.matrixWorld);
  _normal.set(0, 0, 1).applyMatrix4(_rot);

  const view = _v3.subVectors(mirrorPos, camPos);
  if (view.dot(_normal) > 0) return false; // 相机在镜背

  // 反射相机位置与朝向
  view.reflect(_normal).negate().add(mirrorPos);
  _rot.extractRotation(sourceCamera.matrixWorld);
  _look.set(0, 0, -1).applyMatrix4(_rot).add(camPos);
  _target.subVectors(mirrorPos, _look).reflect(_normal).negate().add(mirrorPos);

  vcam.position.copy(view);
  vcam.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_normal);
  vcam.lookAt(_target);
  vcam.near = sourceCamera.near;
  vcam.far = sourceCamera.far;
  vcam.updateMatrixWorld();
  vcam.projectionMatrix.copy(sourceCamera.projectionMatrix);

  // 投影纹理矩阵
  const tm = mirror.userData.material.uniforms.textureMatrix.value;
  tm.set(
    0.5, 0, 0, 0.5,
    0, 0.5, 0, 0.5,
    0, 0, 0.5, 0.5,
    0, 0, 0, 1
  );
  tm.multiply(vcam.projectionMatrix);
  tm.multiply(vcam.matrixWorldInverse);
  tm.multiply(mesh.matrixWorld);

  // 斜投影近裁剪面 = 镜面：镜后物体不会进入反射
  _plane.setFromNormalAndCoplanarPoint(_normal, mirrorPos);
  _plane.applyMatrix4(vcam.matrixWorldInverse);
  _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
  const pm = vcam.projectionMatrix;
  _q.x = (Math.sign(_clip.x) + pm.elements[8]) / pm.elements[0];
  _q.y = (Math.sign(_clip.y) + pm.elements[9]) / pm.elements[5];
  _q.z = -1.0;
  _q.w = (1.0 + pm.elements[10]) / pm.elements[14];
  _clip.multiplyScalar(2.0 / _clip.dot(_q));
  pm.elements[2] = _clip.x;
  pm.elements[6] = _clip.y;
  pm.elements[10] = _clip.z + 1.0 - CLIP_BIAS;
  pm.elements[14] = _clip.w;
  return true;
}

// 把某面镜的反射渲染到指定 RT。budget>1 时先把其它镜子的「镜中镜」纹理算好。
// 递归深度由调用处固定限制（最深 2 级），每帧每面镜每级只渲染一次，不会无限刷新。
function renderReflection(mirror, sourceCamera, rt, budget) {
  const ud = mirror.userData;
  const vcam = budget > 1 ? ud.vcam : ud.vcamBounce;
  const facing = updateVirtualCamera(mirror, sourceCamera, vcam);
  ud.material.uniforms.facing.value = facing ? 1 : 0;
  if (!facing) return; // 背面：不渲染反射，shader 画背板

  if (budget > 1) {
    for (const other of mirrors) {
      if (other === mirror) continue;
      renderReflection(other, vcam, other.userData.rtBounce, 1);
      other.userData.material.uniforms.tDiffuse.value = other.userData.rtBounce.texture;
    }
  }

  const helperWasVisible = [];
  for (const m of mirrors) {
    if (m.userData.helper) { helperWasVisible.push([m, m.userData.helper.visible]); m.userData.helper.visible = false; }
  }
  const tWasVisible = tControls.visible;
  tControls.visible = false;
  ud.mesh.visible = false; // 自己不反射自己

  const prevRT = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, vcam);
  renderer.setRenderTarget(prevRT);

  ud.mesh.visible = true;
  tControls.visible = tWasVisible;
  for (const [m, v] of helperWasVisible) m.userData.helper.visible = v;

  if (budget > 1) {
    for (const other of mirrors) {
      other.userData.material.uniforms.tDiffuse.value = other.userData.rtMain.texture;
    }
  }
}

// ---------- 选中与拖拽 ----------
const tControls = new TransformControls(camera, renderer.domElement);
tControls.addEventListener('dragging-changed', e => { orbit.enabled = !e.value; });
scene.add(tControls);

let selected = null;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downPos = null;

function selectableRoot(obj) {
  while (obj) {
    if (obj.userData.selectable) return obj;
    obj = obj.parent;
  }
  return null;
}

function select(obj) {
  selected = obj;
  if (obj) {
    tControls.attach(obj);
    for (const m of mirrors) m.userData.edges.material.color.set(m === obj ? 0x4a80e0 : 0xffcc00);
  } else {
    tControls.detach();
    for (const m of mirrors) m.userData.edges.material.color.set(0xffcc00);
  }
}

renderer.domElement.addEventListener('pointerdown', e => { downPos = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downPos || tControls.dragging) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 4) return;
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([...mirrors, ...props], true);
  select(hits.length ? selectableRoot(hits[0].object) : null);
});

// ---------- 反射视图预览（右下角小窗，显示反射相机原始画面） ----------
const previewScene = new THREE.Scene();
const previewCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const previewQuad = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.MeshBasicMaterial({ map: mirror1.userData.rtMain.texture })
);
previewQuad.scale.y = -1; // RT 纹理不翻转，翻回来
previewScene.add(previewQuad);
let previewOn = false;

// ---------- UI ----------
let bounceDepth = 1;
let frustumOn = false;

const $ = id => document.getElementById(id);
const camPresets = {
  front: [[0, 2.2, 7.5], [0, 1.2, 0]],
  side:  [[7.5, 2.5, 2], [0, 1.2, 0]],
  top:   [[0, 8.5, 4.5], [0, 0.5, -1]],
  back:  [[0, 2.0, -6.5], [0, 1.2, 0]],
};
document.querySelectorAll('#camRow button').forEach(btn => {
  btn.addEventListener('click', () => {
    const [pos, tgt] = camPresets[btn.dataset.cam];
    camera.position.set(...pos);
    orbit.target.set(...tgt);
  });
});

$('btnTranslate').addEventListener('click', () => {
  tControls.setMode('translate');
  $('btnTranslate').classList.add('on'); $('btnRotate').classList.remove('on');
});
$('btnRotate').addEventListener('click', () => {
  tControls.setMode('rotate');
  $('btnRotate').classList.add('on'); $('btnTranslate').classList.remove('on');
});
$('btnDeselect').addEventListener('click', () => select(null));

$('btnDepth1').addEventListener('click', () => {
  bounceDepth = 1;
  $('btnDepth1').classList.add('on'); $('btnDepth2').classList.remove('on');
});
$('btnDepth2').addEventListener('click', () => {
  bounceDepth = 2;
  $('btnDepth2').classList.add('on'); $('btnDepth1').classList.remove('on');
});

$('btnPreview').addEventListener('click', () => {
  previewOn = !previewOn;
  $('btnPreview').classList.toggle('on', previewOn);
});
$('btnFrustum').addEventListener('click', () => {
  frustumOn = !frustumOn;
  $('btnFrustum').classList.toggle('on', frustumOn);
  for (const m of mirrors) {
    if (frustumOn && !m.userData.helper) {
      m.userData.helper = new THREE.CameraHelper(m.userData.vcam);
      scene.add(m.userData.helper);
    }
    if (m.userData.helper) m.userData.helper.visible = frustumOn;
  }
});
$('btnMarkers').addEventListener('click', () => {
  markerGroup.visible = !markerGroup.visible;
  $('btnMarkers').classList.toggle('on', markerGroup.visible);
});

// ---------- 预设 ----------
function applySetup(data) {
  data.mirrors.forEach((s, i) => {
    const m = mirrors[i];
    if (!m) return;
    m.position.fromArray(s.position);
    m.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
  });
  if (data.props) data.props.forEach((s, i) => {
    const p = props[i];
    if (!p) return;
    p.position.fromArray(s.position);
    p.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
  });
}

function serialize() {
  return JSON.stringify({
    mirrors: mirrors.map(m => ({
      name: m.userData.name,
      position: m.position.toArray(),
      rotation: [m.rotation.x, m.rotation.y, m.rotation.z],
    })),
    props: props.map(p => ({
      name: p.userData.name,
      position: p.position.toArray(),
      rotation: [p.rotation.x, p.rotation.y, p.rotation.z],
    })),
  }, null, 2);
}

const PRESETS = {
  front: {
    mirrors: [
      { name: '镜子1', position: [0, 1.5, 0], rotation: [0, 0, 0] },
      { name: '镜子2', position: [5, 1.5, -3], rotation: [0, -Math.PI / 2, 0] },
    ],
    props: [
      { name: '红箱子', position: [-1.6, 0.5, 3.2], rotation: [0, 0, 0] },
      { name: '绿球', position: [1.4, 0.5, 2.6], rotation: [0, 0, 0] },
      { name: '蓝锥', position: [0.2, 0.65, 4.4], rotation: [0, 0, 0] },
      { name: '黄柱', position: [3.2, 0.8, 4.0], rotation: [0, 0, 0] },
    ],
  },
  tilt: {
    mirrors: [
      { name: '镜子1', position: [0, 1.5, 0], rotation: [0, Math.PI / 4, 0] },
      { name: '镜子2', position: [-4, 1.5, 4], rotation: [0, -Math.PI / 4 * 3, 0] },
    ],
    props: [
      { name: '红箱子', position: [-1.5, 0.5, 1.5], rotation: [0, 0.4, 0] },
      { name: '绿球', position: [1.5, 0.5, 1.0], rotation: [0, 0, 0] },
      { name: '蓝锥', position: [-2.5, 0.65, 3.5], rotation: [0, 0, 0] },
      { name: '黄柱', position: [0.5, 0.8, 3.8], rotation: [0, 0, 0] },
    ],
  },
};

$('btnPresetFront').addEventListener('click', () => applySetup(PRESETS.front));
$('btnPresetTilt').addEventListener('click', () => applySetup(PRESETS.tilt));

// ---------- 存档 ----------
const SAVE_KEY = 'mirror-debug.save';
$('btnSave').addEventListener('click', () => {
  localStorage.setItem(SAVE_KEY, serialize());
  flash('已保存到 localStorage');
});
$('btnLoad').addEventListener('click', () => {
  const s = localStorage.getItem(SAVE_KEY);
  if (!s) return flash('没有存档');
  try { applySetup(JSON.parse(s)); flash('已载入'); }
  catch (e) { flash('存档损坏：' + e.message); }
});
$('btnExport').addEventListener('click', () => { $('io').value = serialize(); });
$('btnImport').addEventListener('click', () => {
  try { applySetup(JSON.parse($('io').value)); flash('导入成功'); }
  catch (e) { flash('导入失败：' + e.message); }
});

let flashMsg = '', flashUntil = 0;
function flash(msg) { flashMsg = msg; flashUntil = performance.now() + 2500; }

// ---------- 主循环 ----------
function facingText(mirror) {
  const mesh = mirror.userData.mesh;
  const mirrorPos = _v1.setFromMatrixPosition(mesh.matrixWorld);
  _rot.extractRotation(mesh.matrixWorld);
  _normal.set(0, 0, 1).applyMatrix4(_rot);
  const d = _v2.setFromMatrixPosition(camera.matrixWorld).sub(mirrorPos).dot(_normal);
  return d > 0 ? '正' : '背';
}

function animate() {
  requestAnimationFrame(animate);
  orbit.update();

  // 每帧：每面镜渲染一次主反射（层级 2 时内部先算镜中镜）
  for (const m of mirrors) renderReflection(m, camera, m.userData.rtMain, bounceDepth);
  // 反射 pass 会改写 textureMatrix / facing（最后一级是别的镜子的虚拟相机），
  // 这里按主相机重算，保证主画面采样正确、正/背面状态正确
  for (const m of mirrors) {
    const ok = updateVirtualCamera(m, camera, m.userData.vcam);
    m.userData.material.uniforms.facing.value = ok ? 1 : 0;
    if (frustumOn && m.userData.helper) m.userData.helper.update();
  }

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  renderer.render(scene, camera);

  // 反射视图小窗：显示选中镜（或镜子1）的反射相机画面
  if (previewOn) {
    const m = (selected && selected.userData.kind === 'mirror') ? selected : mirror1;
    previewQuad.material.map = m.userData.rtMain.texture;
    const W = 360, H = 240;
    renderer.setScissorTest(true);
    renderer.setScissor(window.innerWidth - W - 12, 12, W, H);
    renderer.setViewport(window.innerWidth - W - 12, 12, W, H);
    renderer.render(previewScene, previewCam);
    renderer.setScissorTest(false);
  }

  const sel = selected ? selected.userData.name : '无';
  const msg = performance.now() < flashUntil ? ' | ' + flashMsg : '';
  statusEl.textContent =
    `选中: ${sel} | 层级: ${bounceDepth} | ` +
    mirrors.map(m => `${m.userData.name}:${facingText(m)}`).join(' ') + msg;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

applySetup(PRESETS.front);
animate();
