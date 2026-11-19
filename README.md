# lock-audit — 离线 package-lock 来源与完整性审计

在本机审查 `package-lock.json` 的**下载来源（resolved）**与**完整性声明（integrity）**，
重点找出"看起来像官方依赖、实际来源或包身份却对不上"的条目。

- **纯离线**：只在本机解析文件，不访问注册表或任何外网，不执行安装脚本，不安装依赖。
- **零依赖**：仅使用 Node.js 内置模块（`node:fs`、`node:crypto`、`node:http` 等），无需 `npm install`。
- **不臆断恶意**：来源类发现只表示"与规则不符 / 无法判定 / 待核实"，不会把异常直接说成已确认恶意。
- **声明 ≠ 已校验**：工具不下载压缩包，`integrity` 永远只作为锁文件中的声明来检查，所有条目 `verified` 均为 `false`。

## 环境要求

- Node.js >= 18（开发与验证使用 Node v24）。
- 不需要联网，不需要安装任何第三方包。

## 启动方式

### CLI

```bash
# 审计一个锁文件（内置默认规则），终端打印表格
node bin/lock-audit.js audit examples/lockfile-v2.json

# 指定规则与基线，导出 JSON 复核报告
node bin/lock-audit.js audit examples/lockfile-v2.json \
  --rules examples/rules.example.json \
  --baseline examples/baseline-v2.json \
  --out report.json

# 输出 JSON 到 stdout
node bin/lock-audit.js audit examples/lockfile-v3.json --format json

# 存在高级别及以上发现时以退出码 1 结束（便于 CI 卡点）
node bin/lock-audit.js audit examples/lockfile-v2.json --fail-on high

# 查看物化后的默认规则，复制后自行修改
node bin/lock-audit.js rules

# 其它选项
node bin/lock-audit.js --help
```

退出码：`0` 未达到 `--fail-on` 阈值；`1` 存在达到阈值的发现；`2` 参数/文件/解析类错误。

### 本地 Web 界面

```bash
node bin/lock-audit.js serve --host 127.0.0.1 --port 8080
# 浏览器打开 http://127.0.0.1:8080
```

页面支持：

- 选择锁文件 / 规则 / 基线三个本地文件，或从「载入示例」下拉直接载入 `examples/` 中的内置样例；
- 按风险级别、变化类型、来源主机、包名关键字筛选，点击表头排序，分页浏览；
- 点击任意一行展开：全部触发原因、期望/实际证据、从根直接依赖到目标包的依赖路径（含菱形依赖的多条备选路径）、锁文件原始字段；
- 「导出 JSON 报告」下载完整可复核报告。

**失败即清空**：每次发起分析或更换文件，前端都会先把结果区重置为空态；只有收到 HTTP 200 且 `ok===true` 才渲染结果。
解析失败、结构不支持、体积超限时只显示错误横幅，绝不会把上一次结果留在页面上冒充本次结果。

## 检查边界（务必先读）

1. **离线边界**：全程不发起任何网络请求，不读取 registry，不运行 `preinstall/postinstall` 等脚本。
2. **完整性边界**：`integrity` 仅校验锁文件中的 SRI *声明*（是否缺失、格式是否合法、算法是否被允许）。
   工具不下载 tarball，因此**无法验证压缩包的真实内容**，报告中所有条目的 `verified` 都是 `false`，
   完整性类发现会标注"仅声明、未实际验证"。
3. **措辞边界**：来源异常不等于恶意。例如非可信主机可能是企业自建镜像，git/别名依赖可能是正常的内部实践，
   这类条目统一标为"待核实"，需要结合团队约定人工判断。
4. **无法判定不放行**：v3 锁文件省略 `resolved`/`integrity`、依赖图中不可达的孤立条目、无法解析的来源串，
   一律进入报告的 `inconclusive` 待核实清单，而不是默认通过。
5. **JSON 重复键限制**：标准 `JSON.parse` 对重复键静默取最后一个值，本工具继承该行为，无法识别被重复键覆盖的内容。

## 规则配置

见 `examples/rules.example.json`，字段含义：

| 字段 | 说明 |
|---|---|
| `trustedHosts` | 可信下载域名白名单（默认仅 `registry.npmjs.org`） |
| `matchSubdomains` | 是否信任白名单域的子域 |
| `allowedSchemes` | 允许的 URL 协议（默认仅 `https:`，`http:` 会被标记） |
| `allowedAlgorithms` / `weakAlgorithms` | 允许的 SRI 算法 / 视为过弱的算法（默认 sha1 为弱） |
| `forceIntegrity` | 为 true 时缺失 integrity 按高级别报告 |
| `maxFileSizeBytes` | 输入文件与请求体大小上限（默认 10 MiB，stat 预检 + 读取中硬计数双保险） |
| `reviewGitSources` / `reviewFileSources` / `reviewLinkSources` | git/file/link 三类非 registry 来源的报告级别 |
| `severityOverrides` | 按 ruleId 覆盖默认严重级别 |

