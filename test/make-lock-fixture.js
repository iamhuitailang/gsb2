// 辅助：从一张完整地图构造合法的锁定夹具（前两个房间锁定，跨边界连接断开）
const fs = require('fs');
const [, , basePath, outPath, n] = process.argv;
const m = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const count = parseInt(n || '2', 10);
const lockIds = new Set(m.rooms.slice(0, count).map((r) => r.id));

function ownerOf(portId) {
  return m.rooms.find((x) => x.ports.some((pp) => pp.id === portId)) || null;
}

const rooms = m.rooms
  .filter((r) => lockIds.has(r.id))
  .map((r) => ({
    ...r,
    locked: true,
    ports: r.ports.map((p) => ({
      ...p,
      connects: p.connects && lockIds.has(ownerOf(p.connects)?.id) ? p.connects : null,
    })),
  }));

const lockedPortIds = new Set(rooms.flatMap((r) => r.ports.map((p) => p.id)));
const edges = m.edges.filter((e) => lockedPortIds.has(e.a) && lockedPortIds.has(e.b));

fs.writeFileSync(outPath, JSON.stringify({ grid: m.grid, rooms, edges }, null, 2));
console.log('已写出锁定夹具', outPath, '锁定房间:', rooms.map((r) => r.id + '@' + r.x + ',' + r.y).join(' '));
