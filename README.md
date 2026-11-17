# certverify — 本地离线证书链校验工具

一个纯 Go 实现的**离线** X.509 证书链校验命令行工具。它只信任调用方显式
提供的信任根，不访问网络、不读取或修改操作系统证书库，也从不在输出中包含
任何私钥内容。

工具回答的问题是：在**指定时间、目标主机名和用途**下，给定的一组叶子证书
能否经由提供的中间证书连接到提供的信任根；如果不能，逐项说明被拒绝的原因和
触发判断的证书。

## 为什么是自己实现路径校验

标准库 `x509.Verify` 只能给出一个聚合错误，且会强制套用 Go 自身的算法淘汰
策略（例如直接拒绝验证 SHA-1 链）。本工具把校验拆成可解释的独立步骤：

- 路径构建（DFS 枚举候选链，记录每条失败路径的原因）
- 逐跳签名数学验证、CA/basic constraints、keyCertSign、路径长度
- 有效期、算法与密钥强度策略
- 主机名（SAN 优先，CN 仅在无 SAN 且显式允许时使用）
- 叶子 KeyUsage / ExtKeyUsage 与中间证书 EKU 嵌套

签名的“数学是否成立”与“算法是否达标”被刻意分开：前者用底层
`Certificate.CheckSignature` 验证，后者由本工具自己的策略层裁决，因此一条
SHA-1 链仍能被构建出来，再由策略层精确拒绝，而不是得到一个含糊的库错误。

## 目录结构

```
cmd/certverify/        CLI 入口与退出码
cmd/gencerts/          确定性生成演示证书（离线、非敏感）
internal/certload/     PEM/DER 读取、多证书解析、去重、损坏诊断
internal/chain/        证书路径构建、签发关系、签名、CA、路径长度
internal/sigverify/    纯密码学签名验证（不含算法策略）
internal/policy/       算法与密钥强度安全边界
internal/hostname/     RFC 6125 风格主机名/SAN/CN 判定
internal/verify/       编排全部检查，生成逐项结果
internal/report/       稳定的 JSON 结果类型
internal/render/       人读文本输出
internal/testca/       确定性内存证书工厂（测试与演示用）
```

## 构建与测试

```bash
go build ./...
go test ./...          # 全部测试离线运行，不访问网络
go vet ./...
```

## 生成演示材料

演示证书不入库（被 `.gitignore` 忽略），用确定性生成器随时重建，内容均为
本地生成的非敏感测试证书：

```bash
go run ./cmd/gencerts          # 写入 demo/certs/
```

## 命令行用法

```bash
go run ./cmd/certverify \
  --root demo/certs/root.pem \
  --intermediate demo/certs/intermediate.pem \
  --leaf demo/certs/leaf-good.pem \
  --hostname demo.example \
  --purpose serverauth \
  --time 2026-06-01T12:00:00Z \
  --format text
```

主要参数：

| 参数 | 说明 |
| --- | --- |
| `--leaf` | 叶子证书文件，可重复；文件内可含多个 PEM 证书 |
| `--intermediate` | 中间证书文件，可重复 |
| `--root` | 信任根文件，可重复，**必填**；系统证书库永不被使用 |
| `--hostname` | 目标 DNS 名或 IP；不提供则跳过主机名校验 |
| `--purpose` | `serverauth,clientauth,codesigning,email,all`，可逗号组合 |
| `--time` | 校验时刻，RFC3339 或 `YYYY-MM-DD`，默认当前时间 |
| `--format` | `text`（默认）或 `json` |
| `--output` | 输出到文件而非 stdout |
| `--allow-legacy-cn` | 仅对无 SAN 扩展的证书允许回退到 Common Name |
| `--min-rsa-bits` / `--min-ecdsa-bits` | 调整密钥强度边界 |
| `--allow-sha1` | 放开 SHA-1 签名算法限制（默认拒绝） |

### 退出码（刻意区分，校验失败不算工具崩溃）

