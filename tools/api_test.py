"""HTTP API end-to-end test against a running local server.

Usage: python3 tools/api_test.py [base_url]
Drives the same workflow the browser UI uses, asserting every requirement.
"""

from __future__ import annotations

import io
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
SAMPLES = [Path("samples/sample_dark.jpg"),
           Path("samples/sample_mid.jpg"),
           Path("samples/sample_bright.jpg")]
failures: list[str] = []


def check(cond: bool, label: str) -> None:
    print(("  ✓ " if cond else "  ✗ ") + label)
    if not cond:
        failures.append(label)


def request(method: str, path: str, data=None, raw: bytes | None = None,
            content_type: str | None = None):
    url = BASE + path
    headers = {}
    body = None
    if raw is not None:
        body = raw
        if content_type:
            headers["Content-Type"] = content_type
    elif data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            payload = resp.read()
            ct = resp.headers.get("Content-Type", "")
            return json.loads(payload) if "json" in ct else payload
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        raise AssertionError(f"{method} {path} -> {e.code}: {detail}") from None


def multipart(fields: dict[str, list[tuple[str, bytes]]]) -> tuple[bytes, str]:
    boundary = "----hdrtestboundary123"
    chunks = []
    for name, files in fields.items():
        for filename, content in files:
            chunks.append(f"--{boundary}\r\n".encode())
            chunks.append(
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                f"Content-Type: image/jpeg\r\n\r\n".encode())
            chunks.append(content)
            chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def main() -> int:
    print("0) 健康检查与会话")
    sid = request("POST", "/api/sessions")["session_id"]
    check(bool(sid), "创建会话")

    print("1) 上传三张样例（含一张坏文件，验证部分失败处理）")
    good = [(p.name, p.read_bytes()) for p in SAMPLES]
    body, ct = multipart({"files": good + [("broken.jpg", b"not-an-image")]})
    up = request("POST", f"/api/sessions/{sid}/images", raw=body, content_type=ct)
    check(len(up["uploaded"]) == 3, "三张好图全部导入")
    check(len(up["failed"]) == 1 and "broken.jpg" in up["failed"][0]["filename"],
          "坏文件被单独报告且不影响其他图")
    ids = [i["image_id"] for i in up["uploaded"]]
    check(all(i["ev"] is not None for i in up["uploaded"]), "每张图带 EXIF 曝光信息")

    print("2) 建组与曝光顺序")
    g = request("POST", f"/api/sessions/{sid}/groups",
                {"image_ids": ids, "name": "测试场景"})
    gid = g["group_id"]
    evs = [f["ev"] for f in g["frames"]]
    check(evs == sorted(evs, reverse=True), "默认按 EV 从暗到亮排序")
    # 手动调序：把第一帧挪到末尾，再挪回来
    request("POST", f"/api/sessions/{sid}/groups/{gid}/reorder",
            {"from": 0, "to": 2})
    back = request("POST", f"/api/sessions/{sid}/groups/{gid}/reorder",
                   {"from": 2, "to": 0})
    check([f["image_id"] for f in back["frames"]] == ids, "手动调整顺序可往返还原")
    sorted_g = request("POST", f"/api/sessions/{sid}/groups/{gid}/sort-ev")["group"]
    check([f["image_id"] for f in sorted_g["frames"]] == ids, "按曝光信息重新排序正确")

    print("3) 位移校准")
    align = request("POST", f"/api/sessions/{sid}/groups/{gid}/align")
    check(all(r["aligned"] for r in align["reports"]), "三帧校准全部成功")
    nonzero = [r["shift"] for r in align["reports"] if r["shift"] != [0, 0]]
    check(len(nonzero) == 2, f"两帧检测到位移 {nonzero}")
    aligned_img = request("GET", f"/api/sessions/{sid}/groups/{gid}/aligned/1")
    check(aligned_img[:3] == b"\xff\xd8\xff", "对齐预览返回 JPEG")

    print("4) 重影检测与人工标记")
    ghost = request("POST", f"/api/sessions/{sid}/groups/{gid}/detect-ghost")
    check(0.002 < ghost["coverage"] < 0.25,
          f"重影覆盖率合理（{ghost['coverage'] * 100:.2f}%）")
    preview = request("GET", f"/api/sessions/{sid}/ghost-preview/{gid}")
    check(preview[:4] == b"\x89PNG", "重影预览返回 PNG")
    request("POST", f"/api/sessions/{sid}/groups/{gid}/auto-ghost", {"used": True})
    mark = request("POST", f"/api/sessions/{sid}/groups/{gid}/marks",
                   {"points": [[0.36, 0.55], [0.54, 0.55], [0.54, 0.78], [0.36, 0.78]],
                    "source_index": 1, "label": "红球取中间帧"})
    check(mark["mark"]["source_index"] == 1, "人工标记写入成功")
    overlay = request("GET", f"/api/sessions/{sid}/groups/{gid}/marks-overlay")
    check(overlay[:4] == b"\x89PNG", "标记叠加预览返回 PNG")
    # 非法来源帧应被拒绝
    try:
        request("POST", f"/api/sessions/{sid}/groups/{gid}/marks",
                {"points": [[0, 0], [1, 0], [1, 1]], "source_index": 99})
        check(False, "非法来源帧被拒绝")
    except AssertionError:
        check(True, "非法来源帧被拒绝")

    print("5) 合成与色调预览（参数不覆盖输入）")
    fuse = request("POST", f"/api/sessions/{sid}/groups/{gid}/fuse",
                   {"use_auto_ghost": True})
    check(fuse["shape"][:2] == [720, 960], "合成结果保持原尺寸")
    fused_pv = request("GET", f"/api/sessions/{sid}/fused-preview/{gid}")
    check(fused_pv[:4] == b"\x89PNG", "合成预览返回 PNG")
    params = {"exposure": 0.4, "shadows": 0.6, "highlights": 0.5, "saturation": 1.15}
    tone = request("POST", f"/api/sessions/{sid}/groups/{gid}/tonemap", params)
    check(tone[:3] == b"\xff\xd8\xff", "色调预览返回 JPEG")
    tone2 = request("POST", f"/api/sessions/{sid}/groups/{gid}/tonemap",
                    {**params, "exposure": -1.0})
    check(tone != tone2, "不同参数产生不同预览")

    print("6) 导出")
    links = request("POST", f"/api/sessions/{sid}/groups/{gid}/export", params)
    png_blob = request("GET", links["png_url"])
    tiff_blob = request("GET", links["tiff_url"])
    rec_blob = request("GET", links["params_url"])
    check(png_blob[:4] == b"\x89PNG" and len(png_blob) > 1000, "导出 PNG 可下载")
    check(tiff_blob[:4] in (b"II*\x00", b"MM\x00*") and len(tiff_blob) > 1000,
          "导出 16-bit TIFF 可下载")
    check(isinstance(rec_blob, dict), "导出参数记录 JSON 可下载")
    rec = rec_blob
    check(rec["tonemap_params"] == params and len(rec["frames"]) == 3
          and len(rec["ghost_marks"]) == 1, "参数记录含色调参数、帧状态与标记")

    print("7) 工程保存与恢复")
    proj_obj = request("GET", f"/api/sessions/{sid}/project")
    check(proj_obj["format"] == "hdrtool-project/1", "工程文件下载成功")
    proj = json.dumps(proj_obj).encode()
    body, ct = multipart({"project": [("p.hdrproj.json", proj)]})
    loaded = request("POST", "/api/projects/load", raw=body, content_type=ct)
    check(loaded["session_id"] != sid, "工程加载为新会话")
    lg = loaded["groups"][0]
    check(len(lg["frames"]) == 3, "恢复 3 帧图片组")
    check(len(lg["marks"]) == 1 and lg["marks"][0]["source_index"] == 1,
          "恢复重影标记与来源帧")
    check(all(f["aligned"] for f in lg["frames"]), "恢复校准状态")
    # 恢复后直接重新合成，验证对齐缓存重放
    rgid = lg["group_id"]
    re_fuse = request("POST", f"/api/sessions/{loaded['session_id']}/groups/{rgid}/fuse",
                      {"use_auto_ghost": True})
    check(re_fuse["shape"][:2] == [720, 960], "恢复后无需重新校准即可合成")

    print("8) 错误处理：缺失会话与未合成就调色")
    try:
        request("GET", "/api/sessions/nonexistent/images")
        check(False, "缺失会话返回明确错误")
    except AssertionError:
        check(True, "缺失会话返回明确错误")

    print()
    if failures:
        print(f"API 测试失败 {len(failures)} 项:")
        for f in failures:
            print("  - " + f)
        return 1
    print("全部 API 测试通过 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
