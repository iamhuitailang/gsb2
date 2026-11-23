#!/usr/bin/env python3
"""生成朝向检查工具的测试模型:

  block_outward.obj  闭合块, 整体朝外 (无需修复)
  block_inward.obj   闭合块, 整体朝里 (应被翻成朝外)
  open_sheet.obj     薄开口片, 部分面绕向混乱 (需用户选参考面)
  illegal_mesh.obj   非法连接网格: 三面共边 + 零面积面 + 重合未连接顶点,
                     外加一个朝里的闭合小块 (可判定块应能修, 问题应留下)
  demo_all.obj       以上四类合在一个文件里

同时写出 js/examples-data.js 供页面直接加载。
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EX_DIR = os.path.join(ROOT, "examples")
JS_DIR = os.path.join(ROOT, "js")


class Mesh:
    def __init__(self):
        self.positions = []
        self.uvs = []
        self.faces = []  # (v0,v1,v2, vt0,vt1,vt2)

    def v(self, x, y, z):
        self.positions.append((x, y, z))
        return len(self.positions) - 1

    def vt(self, u, v):
        self.uvs.append((u, v))
        return len(self.uvs) - 1

    def f(self, a, b, c, ta, tb, tc):
        self.faces.append((a, b, c, ta, tb, tc))

    def quad(self, a, b, c, d, ta, tb, tc, td):
        self.f(a, b, c, ta, tb, tc)
        self.f(a, c, d, ta, tc, td)

    def merge(self, other, offset=(0, 0, 0)):
        vb = len(self.positions)
        tb = len(self.uvs)
        for p in other.positions:
            self.positions.append((p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]))
        self.uvs.extend(other.uvs)
        for a, b, c, ta, tb_, tc in other.faces:
            self.faces.append((a + vb, b + vb, c + vb, ta + tb, tb_ + tb, tc + tb))

    def to_obj(self, name):
        lines = ["# " + name]
        for p in self.positions:
            lines.append("v %g %g %g" % p)
        for t in self.uvs:
            lines.append("vt %g %g" % t)
        for a, b, c, ta, tb, tc in self.faces:
            lines.append("f %d/%d %d/%d %d/%d" % (a + 1, ta + 1, b + 1, tb + 1, c + 1, tc + 1))
        return "\n".join(lines) + "\n"


def cube(outward=True):
    """单位立方体, 8 顶点 12 三角面, 每面独立 UV 展开。"""
    m = Mesh()
    V = [m.v(x, y, z) for x in (0, 1) for y in (0, 1) for z in (0, 1)]

    def idx(x, y, z):
        return V[x * 4 + y * 2 + z]

    # 每个面: 4 个顶点(逆时针, 朝外) + 4 个 UV 角
    quads = [
        [idx(0, 0, 0), idx(0, 0, 1), idx(0, 1, 1), idx(0, 1, 0)],  # x=0  -x
        [idx(1, 0, 0), idx(1, 1, 0), idx(1, 1, 1), idx(1, 0, 1)],  # x=1  +x
        [idx(0, 0, 0), idx(1, 0, 0), idx(1, 0, 1), idx(0, 0, 1)],  # y=0  -y
        [idx(0, 1, 0), idx(0, 1, 1), idx(1, 1, 1), idx(1, 1, 0)],  # y=1  +y
        [idx(0, 0, 0), idx(0, 1, 0), idx(1, 1, 0), idx(1, 0, 0)],  # z=0  -z
        [idx(0, 0, 1), idx(1, 0, 1), idx(1, 1, 1), idx(0, 1, 1)],  # z=1  +z
    ]
    for q in quads:
        uv = [m.vt(0, 0), m.vt(1, 0), m.vt(1, 1), m.vt(0, 1)]
        if outward:
            m.quad(q[0], q[1], q[2], q[3], *uv)
        else:  # 反转绕向 -> 朝里
            m.quad(q[3], q[2], q[1], q[0], uv[3], uv[2], uv[1], uv[0])
    return m


def open_sheet():
    """z=0 平面上的 3x3 网格薄开口片, 其中 4 个三角形绕向被弄反。"""
    m = Mesh()
    n = 4  # 4x4 顶点
    V = [[m.v(x / (n - 1), y / (n - 1), 0) for x in range(n)] for y in range(n)]
    T = [[m.vt(x / (n - 1), y / (n - 1)) for x in range(n)] for y in range(n)]
    flipped = {(0, 0, 0), (1, 1, 1), (2, 0, 1), (1, 2, 0)}  # (格x, 格y, 第几个三角)
    for gy in range(n - 1):
        for gx in range(n - 1):
            tris = [
                (V[gy][gx], V[gy][gx + 1], V[gy + 1][gx + 1],
                 T[gy][gx], T[gy][gx + 1], T[gy + 1][gx + 1]),
                (V[gy][gx], V[gy + 1][gx + 1], V[gy + 1][gx],
                 T[gy][gx], T[gy + 1][gx + 1], T[gy + 1][gx]),
            ]
            for k, (a, b, c, ta, tb, tc) in enumerate(tris):
                if (gx, gy, k) in flipped:
                    m.f(a, c, b, ta, tc, tb)
                else:
                    m.f(a, b, c, ta, tb, tc)
    return m


def illegal_mesh():
    """非法连接网格: 一个朝里的闭合小块 + 三面共边 + 零面积面 + 重合未连接顶点。"""
    m = Mesh()
    # 1) 朝里的闭合小块 (可判定, 应能被修复), 放在 (3,0,0) 附近
    m.merge(cube(outward=False), offset=(3, 0, 0))

    # 2) 三面共用一条边: 边 (a,b) 被 f1/f2/f3 三个面使用
    a = m.v(0, 0, 0)
    b = m.v(1, 0, 0)
    c1 = m.v(0.5, 1, 0)
    c2 = m.v(0.5, -1, 0)
    c3 = m.v(0.5, 0, 1)
    t0, t1 = m.vt(0, 0), m.vt(1, 0)
    t2, t3, t4 = m.vt(0.5, 1), m.vt(0.5, 0), m.vt(1, 1)
    m.f(a, b, c1, t0, t1, t2)
    m.f(b, a, c2, t1, t0, t3)
    m.f(a, b, c3, t0, t1, t4)

    # 3) 零面积面: 三个顶点共线
    z0 = m.v(2, 2, 0)
    z1 = m.v(3, 2, 0)
    z2 = m.v(4, 2, 0)
    m.f(z0, z1, z2, t0, t1, t2)

    # 4) 重合但未连接的顶点: d 与 a 位置相同但互不相连
    d = m.v(0, 0, 0)  # 与 a 重合
    e = m.v(0, 1, 1)
    g = m.v(-1, 0.5, 0.5)
    m.f(d, e, g, t0, t1, t2)
    return m


def main():
    os.makedirs(EX_DIR, exist_ok=True)
    models = {
        "block_outward.obj": cube(outward=True),
        "block_inward.obj": cube(outward=False),
        "open_sheet.obj": open_sheet(),
        "illegal_mesh.obj": illegal_mesh(),
    }
    demo = Mesh()
    demo.merge(cube(outward=True), offset=(0, 0, 0))
    demo.merge(cube(outward=False), offset=(2.5, 0, 0))
    demo.merge(open_sheet(), offset=(0, 0, 2.5))
    demo.merge(illegal_mesh(), offset=(2.5, 0, 2.5))
    models["demo_all.obj"] = demo

    data = {}
    for name, mesh in models.items():
        text = mesh.to_obj(name)
        with open(os.path.join(EX_DIR, name), "w") as fh:
            fh.write(text)
        data[name] = text
        print("wrote examples/%s  (v=%d vt=%d f=%d)"
              % (name, len(mesh.positions), len(mesh.uvs), len(mesh.faces)))

    os.makedirs(JS_DIR, exist_ok=True)
    with open(os.path.join(JS_DIR, "examples-data.js"), "w") as fh:
        fh.write("// 由 tools/gen_test_models.py 生成, 请勿手改\n")
        fh.write("const EXAMPLE_MODELS = ")
        fh.write(json.dumps(data, ensure_ascii=False, indent=1))
        fh.write(";\n")
    print("wrote js/examples-data.js")


if __name__ == "__main__":
    main()
