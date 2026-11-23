#!/usr/bin/env python3
"""读回校验: 检查导出的 OBJ 与页面导出的报告 JSON 是否一致。

用法: python3 tools/verify_obj.py <model.obj> <report.json>

检查项:
  1. 面数 / 顶点数 / UV 数与报告一致
  2. 每个面角的 (顶点, UV) 对应与报告一致
  3. 开口边 / 非流形边 / 零面积面 / 重合顶点与报告一致
"""
import json
import sys


def parse_obj(path):
    positions, uvs, faces = [], [], []
    with open(path) as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if parts[0] == "v":
                positions.append(tuple(float(x) for x in parts[1:4]))
            elif parts[0] == "vt":
                uvs.append(tuple(float(x) for x in parts[1:3]))
            elif parts[0] == "f":
                idx = []
                for tok in parts[1:]:
                    seg = tok.split("/")
                    vi = int(seg[0])
                    if vi < 0:
                        vi = len(positions) + vi + 1
                    ti = -1
                    if len(seg) > 1 and seg[1]:
                        ti = int(seg[1])
                        if ti < 0:
                            ti = len(uvs) + ti + 1
                    idx.append((vi - 1, ti - 1 if ti != -1 else -1))
                for i in range(1, len(idx) - 1):  # 扇形三角化
                    faces.append((idx[0], idx[i], idx[i + 1]))
    return positions, uvs, faces


def edge_set(faces):
    """边 -> 引用次数（按顶点索引，与页面一致）"""
    from collections import Counter
    cnt = Counter()
    for f in faces:
        vs = [c[0] for c in f]
        for k in range(3):
            a, b = vs[k], vs[(k + 1) % 3]
            if a == b:
                continue
            cnt[(min(a, b), max(a, b))] += 1
    return cnt


def zero_area_faces(positions, faces, eps2):
    out = []
    for i, f in enumerate(faces):
        vs = [c[0] for c in f]
        if len(set(vs)) < 3:
            out.append(i)
            continue
        a, b, c = (positions[v] for v in vs)
        u = [b[k] - a[k] for k in range(3)]
        w = [c[k] - a[k] for k in range(3)]
        n = [u[1] * w[2] - u[2] * w[1],
             u[2] * w[0] - u[0] * w[2],
             u[0] * w[1] - u[1] * w[0]]
        area2 = sum(x * x for x in n) ** 0.5 / 2
        if area2 < eps2:
            out.append(i)
    return out


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    positions, uvs, faces = parse_obj(sys.argv[1])
    report = json.load(open(sys.argv[2]))

    failures = []

    def check(name, cond, detail=""):
        print(("%s  %s" % ("PASS" if cond else "FAIL", name)) +
              ("  (%s)" % detail if detail else ""))
        if not cond:
            failures.append(name)

    # 1. 数量
    check("面数一致", len(faces) == report["counts"]["faces"],
          "%d vs %d" % (len(faces), report["counts"]["faces"]))
    check("顶点数一致", len(positions) == report["counts"]["vertices"],
          "%d vs %d" % (len(positions), report["counts"]["vertices"]))
    check("UV数一致", len(uvs) == report["counts"]["uvs"],
          "%d vs %d" % (len(uvs), report["counts"]["uvs"]))

    # 2. 面角 (v, vt) 对应
    corner_ok = len(faces) == len(report["faceCorners"])
    bad = -1
    if corner_ok:
        for i, (f, rc) in enumerate(zip(faces, report["faceCorners"])):
            for k in range(3):
                if f[k][0] != rc[k][0] or f[k][1] != rc[k][1]:
                    corner_ok, bad = False, i
                    break
            if not corner_ok:
                break
    check("面角-UV对应一致", corner_ok,
          "面 #%d 不匹配" % bad if bad >= 0 else "")

    # 3. 问题边 / 问题面
    cnt = edge_set(faces)
    boundary = {"%d_%d" % e for e, n in cnt.items() if n == 1}
    nonman = {"%d_%d" % e for e, n in cnt.items() if n >= 3}
    rep_boundary = set(report["issues"]["boundaryEdges"])
    rep_nonman = {e["edge"] for e in report["issues"]["nonManifoldEdges"]}
    check("开口边一致", boundary == rep_boundary,
          "obj %d 条, 报告 %d 条" % (len(boundary), len(rep_boundary)))
    check("非流形边一致", nonman == rep_nonman,
          "obj %d 条, 报告 %d 条" % (len(nonman), len(rep_nonman)))

    xs = [p[i] for p in positions for i in range(3)]
    diag = (max(xs) - min(xs)) or 1.0
    zero = set(zero_area_faces(positions, faces, (diag * 1e-6) ** 2))
    rep_zero = set(report["issues"]["zeroAreaFaces"])
    check("零面积面一致", zero == rep_zero,
          "obj %d 个, 报告 %d 个" % (len(zero), len(rep_zero)))

    # 重合顶点组数
    from collections import defaultdict
    groups = defaultdict(list)
    eps = diag * 1e-7
    for i, p in enumerate(positions):
        groups[tuple(round(x / eps) for x in p)].append(i)
    coincident = sum(1 for g in groups.values() if len(g) > 1)
    check("重合顶点组数一致",
          coincident == len(report["issues"]["coincidentVertices"]),
          "obj %d 组, 报告 %d 组" % (coincident, len(report["issues"]["coincidentVertices"])))

    print("\n%s" % ("全部通过" if not failures else "%d 项失败" % len(failures)))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
