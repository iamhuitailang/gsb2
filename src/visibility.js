// Pure portal/room visibility search.
//
// The search starts from every room containing the camera (important on a
// threshold), then walks open doors. Each simple room path carries an NDC
// rectangle: the intersection of all doorway projections on that path. Cycles
// are handled by not repeating a room within one path; another physical route
// is still explored as a separate path. Rooms are deduplicated only for
// drawing, never used to prune an alternative route.

import { composeViewProjection, transformVec4, horizontalAngle } from './math.js';
import { DOOR_HEIGHT } from './scene.js';

export const FULL_RECT = Object.freeze({ x0: -1, x1: 1, y0: -1, y1: 1 });
const RECT_PADDING = 0.012;

export function intersectRect(a, b) {
  const x0 = Math.max(a.x0, b.x0);
  const x1 = Math.min(a.x1, b.x1);
  const y0 = Math.max(a.y0, b.y0);
  const y1 = Math.min(a.y1, b.y1);
  if (x1 < x0 || y1 < y0) return null;
  return { x0, x1, y0, y1 };
}

export function rectOverlaps(a, b) {
  return !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1);
}

function roundRect(r) {
  if (!r) return null;
  return {
    x0: +r.x0.toFixed(3), x1: +r.x1.toFixed(3),
    y0: +r.y0.toFixed(3), y1: +r.y1.toFixed(3),
  };
}

function portalWorldCorners(p) {
  const h = p.height || DOOR_HEIGHT + 0.05;
  return [
    [p.x1, 0.02, p.z1],
    [p.x2, 0.02, p.z2],
    [p.x2, h, p.z2],
    [p.x1, h, p.z1],
  ];
}

function clipPolygonNear(poly, nearPlaneZ) {
  const inside = (v) => v.z <= nearPlaneZ + 1e-6; // camera looks down -Z.
  const result = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);

    if (curIn && !prevIn) {
      const t = (nearPlaneZ - prev.z) / (cur.z - prev.z);
      result.push({
        x: prev.x + (cur.x - prev.x) * t,
        y: prev.y + (cur.y - prev.y) * t,
        z: nearPlaneZ,
      });
    }
    if (curIn) result.push(cur);
    else if (prevIn) {
      const t = (nearPlaneZ - prev.z) / (cur.z - prev.z);
      result.push({
        x: prev.x + (cur.x - prev.x) * t,
        y: prev.y + (cur.y - prev.y) * t,
        z: nearPlaneZ,
      });
    }
  }
  return result;
}

export function projectPortal(portal, camera, aspect, near = 0.05) {
  const ctx = composeViewProjection(camera, aspect, near, 80);
  const worldCorners = portalWorldCorners(portal);
  const cameraCorners = worldCorners.map((p) => transformVec4(ctx.view, p));
  const clipped = clipPolygonNear(cameraCorners, -near);

  if (clipped.length < 2) {
    return { visible: false, reason: 'behind', ctx, cameraCorners };
  }

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const cp of clipped) {
    const clip = transformVec4(ctx.proj, [cp.x, cp.y, cp.z, 1]);
    if (clip.w <= 0) continue;
    const nx = clip.x / clip.w;
    const ny = clip.y / clip.w;
    x0 = Math.min(x0, nx);
    x1 = Math.max(x1, nx);
    y0 = Math.min(y0, ny);
    y1 = Math.max(y1, ny);
  }

  if (!Number.isFinite(x0)) return { visible: false, reason: 'behind', ctx, cameraCorners };

  const rect = {
    x0: x0 - RECT_PADDING,
    x1: x1 + RECT_PADDING,
    y0: y0 - RECT_PADDING,
    y1: y1 + RECT_PADDING,
  };

  const dx1 = portal.x1 - camera.position[0];
  const dz1 = portal.z1 - camera.position[2];
  const dx2 = portal.x2 - camera.position[0];
  const dz2 = portal.z2 - camera.position[2];
  const angles = [
    horizontalAngle(camera, portal.x1, portal.z1),
    horizontalAngle(camera, portal.x2, portal.z2),
  ];

  return {
    visible: true,
    rect,
    rawRect: { x0, x1, y0, y1 },
    ctx,
    minEndpointDistance: Math.min(Math.hypot(dx1, dz1), Math.hypot(dx2, dz2)),
    nearestDepth: Math.min(...cameraCorners.map((p) => -p.z)),
    behindCornerCount: cameraCorners.filter((p) => p.z > -near).length,
    angle0: angles[0],
    angle1: angles[1],
    angleMin: Math.min(...angles),
    angleMax: Math.max(...angles),
    cameraCorners,
  };
}

function roomsAt(scene, x, z) {
  const eps = 0.045;
  return scene.rooms
    .filter((r) => x >= r.x0 - eps && x <= r.x1 + eps && z >= r.z0 - eps && z <= r.z1 + eps)
    .map((r) => r.id);
}

function otherRoom(portal, roomId) {
  return portal.a === roomId ? portal.b : portal.a;
}

