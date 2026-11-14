# 公交刷卡汇总 · Parquet 归档查询

把每天导出的刷卡汇总明细 CSV 按**业务日期**归档成 Parquet，并通过网页查询一段时间内各线路、各站点的上车人数。支持修订版替换当天数据、同文件重传去重、归档留痕和查询结果导出。

## 功能与设计要点

- **按业务日期分区入库**：Parquet Hive 分区 `active/biz_date=YYYY-MM-DD/part.parquet`，查询单日时 pyarrow 只扫描当天分区，页面可展开查看**本次实际读取了哪些日期**。
- **修订版替换**：同一天导入内容不同的新文件后，当天 active 分区被原子替换；再查询时该天只算新版本，其他日期不受影响。
- **旧版留痕**：每次收到的文件（原始 CSV + 不可变 Parquet）保存在 `archive/version_N/`，SQLite（`registry.db`）登记业务日期、收到时间、总人数、行数、sha256 校验和、当前/已替换状态及替换关系。
- **同文件重传去重**：按文件内容 sha256 判断，同一天同一份文件重传时接口返回 409，页面直接指出已有的版本号和收到时间，不重复入库。
- **逐份导入 / 线路汇总 / 导出**：网页逐份上传 CSV；查询结果含线路汇总与线路×站点明细，可分别导出 CSV（带 BOM，Excel 可直接打开）。

### 目录结构

```
app/
  main.py              FastAPI 接口与页面
  storage.py           CSV 解析、Parquet 归档、分区裁剪查询、版本登记
  static/              单页前端（原生 HTML/JS/CSS）
scripts/
  generate_sample_data.py   虚构样例数据生成脚本
sample_data/           三天明细 + 一天修订版（生成产物，已入库可直接演示）
tests/                 端到端测试
data/                  运行时数据（registry.db / archive / active，首次运行自动创建）
```

## 一、启动方法

### 方式 A：本地 Python（需 Python 3.11+）

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 生成三天虚构明细（含 2026-11-11 修订版）
python scripts/generate_sample_data.py

# 启动服务
uvicorn app.main:app --reload --port 8000
```

浏览器打开 <http://localhost:8000> 。数据默认写入仓库下 `data/`，可用环境变量 `BUS_DATA_DIR` 改到其他位置。

### 方式 B：Docker

```bash
docker build -t bus-boardings .
docker run --rm -p 8000:8000 -v "$PWD/data:/data" bus-boardings
```

容器内数据目录固定为 `/data`（由 `BUS_DATA_DIR` 指定），挂载卷后归档数据在容器重建后仍然保留。也可以用 compose：

```bash
docker compose up --build
```

## 二、导入方法

### 网页逐份导入（推荐演示路径）

1. 打开 <http://localhost:8000>，在「① 逐份导入 CSV」选择 `sample_data/` 下的文件，逐份点击**导入该文件**。建议顺序：
   - `boardings_2026-11-10.csv`
   - `boardings_2026-11-11.csv`（初版）
   - `boardings_2026-11-12.csv`
   - `boardings_2026-11-11_revised.csv`（修订版，自动替换 11 日数据，初版留在归档记录）
2. 导入成功后页面提示版本号、业务日期、总人数；若重复上传同内容文件，页面提示已存在的版本，不产生新版本。
3. 「③ 归档记录」可看到每个版本的收到时间、总人数、当前生效/已被替换状态。

CSV 必需列（表头名需完全一致，支持 UTF-8 带 BOM 或 GBK 编码）：

| 业务日期 | 线路 | 站点 | 时段 | 人数 |
|---|---|---|---|---|
| 2026-11-10 | 1路 | 火车站 | 早高峰 | 120 |

约束：一份文件只能包含一个业务日期，日期格式 `YYYY-MM-DD`，人数为非负整数。

### 命令行导入（可选）

```bash
# 一键导入 sample_data 全部文件（含修订版，并演示一次重传去重），服务需先启动
.venv/bin/python scripts/load_sample_data.py

# 或单独导入某一份
curl -s -X POST http://localhost:8000/api/import \
  -F "file=@sample_data/boardings_2026-11-10.csv"
```

## 三、查询与导出

- 在「② 查询上车人数」选择日期区间（可按线路过滤），点击查询。
- 结果顶部显示总上车人数；展开「本次实际读取了哪些日期」可看到命中的分区列表——单日查询只有一个分区。
- 下方分别给出各线路汇总、线路×站点明细。
- 点击**导出站点明细 CSV / 导出线路汇总 CSV**下载当前查询条件对应的结果。
- 接口直连示例：

```bash
curl "http://localhost:8000/api/query?start_date=2026-11-10&end_date=2026-11-12"
curl "http://localhost:8000/api/export?start_date=2026-11-10&end_date=2026-11-12&level=line" -o line.csv
```

## 四、验证修订与去重场景

1. 先导入 `boardings_2026-11-11.csv`，查询 11 日记录总人数；再导入 `boardings_2026-11-11_revised.csv`。
2. 重新查询 11 日：总人数变为修订版数值，读取分区仍只有 11 日一个；10 日、12 日结果不变。
3. 归档记录中 11 日有两个版本：初版标记「已被替换」，修订版标记「当前生效」，两者的收到时间、总人数、校验和均可查看。
4. 再次选择任意已导入文件上传：页面提示「该文件与已有版本内容完全一致，未重复入库」并给出已有版本号。

## 五、测试

```bash
.venv/bin/pytest -q
```

覆盖：导入建分区、同文件重传 409、修订版替换且不影响其他日期、单日查询分区裁剪、区间/线路过滤、CSV 导出、非法文件拒绝。
