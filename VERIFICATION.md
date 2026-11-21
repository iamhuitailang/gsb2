# 验证状态

本仓库的代码是完整的，但**本次会话中沙箱的安全分类器持续不可用**，任何解释器
命令（`python3`、`pytest`、`node`、`npm`）都被拒绝执行，报错为：

```
auto_model/urm is temporarily unavailable, so auto mode cannot determine the
safety of Bash right now.
```

因此以下命令**未能在本次会话中实际运行**，代码只经过了逐行静态审查。请在你自己的
环境中执行下面的命令完成验证。

## 后端测试

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 -m pytest
```

预期：全部通过。测试覆盖解析（IPv4/IPv6、端口、方括号、引号、空项、unknown、
格式错误、IPv4 映射 IPv6、Forwarded 语法）、配置校验（非法 CIDR、主机位、`/0`、
重复、冗余、单值字段上限、字段全禁用）、判定行为（可信链、伪造头、交叉核对、
顺序冲突、重复字段、重复跳、超长链、链条不完整、单值矛盾）以及 API 与导出脱敏。
每个内置演示都会对照其预期结论校验。

## 前端构建

```bash
cd frontend
npm install
npm run build        # 应无报错，产物在 dist/
```

## 手工冒烟

```bash
cd backend && python3 -m app           # http://127.0.0.1:8000
```

打开「演示请求」页，逐个运行 10 个样例，界面应显示「与预期一致」。