## 如何用示例复现各种结果

`examples/` 下三份锁文件埋好了相同的异常面（v1/v2/v3 各一份）：

| 场景 | 示例条目 | 预期 ruleId / 结果 |
|---|---|---|
| 正常 registry + sha512 | `left-pad` | 无来源/完整性发现 |
| 非可信下载主机 | `evil-fetch`（主机 `registry.evil-example.com`） | `RESOLVED_HOST_UNTRUSTED`（高，待核实） |
| Git 来源 | `vcs-thing`（git+ssh / github 缩写）、v1 的 `scp-git-thing` | `RESOLVED_NON_REGISTRY_GIT` |
| 本地路径依赖 | `local-tar`（`file:`） | `RESOLVED_NON_REGISTRY_FILE` |
| 链接/工作区依赖 | v2 `workspace-pkg`（`link:true`） | `RESOLVED_NON_REGISTRY_LINK` |
| 安装别名身份不一致 | `my-alias`（目录名 ≠ 真实包名 `real-pkg`） | `ALIAS_NAME_MISMATCH`（中，待核实） |
| 压缩包包名与声明包名不符 | v2 `imposter`（resolved 指向 `genuine` 的 tarball） | `RESOLVED_NAME_MISMATCH`（高） |
| 明文 http 协议 | `plain-http` | `RESOLVED_SCHEME_NOT_ALLOWED` |
| 缺少 integrity | `no-integrity` | `INTEGRITY_MISSING` |
| 弱摘要算法 | `legacy-sha1`（sha1） | `INTEGRITY_ALG_WEAK` |
| SRI 格式非法 | `bad-sri`（非法 base64/padding） | `INTEGRITY_SRI_MALFORMED` |
| 嵌套同名包多位置 | `lodash@4.17.21` 与 `old-app/node_modules/lodash@3.10.1` | 两条记录分别保留、依赖路径各自独立 |
| v3 省略字段 | `fully-omitted`（空对象）、`integrity-omitted` | 进入 `inconclusive`，不计为通过 |

复现正常结果与异常结果：

```bash
# 1) 正常项不报警：在 v2 报告里过滤 left-pad，应无任何来源/完整性发现
node bin/lock-audit.js audit examples/lockfile-v2.json --format json \
  | grep -A3 '"name": "left-pad"'

# 2) 复现非可信主机与包身份错配（高级别、待核实措辞）
node bin/lock-audit.js audit examples/lockfile-v2.json | grep -E 'HOST_UNTRUSTED|NAME_MISMATCH'

# 3) 复现 v3 字段省略的待核实项
node bin/lock-audit.js audit examples/lockfile-v3.json | sed -n '/待核实/,$p'

# 4) 复现基线差异：host/version/integrity 变化 + 新增/移除，按唯一位置计数
node bin/lock-audit.js audit examples/lockfile-v2.json --baseline examples/baseline-v2.json

# 5) 复现输入失败（不残留旧结果）
printf '{ broken' > /tmp/bad.json
node bin/lock-audit.js audit /tmp/bad.json          # JSON_PARSE_ERROR，退出码 2
printf '{"dependencies":{}}' > /tmp/nover.json
node bin/lock-audit.js audit /tmp/nover.json        # UNSUPPORTED_STRUCTURE，退出码 2
```

## 报告内容

导出的 JSON 报告包含：清单标识（文件名、`lockfileVersion`、包计数、文件大小与 sha256）、
物化后的规则配置快照、检查时间（UTC 与本机带偏移时间、IANA 时区）、按严重级别/规则/主机的汇总、
每条发现的期望/实际/原始字段证据、依赖路径、`inconclusive` 待核实项、基线差异（含计数口径）、
以及检查边界声明。报告自身就是离线证据，可直接归档或交他人复核。

## 项目结构

```
bin/lock-audit.js         CLI 入口
src/core/                 纯逻辑层（解析/规则/SRI/依赖图/差异/报告），CLI 与 Web 共用
src/cli/                  命令行编排与文本输出
src/web/                  node:http 服务、API、静态文件防护
public/                   原生 HTML/CSS/JS 前端（无构建步骤）
examples/                 示例锁文件、规则、基线
test/                     node:test 测试（node --test test/*.test.js）
```

## 运行测试

```bash
node --test test/*.test.js
# 或
npm test
```
