// Static floor plan, portals, block geometry and collision rectangles.
// Coordinates are metres: x = east/west, z = south/north (negative z is north).

export const WALL_HEIGHT = 3;
export const WALL_THICKNESS = 0.24;
export const DOOR_HEIGHT = 2.18;

export const ROOMS = [
  { id: 'A', name: '中央客厅', x0: -5, x1: 5, z0: -4, z1: 4, floor: '#c9a878', tint: [0.78, 0.62, 0.42] },
  { id: 'B', name: '北侧连廊', x0: -4, x1: 4, z0: -12, z1: -4, floor: '#8fa3ad', tint: [0.52, 0.64, 0.70] },
  { id: 'C', name: '远景收藏室', x0: -3, x1: 3, z0: -19, z1: -12, floor: '#9b8fc7', tint: [0.58, 0.52, 0.78] },
  { id: 'D', name: '东厅长廊', x0: 5, x1: 12, z0: -4, z1: 11, floor: '#b98a78', tint: [0.72, 0.50, 0.43] },
  { id: 'E', name: '书房', x0: -4, x1: 5, z0: 4, z1: 11, floor: '#8fbf91', tint: [0.52, 0.70, 0.54] },
  { id: 'F', name: '回路休息室', x0: 4, x1: 12, z0: -12, z1: -4, floor: '#c2b06f', tint: [0.72, 0.64, 0.38] },
];

// Hinge is point 1. Endpoint order + swing controls how the open leaf rotates.
export const PORTALS = [
  { id: 'D_AB', short: 'AB', a: 'A', b: 'B', x1: -1, z1: -4, x2: 1, z2: -4, swing: 1 },
  { id: 'D_BC', short: 'BC', a: 'B', b: 'C', x1: -0.9, z1: -12, x2: 0.9, z2: -12, swing: 1 },
  { id: 'D_AD', short: 'AD', a: 'A', b: 'D', x1: 5, z1: -1, x2: 5, z2: 1, swing: 1 },
  { id: 'D_AE', short: 'AE', a: 'A', b: 'E', x1: -2.4, z1: 4, x2: -0.6, z2: 4, swing: -1 },
  { id: 'D_DE', short: 'DE', a: 'D', b: 'E', x1: 5, z1: 6.6, x2: 5, z2: 8.4, swing: 1 },
  { id: 'D_BF', short: 'BF', a: 'B', b: 'F', x1: 4, z1: -9, x2: 4, z2: -7, swing: 1 },
  { id: 'D_FD', short: 'FD', a: 'F', b: 'D', x1: 7.5, z1: -4, x2: 9.5, z2: -4, swing: 1 },
];

export const DEFAULT_DOOR_STATES = Object.fromEntries(PORTALS.map((p) => [p.id, true]));

let meshSequence = 1;

function addMesh(scene, mesh) {
  mesh.id = mesh.id || `mesh_${meshSequence++}`;
  mesh.roomIds = mesh.roomIds || [];
  scene.meshes.push(mesh);
  return mesh;
}

function addBlock(scene, options) {
  const {
    roomId,
    propId,
    position,
    scale,
    color = [0.7, 0.7, 0.7],
    rotationY = 0,
    kind = 'prop-block',
    solid = false,
  } = options;

  const mesh = addMesh(scene, {
    kind: propId ? 'prop-block' : kind,
    propId,
    roomId,
    roomIds: roomId ? [roomId] : [],
    position,
    scale,
    rotationY,
    color,
  });

  if (solid) {
    const [sx, sy, sz] = scale;
    const [x, y, z] = position;
    // Props used for collision are axis aligned in this demo.
    scene.colliders.push({
      minX: x - sx / 2, maxX: x + sx / 2,
      minZ: z - sz / 2, maxZ: z + sz / 2,
      meshId: mesh.id,
    });
  }
  return mesh;
}

function portalKey(p) {
  if (Math.abs(p.z1 - p.z2) < 1e-6) return `H@${p.z1}`;
  return `V@${p.x1}`;
}

