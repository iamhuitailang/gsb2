"""端到端自检：在临时数据目录里起服务，用无头浏览器跑完整领取流程。

校验点：
  1. 资料站分页/筛选/下载可用，附件保留原始文件名「月报.pdf」
  2. 全量领取后，同名文件按门店分目录归档，数量与资料站一致且 SHA256 相同
  3. 原版/修订版同时保留，当前版本标记正确
  4. 同范围再次领取全部命中跳过，不产生重复文件
  5. 入库查看/下载接口可用
"""
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import urllib.request  # noqa: E402

from app import config, db, seed  # noqa: E402
from app.harvest import HarvestWorker  # noqa: E402


def check(cond: bool, msg: str) -> None:
    print(("  ✅ " if cond else "  ❌ ") + msg)
    if not cond:
        raise AssertionError(msg)


def wait_port(url: str, timeout: float = 15) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=2).read()
            return
        except Exception:
            time.sleep(0.4)
    raise RuntimeError(f"server not ready: {url}")


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="monthly-report-selftest-"))
    print(f"临时数据目录：{tmp}")

    # 重定向数据目录，保证自检不污染演示数据
    config.BASE_DIR = tmp
    config.DATA_DIR = tmp / "data"
    config.SOURCE_DIR = config.DATA_DIR / "source_pdfs"
    config.INBOX_DIR = config.DATA_DIR / "inbox"
    config.DB_PATH = config.DATA_DIR / "app.db"
    config.HEADLESS = True
    config.PORT = 8765  # 自检专用端口，避开开发服务器

    from app import create_app  # 在重定向之后导入，确保使用临时目录

    print("\n[1] 播种虚构资料")
    info = seed.seed()
    check(info["reports"] == 8, "共 8 条报表版本（含 1 份修订版）")
    source_files = list(config.SOURCE_DIR.rglob("*.pdf"))
    check(len(source_files) == 8, "资料站生成 8 个原始 PDF")
    check(all(f.name == "月报.pdf" for f in source_files), "资料站附件原始文件名均为 月报.pdf")

    app = create_app()

    # app.run 阻塞，放到守护线程里
    import threading
    t = threading.Thread(
        target=lambda: app.run(
            host=config.HOST, port=config.PORT, threaded=True, use_reloader=False
        ),
        daemon=True,
    )
    t.start()
    wait_port(f"http://{config.HOST}:{config.PORT}/portal/")
    print("  ✅ 测试服务器已启动")

    try:
        print("\n[2] 资料站页面：筛选与分页")
        html = urllib.request.urlopen(
            f"http://{config.HOST}:{config.PORT}/portal/?month=2026-09&page=1"
        ).read().decode()
        check("data-doc-no" in html, "列表页渲染出报表行")
        check('id="page-info" data-total-pages="2"' in html,
              "9 月 4 条报表、每页 2 条，共 2 页")
        check("WL-2026-0901" in html and "V1.0" in html and "V2.0" in html,
              "同一资料编号的原版与修订版都在列表中")
        check("历史版本" in html and "当前版本" in html, "页面区分当前/历史版本")

        # 直接验证资料站下载接口保留原始文件名
        req = urllib.request.Request(
            f"http://{config.HOST}:{config.PORT}/portal/download/WL-2026-0901/V2.0"
        )
        resp = urllib.request.urlopen(req)
        cd = unquote(resp.headers["Content-Disposition"])
        check("filename*=UTF-8''月报.pdf" in cd, "资料站下载保留原始文件名 月报.pdf")
        check(resp.read().startswith(b"%PDF"), "下载内容是真实 PDF")

        print("\n[3] 浏览器自动化：全量领取（无头 Chrome 逐页点击下载）")
        conn = db.get_conn()
        run_id = db.create_run(conn, "", "")
        conn.close()
        stats = HarvestWorker(run_id, "", "", headless=True).run()
        check(stats["downloaded"] == 8 and stats["errors"] == 0,
              f"8 条全部下载成功（实际统计：{stats}）")

        inbox_files = sorted(config.INBOX_DIR.rglob("*.pdf"))
        check(len(inbox_files) == 8, "inbox 落地 8 个文件")
        # 同名文件按门店分开：inbox/<门店>/<月份>/<编号>/<版本>/月报.pdf
        store_dirs = {p.relative_to(config.INBOX_DIR).parts[0] for p in inbox_files}
        check(store_dirs == {"S01", "S02", "S03"}, "文件按门店编码分目录存放")
        # 同店同月同编号下两个版本共存
        v_dir = config.INBOX_DIR / "S01" / "2026-09" / "WL-2026-0901"
        check((v_dir / "V1.0" / "月报.pdf").is_file()
              and (v_dir / "V2.0" / "月报.pdf").is_file(),
              "原版 V1.0 与修订版 V2.0 同时保留")

        # 校验实际下载文件与资料站原件逐字节一致（两套目录布局不同，经 DB 映射）
        conn = db.get_conn()
        all_inbox = db.list_inbox(conn, "", "")
        mismatched = []
        for r in all_inbox:
            source = db.get_report(conn, r["doc_no"], r["version"])
            src = config.SOURCE_DIR / source["source_path"]
            dst = config.BASE_DIR / r["stored_path"]
            if dst.read_bytes() != src.read_bytes():
                mismatched.append(r["doc_no"] + " " + r["version"])
        check(not mismatched, f"下载文件与资料站原件内容一致（异常：{mismatched}）")

        rows = all_inbox
        check(len(rows) == 8, "入库表 8 条记录")
        current = {(r["doc_no"], r["version"]): r["is_current"] for r in rows}
        check(current[("WL-2026-0901", "V1.0")] == 0
              and current[("WL-2026-0901", "V2.0")] == 1,
              "望京店 9 月：V1.0 标记历史版本，V2.0 标记当前版本")
        conn.close()

        print("\n[4] 同范围再次领取：已有版本应全部跳过")
        conn = db.get_conn()
        run_id2 = db.create_run(conn, "", "")
        conn.close()
        stats2 = HarvestWorker(run_id2, "", "", headless=True).run()
        check(stats2["skipped"] == 8 and stats2["downloaded"] == 0
              and stats2["errors"] == 0,
              f"第二次领取 8 条全部跳过（实际统计：{stats2}）")
        check(len(list(config.INBOX_DIR.rglob("*.pdf"))) == 8, "没有产生重复文件")

        print("\n[5] 按门店+月份局部领取与入库查看接口")
        conn = db.get_conn()
        run_id3 = db.create_run(conn, "2026-10", "S02")
        conn.close()
        stats3 = HarvestWorker(run_id3, "2026-10", "S02", headless=True).run()
        check(stats3["total_seen"] == 2 and stats3["skipped"] == 2,
              "三里屯店 10 月的 2 个版本（V1.0/V1.1）均被识别并跳过")

        conn = db.get_conn()
        one = conn.execute("SELECT * FROM inbox LIMIT 1").fetchone()
        conn.close()
        view = urllib.request.urlopen(
            f"http://{config.HOST}:{config.PORT}/inbox/{one['id']}/view"
        )
        check(view.read().startswith(b"%PDF"), "入库预览接口返回真实 PDF")
        dl = urllib.request.urlopen(
            f"http://{config.HOST}:{config.PORT}/inbox/{one['id']}/download"
        )
        dl_name = unquote(dl.headers["Content-Disposition"])
        check(one["store_name"] in dl_name and one["version"] in dl_name,
              "入库下载文件名带门店与版本，可区分同名附件")

    finally:
        # werkzeug 的开发服务器没有公开 stop 句柄，进程退出即释放端口
        print(f"\n自检完成，临时数据保留在：{tmp}（可手动删除）")


if __name__ == "__main__":
    main()
