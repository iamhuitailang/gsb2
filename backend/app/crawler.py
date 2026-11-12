"""采集器：BFS 沿链接抓取，同域限制、限速、重试、URL 规范化、去重、增量比对。"""
import hashlib
import re
import threading
import time
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

import requests
from bs4 import BeautifulSoup

from . import db

USER_AGENT = "local-tracker-bot/1.0 (+https://example.local/bot)"
DEFAULT_PORTS = {"http": 80, "https": 443}
# 规范化时剔除的追踪参数（utm_*、gclid 等），避免同一页面被当作多个页面
TRACKING_PARAMS = {"gclid", "fbclid", "ref", "spm"}


def normalize_url(url):
    """规范化 URL：小写 scheme/host、去默认端口、去 fragment、
    剔除追踪参数并排序查询参数、去末尾斜杠（根路径除外）。"""
    parts = urlsplit(url.strip())
    scheme = (parts.scheme or "http").lower()
    host = (parts.hostname or "").lower()
    if not host:
        return None
    port = parts.port
    netloc = host
    if port and port != DEFAULT_PORTS.get(scheme):
        netloc = f"{host}:{port}"
    path = parts.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    # 剔除追踪参数后排序，丢弃空值参数
    query = urlencode(sorted(
        (k, v) for k, v in parse_qsl(parts.query, keep_blank_values=False)
        if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS
    ))
    return urlunsplit((scheme, netloc, path, query, ""))


def same_domain(url_a, url_b):
    return urlsplit(url_a).netloc.lower() == urlsplit(url_b).netloc.lower()


def extract_page(html, url):
    """从 HTML 提取标题、正文、页面标注的更新时间和出站链接。"""
    soup = BeautifulSoup(html, "html.parser")

    h1 = soup.find("h1")
    title = h1.get_text(strip=True) if h1 else (soup.title.string.strip() if soup.title and soup.title.string else url)

    # 正文：优先 <article> / .content / <main>，退化为 <body>
    node = soup.select_one("article") or soup.select_one(".content") or soup.find("main") or soup.body
    content = node.get_text("\n", strip=True) if node else ""

    # 更新时间：<time datetime> 或 <meta name="last-modified">
    updated = ""
    t = soup.find("time", attrs={"datetime": True})
    if t:
        updated = t["datetime"].strip()
    else:
        m = soup.find("meta", attrs={"name": re.compile(r"last[-_]modified", re.I)})
        if m and m.get("content"):
            updated = m["content"].strip()

    links = []
    for a in soup.find_all("a", href=True):
        absolute = urljoin(url, a["href"])
        if absolute.startswith(("http://", "https://")):
            links.append(absolute)
    return title, content, updated, links


def _fetch(url, retry_times):
    """带重试的 GET，指数退避。返回 (html, error)。"""
    err = None
    for attempt in range(retry_times + 1):
        try:
            resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=10)
            if resp.status_code == 200:
                # 本地静态服务器通常不带 charset，按内容嗅探编码（meta charset=utf-8）
                resp.encoding = resp.apparent_encoding or resp.encoding
                return resp.text, None
            err = f"HTTP {resp.status_code}"
            if resp.status_code in (404, 410):
                break  # 客户端错误重试无意义
        except requests.RequestException as e:
            err = str(e)
        if attempt < retry_times:
            time.sleep(min(2 ** attempt, 4))
    return None, err


def _update_run_counts(run_id, **kw):
    sets = ", ".join(f"{k}=?" for k in kw)
    db.execute(f"UPDATE runs SET {sets} WHERE id=?", (*kw.values(), run_id))