function buildWalls(scene) {
  const lines = new Map();

  function interval(key, orientation, fixed, start, end, owner) {
    if (!lines.has(key)) lines.set(key, { key, orientation, fixed, intervals: [], portals: [] });
    const line = lines.get(key);
    line.intervals.push({ start: Math.min(start, end), end: Math.max(start, end), owner });
  }

  for (const r of ROOMS) {
    interval(`H@${r.z0}`, 'H', r.z0, r.x0, r.x1, r.id);
    interval(`H@${r.z1}`, 'H', r.z1, r.x0, r.x1, r.id);
    interval(`V@${r.x0}`, 'V', r.x0, r.z0, r.z1, r.id);
    interval(`V@${r.x1}`, 'V', r.x1, r.z0, r.z1, r.id);
  }

  for (const p of PORTALS) {
    const key = portalKey(p);
    if (!lines.has(key)) throw new Error(`Portal ${p.id} is not on a room wall`);
    lines.get(key).portals.push(p);
  }

  for (const line of lines.values()) {
    const coords = new Set();
    for (const i of line.intervals) {
      coords.add(+i.start.toFixed(4));
      coords.add(+i.end.toFixed(4));
    }
    for (const p of line.portals) {
      if (line.orientation === 'H') {
        coords.add(Math.min(p.x1, p.x2));
        coords.add(Math.max(p.x1, p.x2));
      } else {
        coords.add(Math.min(p.z1, p.z2));
        coords.add(Math.max(p.z1, p.z2));
      }
    }
    const sorted = [...coords].sort((a, b) => a - b);

    for (let idx = 0; idx < sorted.length - 1; idx++) {
      const a = sorted[idx];
      const b = sorted[idx + 1];
      if (b - a < 0.025) continue;
      const mid = (a + b) / 2;
      const owners = [...new Set(line.intervals
        .filter((i) => mid >= i.start - 1e-5 && mid <= i.end + 1e-5)
        .map((i) => i.owner))];
      if (owners.length === 0) continue;

      const inOpening = line.portals.some((p) => {
        const lo = line.orientation === 'H' ? Math.min(p.x1, p.x2) : Math.min(p.z1, p.z2);
        const hi = line.orientation === 'H' ? Math.max(p.x1, p.x2) : Math.max(p.z1, p.z2);
        return mid > lo + 1e-5 && mid < hi - 1e-5;
      });
      if (inOpening) continue;

      const len = b - a;
      if (line.orientation === 'H') {
        const position = [(a + b) / 2, WALL_HEIGHT / 2, line.fixed];
        const scale = [len, WALL_HEIGHT, WALL_THICKNESS];
        addMesh(scene, { kind: 'wall', roomIds: owners, position, scale, color: [0.82, 0.80, 0.74] });
        scene.wallSegments.push({ orientation: 'H', fixed: line.fixed, a, b, owners });
        scene.colliders.push({
          minX: position[0] - len / 2, maxX: position[0] + len / 2,
          minZ: line.fixed - WALL_THICKNESS / 2, maxZ: line.fixed + WALL_THICKNESS / 2,
        });
      } else {
        const position = [line.fixed, WALL_HEIGHT / 2, (a + b) / 2];
        const scale = [WALL_THICKNESS, WALL_HEIGHT, len];
        addMesh(scene, { kind: 'wall', roomIds: owners, position, scale, color: [0.82, 0.80, 0.74] });
        scene.wallSegments.push({ orientation: 'V', fixed: line.fixed, a, b, owners });
        scene.colliders.push({
          minX: line.fixed - WALL_THICKNESS / 2, maxX: line.fixed + WALL_THICKNESS / 2,
          minZ: position[2] - len / 2, maxZ: position[2] + len / 2,
        });
      }
    }
  }
}

function buildRoomShells(scene) {
  for (const r of ROOMS) {
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    addMesh(scene, {
      kind: 'floor', roomIds: [r.id],
      position: [cx, -0.05, cz], scale: [w, 0.1, d],
      color: r.tint.map((v) => v * 0.72),
    });
    addMesh(scene, {
      kind: 'ceiling', roomIds: [r.id],
      position: [cx, WALL_HEIGHT + 0.04, cz], scale: [w, 0.08, d],
      color: [0.91, 0.90, 0.86],
    });
  }
}

