// 贴花投影核心：把目标网格的三角形裁进投影盒，生成贴花网格。
// 同时能产出两类检查几何体：
//   - 放大投影盒得到的“潜在覆盖面”（与实际覆盖之差即被裁掉区域）
//   - 因背面 / 倾角过斜被拒绝的三角形
import * as THREE from 'three';

// 贴花配置 -> 投影器四元数（不含位置）。投影方向为局部 -Z（与相机一致）。
// 注意：纹样旋转（roll）只作用于 UV，不改变投影盒朝向，
// 这样 gizmo 拖出的四元数可以原样写回配置。
export function projectorQuaternion(cfg) {
  return new THREE.Quaternion().fromArray(cfg.projQuat);
}

// 投影器矩阵：局部空间 -> 世界空间。投影盒为 ±w/2, ±h/2, z ∈ [-depth, 0]（从投影器向前延伸）。
export function projectorMatrix(cfg) {
  const m = new THREE.Matrix4();
  m.compose(
    new THREE.Vector3().fromArray(cfg.projPos),
    projectorQuaternion(cfg),
    new THREE.Vector3(1, 1, 1));
  return m;
}

export function projectorDirection(cfg) {
  return new THREE.Vector3(0, 0, -1).applyQuaternion(projectorQuaternion(cfg));
}

// 用有符号距离函数裁凸多边形（Sutherland–Hodgman），保留 dist >= 0 一侧。
function clipPoly(poly, distFn) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = distFn(a.p), db = distFn(b.p);
    const ain = da >= 0, bin = db >= 0;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = da / (da - db);
      out.push({
        p: a.p.clone().lerp(b.p, t),
        uv: a.uv.clone().lerp(b.uv, t),
      });
    }
  }
  return out;
}

/**
 * 计算贴花几何。
 * @param mesh   目标网格（需已 updateWorldMatrix）
 * @param cfg    贴花配置 {projPos, projQuat, roll, width, height, depth, maxAngle}
 * @param inflate 投影盒放大倍数（1 = 实际覆盖；>1 用于“被裁区域”检查视图）
 * @returns {positions, normals, uvs, rejected} 世界空间三角形汤（普通数组）
 */
export function computeDecalGeometry(mesh, cfg, inflate = 1) {
  const mat = projectorMatrix(cfg);
  const inv = mat.clone().invert();
  const dir = projectorDirection(cfg);            // 投影方向（世界）
  const toward = dir.clone().negate();            // 指向投影器
  const cosLimit = Math.cos(THREE.MathUtils.degToRad(cfg.maxAngle));

  const hw = (cfg.width / 2) * inflate;
  const hh = (cfg.height / 2) * inflate;
  const dep = cfg.depth * inflate;
  // 纹样旋转：绕 UV 中心 (0.5, 0.5) 旋转，在裁切完成后套用
  const rollRad = THREE.MathUtils.degToRad(cfg.roll || 0);
  const rc = Math.cos(rollRad), rs = Math.sin(rollRad);
  const rotUV = (uv) => {
    const u = uv.x - 0.5, v = uv.y - 0.5;
    uv.x = 0.5 + u * rc - v * rs;
    uv.y = 0.5 + u * rs + v * rc;
    return uv;
  };

  const positions = [], normals = [], uvs = [], rejected = [];

  let geo = mesh.geometry;
  if (geo.index) geo = geo.toNonIndexed();
  const pos = geo.attributes.position;
  mesh.updateWorldMatrix(true, false);
  const mw = mesh.matrixWorld;

  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const centroid = new THREE.Vector3();

  const inInflatedBox = (p) => {
    const l = p.clone().applyMatrix4(inv);
    return Math.abs(l.x) <= (cfg.width / 2) * 3 &&
           Math.abs(l.y) <= (cfg.height / 2) * 3 &&
           l.z <= 0 && l.z >= -cfg.depth * 3;
  };

  for (let i = 0; i < pos.count; i += 3) {
    for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, i + k).applyMatrix4(mw);

    e1.subVectors(v[1], v[0]);
    e2.subVectors(v[2], v[0]);
    n.crossVectors(e1, e2);
    const len = n.length();
    if (len < 1e-10) continue;
    n.divideScalar(len);

    // 背面与过斜面剔除：法线必须朝向投影器且在最大倾角内
    if (n.dot(toward) <= cosLimit) {
      if (inflate === 1) {
        centroid.addVectors(v[0], v[1]).add(v[2]).divideScalar(3);
        if (inInflatedBox(centroid)) {
          for (let k = 0; k < 3; k++) rejected.push(v[k].x, v[k].y, v[k].z);
        }
      }
      continue;
    }

    // 转到投影器局部空间并带上 UV
    let poly = v.map((p) => {
      const l = p.clone().applyMatrix4(inv);
      return {
        p: l,
        uv: new THREE.Vector2(l.x / cfg.width + 0.5, l.y / cfg.height + 0.5),
      };
    });

    // 裁到投影盒：x/y 两个半空间 + z ∈ [-depth, 0]（投影器近端为起点）
    poly = clipPoly(poly, (p) => p.x + hw);
    if (poly.length) poly = clipPoly(poly, (p) => hw - p.x);
    if (poly.length) poly = clipPoly(poly, (p) => p.y + hh);
    if (poly.length) poly = clipPoly(poly, (p) => hh - p.y);
    if (poly.length) poly = clipPoly(poly, (p) => p.z + dep);
    if (poly.length) poly = clipPoly(poly, (p) => -p.z);
    if (poly.length < 3) continue;

    // 扇形三角化，顶点转回世界空间，UV 套纹样旋转
    for (let k = 1; k + 1 < poly.length; k++) {
      for (const vtx of [poly[0], poly[k], poly[k + 1]]) {
        const w = vtx.p.clone().applyMatrix4(mat);
        const uv = rotUV(vtx.uv.clone());
        positions.push(w.x, w.y, w.z);
        normals.push(n.x, n.y, n.z);
        uvs.push(uv.x, uv.y);
      }
    }
  }

  return { positions, normals, uvs, rejected };
}