export function computeVisibility(scene, camera, options = {}) {
  const aspect = options.aspect ?? 1.6;
  const near = options.near ?? 0.05;
  const doorOpen = options.doorOpen || {};
  const roots = roomsAt(scene, camera.position[0], camera.position[2]);
  if (roots.length === 0) {
    // Defensive fallback: never blank the scene because of a bad preset.
    roots.push(...scene.rooms.map((r) => r.id));
  }

  const visibleRoomIds = new Set(roots);
  const evaluations = [];
  const queue = roots.map((roomId) => ({
    roomId,
    clipRect: { ...FULL_RECT },
    path: [roomId],
    depth: 0,
  }));

  let evalSequence = 0;

  while (queue.length) {
    const state = queue.shift();
    const portals = scene.portals.filter((p) => p.a === state.roomId || p.b === state.roomId);

    for (const portal of portals) {
      evalSequence += 1;
      const toRoom = otherRoom(portal, state.roomId);
      const base = {
        seq: evalSequence,
        portalId: portal.id,
        portalShort: portal.short,
        fromRoom: state.roomId,
        toRoom,
        path: [...state.path],
        depth: state.depth + 1,
      };

      if (state.path.includes(toRoom)) {
        evaluations.push({
          ...base,
          status: 'cycle',
          title: '回路边已在当前路径中',
          message: '同一视线候选路径不重复进入房间以终止搜索；从另一条回路出发的路径仍会单独检查，摆件也仍只加入一次。',
        });
        continue;
      }

      const projection = projectPortal(portal, camera, aspect, near);
      const open = doorOpen[portal.id] !== false;

      if (!open) {
        evaluations.push({
          ...base,
          status: 'closed',
          title: '门已关闭',
          message: '门板挡住后续房间；门本身和当前房间仍绘制。',
          projection: projection.visible ? {
            rect: roundRect(projection.rect),
            minEndpointDistance: +projection.minEndpointDistance.toFixed(2),
          } : null,
        });
        continue;
      }

      if (!projection.visible) {
        evaluations.push({
          ...base,
          status: 'offscreen',
          title: '门在相机后方/近裁剪范围内',
          message: '两个门边都无法投影到近平面之前，因此该方向没有可继续的门洞。',
        });
        continue;
      }

      const onScreen = intersectRect(projection.rect, FULL_RECT);
      if (!onScreen) {
        evaluations.push({
          ...base,
          status: 'offscreen',
          title: '门在屏幕外',
          message: `门洞投影 NDC=${JSON.stringify(roundRect(projection.rect))}，与屏幕 [-1,1]² 不相交。`,
          projection: {
            rect: roundRect(projection.rect),
            angleMin: +projection.angleMin.toFixed(3),
            angleMax: +projection.angleMax.toFixed(3),
            minEndpointDistance: +projection.minEndpointDistance.toFixed(2),
            behindCornerCount: projection.behindCornerCount,
          },
        });
        continue;
      }

      const clipped = intersectRect(projection.rect, state.clipRect);
      if (!clipped) {
        const edgeHint = projection.minEndpointDistance < 0.8
          ? ' 相机离门边很近，本判定使用了近平面截断和外扩容差，仍确认它与上一门洞区域不相交。'
          : '';
        evaluations.push({
          ...base,
          status: 'occluded',
          title: state.depth === 0 ? '门洞区域不相交' : '被前一个门洞遮住',
          message: `该门仍可能在屏幕内，但投影区域与沿途门洞裁剪区 ${JSON.stringify(roundRect(state.clipRect))} 不相交。${edgeHint}`,
          projection: {
            rect: roundRect(projection.rect),
            parentRect: roundRect(state.clipRect),
            angleMin: +projection.angleMin.toFixed(3),
            angleMax: +projection.angleMax.toFixed(3),
            minEndpointDistance: +projection.minEndpointDistance.toFixed(2),
            behindCornerCount: projection.behindCornerCount,
          },
        });
        continue;
      }

      const nearEdge = projection.minEndpointDistance < 0.8 || projection.behindCornerCount > 0;
      evaluations.push({
        ...base,
        status: 'continue',
        title: nearEdge ? '继续查找（贴门边保守保留）' : '继续查找',
        message: nearEdge
          ? `门边最近距离 ${projection.minEndpointDistance.toFixed(2)}m，${projection.behindCornerCount} 个角点越过近平面；已按近平面截断并外扩，宁可多画也不丢掉突然出现的表面。`
          : `门洞投影与当前可见裁剪区相交，裁剪区更新为 ${JSON.stringify(roundRect(clipped))}。`,
        projection: {
          rect: roundRect(projection.rect),
          clipped: roundRect(clipped),
          minEndpointDistance: +projection.minEndpointDistance.toFixed(2),
          behindCornerCount: projection.behindCornerCount,
        },
      });

      visibleRoomIds.add(toRoom);
      queue.push({
        roomId: toRoom,
        clipRect: clipped,
        path: [...state.path, toRoom],
        depth: state.depth + 1,
      });
    }
  }

  return {
    cameraRoomIds: roots,
    visibleRoomIds: [...visibleRoomIds],
    evaluations,
    aspect,
  };
}

export function getDrawList(scene, mode, visibility) {
  if (mode === 'full' || !visibility) return scene.meshes;
  const visible = new Set(visibility.visibleRoomIds);
  return scene.meshes.filter((m) => m.roomIds.some((id) => visible.has(id)));
}

export function summarizeDrawList(meshes) {
  const props = new Set();
  let triangles = 0;
  for (const m of meshes) {
    if (m.propId) props.add(m.propId);
    triangles += 12; // every mesh is one unit cube draw with 36 indices
  }
  return { meshes: meshes.length, propCount: props.size, triangles, props };
}