function buildDoors(scene) {
  for (const p of PORTALS) {
    const dx = p.x2 - p.x1;
    const dz = p.z2 - p.z1;
    const width = Math.hypot(dx, dz);
    p.width = width;
    p.key = portalKey(p);
    p.baseAngle = Math.atan2(-dz, dx);

    const horizontal = Math.abs(p.z1 - p.z2) < 1e-6;
    const mx = (p.x1 + p.x2) / 2;
    const mz = (p.z1 + p.z2) / 2;

    // Contrasting frame: two square jambs and a header.
    for (const [x, z] of [[p.x1, p.z1], [p.x2, p.z2]]) {
      addMesh(scene, {
        kind: 'frame', portalId: p.id, roomIds: [p.a, p.b],
        position: [x, DOOR_HEIGHT / 2, z], scale: [0.28, DOOR_HEIGHT, 0.28],
        color: [0.30, 0.20, 0.12],
      });
    }
    addMesh(scene, {
      kind: 'frame', portalId: p.id, roomIds: [p.a, p.b],
      position: [mx, DOOR_HEIGHT + 0.08, mz],
      scale: horizontal ? [width + 0.28, 0.16, 0.28] : [0.28, 0.16, width + 0.28],
      color: [0.36, 0.24, 0.14],
    });

    // Lintel/fixed wall over the opening.
    addMesh(scene, {
      kind: 'lintel', portalId: p.id, roomIds: [p.a, p.b],
      position: [mx, DOOR_HEIGHT + (WALL_HEIGHT - DOOR_HEIGHT) / 2, mz],
      scale: horizontal
        ? [width + 0.04, WALL_HEIGHT - DOOR_HEIGHT, WALL_THICKNESS]
        : [WALL_THICKNESS, WALL_HEIGHT - DOOR_HEIGHT, width + 0.04],
      color: [0.76, 0.74, 0.68],
    });

    const panel = addMesh(scene, {
      kind: 'door', portalId: p.id, roomIds: [p.a, p.b],
      position: [p.x1, 0, p.z1],
      offset: [width / 2, DOOR_HEIGHT / 2, 0],
      rotationY: p.baseAngle,
      baseAngle: p.baseAngle,
      openAngle: p.baseAngle + p.swing * 1.82,
      scale: [width, DOOR_HEIGHT, 0.075],
      color: [0.55, 0.31, 0.16],
    });
    scene.doorMeshes[p.id] = panel;

    const collider = {
      portalId: p.id,
      minX: horizontal ? Math.min(p.x1, p.x2) : p.x1 - 0.07,
      maxX: horizontal ? Math.max(p.x1, p.x2) : p.x1 + 0.07,
      minZ: horizontal ? p.z1 - 0.07 : Math.min(p.z1, p.z2),
      maxZ: horizontal ? p.z1 + 0.07 : Math.max(p.z1, p.z2),
    };
    scene.doorColliders.push(collider);
  }
}

