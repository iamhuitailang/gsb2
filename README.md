# dnscheck — 本地 DNS 响应缓存与安全检查工具

完全离线运行，不连接真实 DNS 服务，不依赖任何第三方包（仅 Python 3 标准库）。
查询与"上游响应"都来自本地 JSON 场景文件，用于检查：

- 上游响应是否真的对应当前请求（事务 id、问题名称/类型/类别，名称比较忽略大小写与末尾点）；
- 缓存与别名（CNAME）解析在异常情况下（过期、循环、冲突、并发乱序）会不会把错误结果留给后续查询。

## 运行环境

Python 3.8+，无需安装任何依赖。

## 运行示例

```bash
cd repo
python3 -m dnscheck samples/basic.json      # 接受/拒绝/缓存命中/TTL 截断/过期刷新
python3 -m dnscheck samples/cname.json      # 别名链：缓存组合、循环、过深、缺目标、冲突
python3 -m dnscheck samples/negative.json   # NXDOMAIN 负缓存、SERVFAIL 临时失败
python3 -m dnscheck samples/basic.json --show-data   # 额外显示记录数据（如 IP）
```

每条查询输出判定结果（`ACCEPT` / `REJECT` / `CACHE_HIT` / `CACHE_HIT_NXDOMAIN` /
`NXDOMAIN` / `SERVFAIL` / `NO_UPSTREAM`）及判断依据。默认不打印记录数据（IP 等），
需要时用 `--show-data`。

## 运行测试

```bash
cd repo
python3 -m unittest discover -s tests -v
```

测试使用可控时钟（`dnscheck.clock.Clock`），不依赖真实等待时间或网络，可重复验证。
覆盖：缓存命中、过期刷新、错误响应拒绝、TTL 上限截断、别名循环/过深/缺目标/冲突、
NXDOMAIN 负缓存、SERVFAIL 不覆盖有效缓存、并发读写不乱序覆盖。

## 场景文件格式

```json
{
  "config": {"max_ttl": 300, "negative_ttl": 60, "max_cname_depth": 8, "clock_start": 0},
  "steps": [
    {"op": "query", "id": 1, "qname": "www.example.com", "qtype": "A",
     "upstream": {"id": 1, "rcode": "NOERROR",
                  "question": {"name": "www.example.com", "type": "A", "class": "IN"},
                  "answers": [{"name": "www.example.com", "type": "A", "class": "IN",
                               "ttl": 3600, "data": "192.0.2.10"}]}},
    {"op": "advance", "seconds": 301},
    {"op": "cleanup"}
  ]
}
```

- `query`：先查缓存；未命中且提供了 `upstream` 时，校验并处理该模拟上游响应；
  未提供则报告 `NO_UPSTREAM`。
- `advance`：推进可控时钟（测试 TTL 过期）。
- `cleanup`：清理已过期缓存项。
- 输入格式错误会以 `文件: step N: 字段` 的形式报错并退出（退出码 2），不会静默忽略。

## 关键安全语义

- **响应校验**：事务 id、问题名称（大小写不敏感、忽略末尾点）、类型、类别必须一致；
  回答记录必须与查询名相关（从查询名沿响应内 CNAME 可达），只含无关地址记录的响应被拒绝。
- **TTL**：上游 TTL 超过本地 `max_ttl` 会被截断；过期条目不会命中；`cleanup` 可清理。
- **别名链**：链可部分来自缓存；循环、超深、缺目标、冲突（多个 CNAME / CNAME 与地址共存）
  都会被拒绝，且不完整/不可信的链不会写入缓存。
- **结果分类**：肯定回答按 TTL 缓存；NXDOMAIN 按 `negative_ttl` 负缓存；SERVFAIL 不缓存，
  也不会覆盖仍有效的肯定回答。
- **并发**：缓存写入有锁；较短命的响应不能顶掉仍有效的较长命条目，负缓存不能顶掉有效
  肯定条目，因此同名并发查询的完成顺序不会让过期/被拒绝的响应覆盖有效缓存；响应与请求
  的严格匹配保证不同查询之间不会串用响应。

## 目录结构

```
dnscheck/     实现（model / validator / cache / resolver / loader / cli）
samples/      示例场景
tests/        自动化测试（unittest）
```