| 码 | 含义 |
| --- | --- |
| 0 | 所有叶子均通过，最终决定 TRUSTED |
| 2 | 命令行参数/用法错误 |
| 3 | 文件读取失败（不存在、无权限等） |
| 4 | 证书输入不可用（空文件、PEM 损坏、解析失败） |
| 5 | 校验完成但证书被拒绝（不可信、主机名/时间/用途/算法等） |
| 6 | 工具内部错误 |

## 主机名判定规则

- 存在 SAN 扩展时**只看 SAN**，绝不回退到 Common Name（即使 CN 恰好匹配）。
- 无 SAN 扩展时，默认拒绝；仅在显式 `--allow-legacy-cn` 下才使用 CN。
- 通配符只匹配最左的**单个**标签（`*.example.com` 匹配 `a.example.com`，
  不匹配 `a.b.example.com`）。
- 目标为 IP 时只与 iPAddress SAN 比较，绝不使用 CN 或 DNS 名。

## 安全边界（默认值，结果中会回显）

- RSA 密钥至少 2048 位，ECDSA 曲线至少 256 位（P-256）。
- 拒绝 MD2/MD5/SHA-1 等弱签名算法与 DSA 密钥类型。
- 边界作用于**整条链的每张证书**，失败结果会点名具体证书与具体规则。

## 输出稳定性

JSON 字段顺序由结构体固定；叶子按指纹排序、链按“最短优先 + 指纹字典序”
确定性选择、检查顺序固定、告警排序输出。因此输入文件或参数顺序变化不会
产生无意义的输出抖动，重复运行结果字节一致。

## 演示场景（均在固定时间 2026-06-01）

```bash
C=demo/certs
VT="--time 2026-06-01T12:00:00Z"

# 可信链 → 0
go run ./cmd/certverify --root $C/root.pem --intermediate $C/intermediate.pem \
  --leaf $C/leaf-good.pem --hostname demo.example $VT

# 信任根不匹配 → 5
go run ./cmd/certverify --root $C/root-untrusted.pem --intermediate $C/intermediate.pem \
  --leaf $C/leaf-good.pem $VT

# 主机名错误 → 5
go run ./cmd/certverify --root $C/root.pem --intermediate $C/intermediate.pem \
  --leaf $C/leaf-good.pem --hostname evil.example $VT

# 证书过期 → 5
go run ./cmd/certverify --root $C/root.pem --intermediate $C/intermediate.pem \
  --leaf $C/leaf-expired.pem --hostname expired.demo.example $VT

# 用途不匹配（叶子仅 clientAuth，却要求 serverAuth）→ 5
go run ./cmd/certverify --root $C/root.pem --intermediate $C/intermediate.pem \
  --leaf $C/leaf-client-only.pem --hostname client.demo.example --purpose serverauth $VT

# 非 CA 实体签发 → 5
go run ./cmd/certverify --root $C/root.pem --intermediate $C/nonca-issuer.pem \
  --leaf $C/leaf-nonca-issuer.pem --hostname rogue.demo.example $VT

# 弱密钥信任根（RSA-1024）→ 5
go run ./cmd/certverify --root $C/root-weak-1024.pem \
  --leaf $C/leaf-weak-root.pem --hostname weak.demo.example $VT

# SHA-1 信任根 → 5（放开 --allow-sha1 后同一条链可通过）
go run ./cmd/certverify --root $C/root-sha1.pem \
  --leaf $C/leaf-sha1.pem --hostname sha1.demo.example $VT
```

## 测试覆盖

`go test ./...` 覆盖：可信与不可信链、缺失中间证书、错误主机名（含通配符与
SAN/CN 规则）、有效期时间边界（notBefore/notAfter 的临界秒）、用途不匹配、
非 CA 签发者、路径长度约束、损坏/缺失/多证书输入、弱密钥与弱哈希算法、
确定性与输入顺序稳定性，以及全部 CLI 退出码。所有测试均使用内存中确定性
生成的证书，不发生任何网络访问。