function buildProps(scene) {
  const wood = [0.55, 0.34, 0.18];
  const darkWood = [0.34, 0.20, 0.11];
  const fabricBlue = [0.20, 0.42, 0.66];
  const fabricGreen = [0.25, 0.52, 0.35];
  const gold = [0.95, 0.72, 0.20];
  const white = [0.88, 0.88, 0.82];
  const leaf = [0.16, 0.46, 0.22];
  const pot = [0.55, 0.25, 0.16];
  const bookColors = [[0.75, 0.20, 0.18], [0.20, 0.38, 0.72], [0.86, 0.62, 0.16], [0.45, 0.25, 0.65]];

  // A: central living room.
  addBlock(scene, { roomId: 'A', propId: 'A-沙发', position: [-4.35, 0.25, 0], scale: [1.05, 0.5, 2.8], color: fabricBlue, solid: true });
  addBlock(scene, { roomId: 'A', propId: 'A-沙发', position: [-4.78, 0.72, 0], scale: [0.22, 0.95, 2.9], color: [0.16, 0.32, 0.52] });
  addBlock(scene, { roomId: 'A', propId: 'A-沙发', position: [-4.25, 0.55, -1.25], scale: [0.9, 0.55, 0.25], color: fabricBlue });
  addBlock(scene, { roomId: 'A', propId: 'A-沙发', position: [-4.25, 0.55, 1.25], scale: [0.9, 0.55, 0.25], color: fabricBlue });

  addBlock(scene, { roomId: 'A', propId: 'A-茶几', position: [-1.65, 0.24, 0.75], scale: [1.55, 0.16, 0.78], color: wood, solid: true });
  for (const dx of [-0.62, 0.62]) for (const dz of [-0.25, 0.25]) {
    addBlock(scene, { roomId: 'A', propId: 'A-茶几', position: [-1.65 + dx, 0.11, 0.75 + dz], scale: [0.12, 0.22, 0.12], color: darkWood });
  }
  addBlock(scene, { roomId: 'A', propId: 'A-地毯', position: [-1.6, 0.012, 0.75], scale: [2.5, 0.024, 1.8], color: [0.55, 0.18, 0.16] });

  addBlock(scene, { roomId: 'A', propId: 'A-电视柜', position: [2.65, 0.28, 3.62], scale: [2.35, 0.56, 0.46], color: darkWood, solid: true });
  addBlock(scene, { roomId: 'A', propId: 'A-电视', position: [2.65, 1.05, 3.82], scale: [1.75, 0.95, 0.08], color: [0.04, 0.05, 0.07] });
  addBlock(scene, { roomId: 'A', propId: 'A-书架', position: [-3.35, 1.05, -3.72], scale: [1.7, 2.1, 0.34], color: wood, solid: true });
  for (let i = 0; i < 10; i++) {
    addBlock(scene, {
      roomId: 'A', propId: 'A-书架',
      position: [-4.05 + (i % 5) * 0.34, 0.35 + Math.floor(i / 5) * 0.7, -3.51],
      scale: [0.16, 0.42, 0.16], color: bookColors[i % bookColors.length],
    });
  }

  // B: corridor.
  addBlock(scene, { roomId: 'B', propId: 'B-长廊地毯', position: [0, 0.014, -8], scale: [2.2, 0.028, 6.8], color: [0.30, 0.43, 0.55] });
  addBlock(scene, { roomId: 'B', propId: 'B-边桌', position: [-3.55, 0.42, -8.2], scale: [0.55, 0.84, 2.2], color: wood, solid: true });
  addBlock(scene, { roomId: 'B', propId: 'B-陶罐', position: [-3.55, 1.02, -8.75], scale: [0.34, 0.42, 0.34], color: [0.62, 0.30, 0.20] });
  addBlock(scene, { roomId: 'B', propId: 'B-绿植', position: [3.35, 0.32, -5.25], scale: [0.48, 0.64, 0.48], color: pot, solid: true });
  addBlock(scene, { roomId: 'B', propId: 'B-绿植', position: [3.35, 0.95, -5.25], scale: [0.85, 0.85, 0.85], color: leaf });
  addBlock(scene, { roomId: 'B', propId: 'B-雕塑台', position: [2.8, 0.45, -11.1], scale: [0.75, 0.9, 0.75], color: white, solid: true });
  addBlock(scene, { roomId: 'B', propId: 'B-雕塑', position: [2.8, 1.12, -11.1], scale: [0.42, 0.55, 0.42], color: [0.35, 0.75, 0.82] });

  // C: far room focal object visible through two portals.
  addBlock(scene, { roomId: 'C', propId: 'C-方尖碑', position: [0, 0.25, -16.45], scale: [1.25, 0.5, 1.25], color: [0.35, 0.28, 0.18], solid: true });
  addBlock(scene, { roomId: 'C', propId: 'C-方尖碑', position: [0, 1.45, -16.45], scale: [0.52, 2.0, 0.52], color: gold });
  addBlock(scene, { roomId: 'C', propId: 'C-方尖碑', position: [0, 2.62, -16.45], scale: [0.34, 0.34, 0.34], color: [1.0, 0.92, 0.45], rotationY: Math.PI / 4 });
  addBlock(scene, { roomId: 'C', propId: 'C-左柱', position: [-2.25, 1.35, -17.4], scale: [0.48, 2.7, 0.48], color: white, solid: true });
  addBlock(scene, { roomId: 'C', propId: 'C-右柱', position: [2.25, 1.35, -17.4], scale: [0.48, 2.7, 0.48], color: white, solid: true });
  addBlock(scene, { roomId: 'C', propId: 'C-远景地毯', position: [0, 0.014, -15.4], scale: [4.2, 0.028, 4.8], color: [0.36, 0.25, 0.55] });
  addBlock(scene, { roomId: 'C', propId: 'C-展柜', position: [-2.35, 0.5, -13.25], scale: [0.75, 1.0, 0.75], color: [0.25, 0.20, 0.16], solid: true });
  addBlock(scene, { roomId: 'C', propId: 'C-展品', position: [-2.35, 1.18, -13.25], scale: [0.35, 0.35, 0.35], color: [0.4, 0.9, 0.85] });

  // D: east gallery.
  addBlock(scene, { roomId: 'D', propId: 'D-长展桌', position: [8.7, 0.42, 3.2], scale: [1.65, 0.84, 3.7], color: wood, solid: true });
  addBlock(scene, { roomId: 'D', propId: 'D-桌上雕塑', position: [8.7, 1.12, 2.35], scale: [0.55, 0.55, 0.55], color: [0.85, 0.35, 0.25] });
  addBlock(scene, { roomId: 'D', propId: 'D-桌上雕塑', position: [8.7, 1.25, 3.65], scale: [0.42, 0.8, 0.42], color: [0.35, 0.65, 0.95] });
  addBlock(scene, { roomId: 'D', propId: 'D-东书架', position: [11.65, 1.1, 0.1], scale: [0.42, 2.2, 2.5], color: darkWood, solid: true });
  addBlock(scene, { roomId: 'D', propId: 'D-东书架', position: [11.65, 1.1, 8.8], scale: [0.42, 2.2, 2.5], color: darkWood, solid: true });
  addBlock(scene, { roomId: 'D', propId: 'D-长椅', position: [7.2, 0.25, 10.15], scale: [2.4, 0.5, 0.55], color: fabricGreen, solid: true });
  addBlock(scene, { roomId: 'D', propId: 'D-盆栽', position: [11.1, 0.35, -2.9], scale: [0.55, 0.7, 0.55], color: pot, solid: true });
  addBlock(scene, { roomId: 'D', propId: 'D-盆栽', position: [11.1, 1.05, -2.9], scale: [0.95, 0.9, 0.95], color: leaf });

  // E: study.
  addBlock(scene, { roomId: 'E', propId: 'E-书桌', position: [1.55, 0.4, 10.35], scale: [2.6, 0.16, 0.82], color: wood, solid: true });
  addBlock(scene, { roomId: 'E', propId: 'E-书桌', position: [0.45, 0.2, 10.35], scale: [0.16, 0.4, 0.65], color: darkWood });
  addBlock(scene, { roomId: 'E', propId: 'E-书桌', position: [2.65, 0.2, 10.35], scale: [0.16, 0.4, 0.65], color: darkWood });
  addBlock(scene, { roomId: 'E', propId: 'E-椅子', position: [1.55, 0.25, 9.45], scale: [0.62, 0.5, 0.62], color: fabricBlue, solid: true });
  addBlock(scene, { roomId: 'E', propId: 'E-椅子', position: [1.55, 0.68, 9.18], scale: [0.62, 0.85, 0.14], color: fabricBlue });
  addBlock(scene, { roomId: 'E', propId: 'E-书架', position: [-3.65, 1.1, 7.45], scale: [0.42, 2.2, 2.7], color: darkWood, solid: true });
  for (let i = 0; i < 12; i++) {
    addBlock(scene, {
      roomId: 'E', propId: 'E-书架',
      position: [-3.4, 0.35 + Math.floor(i / 6) * 0.75, 6.35 + (i % 6) * 0.42],
      scale: [0.16, 0.42, 0.20], color: bookColors[(i + 1) % bookColors.length],
    });
  }
  addBlock(scene, { roomId: 'E', propId: 'E-地毯', position: [0.7, 0.014, 7.4], scale: [3.2, 0.028, 2.4], color: [0.25, 0.42, 0.32] });

  // F: loop lounge.
  addBlock(scene, { roomId: 'F', propId: 'F-方桌', position: [9.1, 0.38, -8.9], scale: [1.55, 0.76, 1.55], color: wood, solid: true });
  addBlock(scene, { roomId: 'F', propId: 'F-椅1', position: [9.1, 0.25, -10.05], scale: [0.65, 0.5, 0.65], color: fabricGreen, solid: true });
  addBlock(scene, { roomId: 'F', propId: 'F-椅2', position: [9.1, 0.25, -7.75], scale: [0.65, 0.5, 0.65], color: fabricGreen, solid: true });
  addBlock(scene, { roomId: 'F', propId: 'F-椅3', position: [7.95, 0.25, -8.9], scale: [0.65, 0.5, 0.65], color: fabricGreen, solid: true });
  addBlock(scene, { roomId: 'F', propId: 'F-椅4', position: [10.25, 0.25, -8.9], scale: [0.65, 0.5, 0.65], color: fabricGreen, solid: true });
  addBlock(scene, { roomId: 'F', propId: 'F-地毯', position: [9.1, 0.014, -8.9], scale: [3.8, 0.028, 3.8], color: [0.55, 0.45, 0.20] });
  addBlock(scene, { roomId: 'F', propId: 'F-绿植', position: [11.25, 0.4, -11.15], scale: [0.58, 0.8, 0.58], color: pot, solid: true });
  addBlock(scene, { roomId: 'F', propId: 'F-绿植', position: [11.25, 1.18, -11.15], scale: [1.0, 0.95, 1.0], color: leaf });
}

export function buildScene() {
  meshSequence = 1;
  const scene = {
    rooms: ROOMS,
    portals: PORTALS,
    meshes: [],
    colliders: [],
    doorColliders: [],
    doorMeshes: {},
    wallSegments: [],
  };
  buildRoomShells(scene);
  buildWalls(scene);
  buildDoors(scene);
  buildProps(scene);

  const propIds = new Set();
  for (const m of scene.meshes) if (m.propId) propIds.add(m.propId);
  scene.propIds = [...propIds];
  return scene;
}

export function roomAt(scene, x, z, eps = 0.04) {
  return scene.rooms.filter((r) =>
    x >= r.x0 - eps && x <= r.x1 + eps && z >= r.z0 - eps && z <= r.z1 + eps);
}