def run_crawl(run_id, rule):
    """执行一轮采集（在后台线程中运行）。"""
    delay = rule["delay_ms"] / 1000.0
    max_pages = rule["max_pages"]
    include_re = re.compile(rule["include_pattern"]) if rule["include_pattern"] else None
    exclude_re = re.compile(rule["exclude_pattern"]) if rule["exclude_pattern"] else None

    start = normalize_url(rule["start_url"])
    queue = [start]
    seen = {start}          # 已入队的规范化 URL，用于去重
    visited = set()         # 本轮已成功抓取的 URL
    counts = dict(n_new=0, n_changed=0, n_unchanged=0, n_failed=0)

    try:
        while queue and len(visited) < max_pages:
            url = queue.pop(0)
            _update_run_counts(run_id, queued=len(queue), processing=1, done=len(visited))

            html, err = _fetch(url, rule["retry_times"])
            if err:
                counts["n_failed"] += 1
                db.execute(
                    """INSERT INTO page_history (run_id, url, status, fetched_at)
                       VALUES (?,?,?,?)""",
                    (run_id, url, "failed", time.time()),
                )
                _update_run_counts(run_id, n_failed=counts["n_failed"])
                continue

            title, content, updated, links = extract_page(html, url)
            content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
            now = time.time()

            existing = db.query_one("SELECT * FROM pages WHERE url=?", (url,))
            if existing is None:
                status = "new"
                db.execute(
                    """INSERT INTO pages (url, title, content, updated_text, content_hash,
                                          status, first_seen_run, last_seen_run, last_fetch_at)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (url, title, content, updated, content_hash, "new", run_id, run_id, now),
                )
            elif existing["content_hash"] != content_hash:
                status = "changed"
                db.execute(
                    """UPDATE pages SET title=?, content=?, updated_text=?, content_hash=?,
                                        status='changed', last_seen_run=?, last_fetch_at=?
                       WHERE url=?""",
                    (title, content, updated, content_hash, run_id, now, url),
                )
            else:
                status = "unchanged"
                db.execute(
                    "UPDATE pages SET status='unchanged', last_seen_run=?, last_fetch_at=? WHERE url=?",
                    (run_id, now, url),
                )
            counts[f"n_{status}"] += 1
            visited.add(url)

            db.execute(
                """INSERT INTO page_history
                   (run_id, url, title, content, updated_text, content_hash, status, fetched_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (run_id, url, title, content, updated, content_hash, status, now),
            )

            # 发现新链接：同域 + include/exclude 过滤 + 规范化去重
            for link in links:
                norm = normalize_url(link)
                if not norm or norm in seen:
                    continue
                if rule["same_domain"] and not same_domain(norm, start):
                    continue
                if include_re and not include_re.search(norm):
                    continue
                if exclude_re and exclude_re.search(norm):
                    continue
                seen.add(norm)
                queue.append(norm)

            _update_run_counts(run_id, **counts)
            time.sleep(delay)  # 请求间隔限速

        # 标记消失页面：历史存在但本轮未访问到
        removed = db.query(
            "SELECT url, title, content, updated_text, content_hash FROM pages "
            "WHERE status != 'removed' AND last_seen_run < ?", (run_id,),
        )
        for p in removed:
            db.execute("UPDATE pages SET status='removed' WHERE url=?", (p["url"],))
            db.execute(
                """INSERT INTO page_history
                   (run_id, url, title, content, updated_text, content_hash, status, fetched_at)
                   VALUES (?,?,?,?,?,?, 'removed', ?)""",
                (run_id, p["url"], p["title"], p["content"], p["updated_text"],
                 p["content_hash"], time.time()),
            )

        _update_run_counts(
            run_id, queued=0, processing=0, done=len(visited),
            n_removed=len(removed), status="done", finished_at=time.time(), **counts,
        )
    except Exception as e:  # noqa: BLE001
        _update_run_counts(run_id, status="failed", error=str(e),
                           processing=0, finished_at=time.time())


def start_run(rule_id):
    rule = db.query_one("SELECT * FROM rules WHERE id=?", (rule_id,))
    if rule is None:
        return None
    run_id = db.execute(
        "INSERT INTO runs (rule_id, started_at) VALUES (?,?)", (rule_id, time.time())
    )
    threading.Thread(target=run_crawl, args=(run_id, rule), daemon=True).start()
    return run_id
