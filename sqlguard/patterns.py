"""污染源、汇聚点、净化与传播函数的模式定义。"""

# 汇聚点：数据库查询执行方法（按方法名匹配，覆盖 sqlite3 / DB-API /
# psycopg2 / pymysql / MySQLdb / SQLAlchemy session 等常见接口）
SINK_METHODS = {"execute", "executemany", "executescript", "raw"}

# 污染源：读取外部输入的调用
SOURCE_CALLS = {
    "input": "input() 读取的标准输入",
    "os.getenv": "os.getenv() 读取的环境变量",
    "os.environ.get": "os.environ.get() 读取的环境变量",
    "sys.stdin.read": "sys.stdin.read() 读取的标准输入",
    "sys.stdin.readline": "sys.stdin.readline() 读取的标准输入",
}

# 污染源：外部输入属性
SOURCE_ATTRS = {
    "sys.argv": "命令行参数 sys.argv",
    "os.environ": "环境变量 os.environ",
}

# Web 请求参数属性（request.args / request.GET / self.request.POST 等，
# 覆盖 Flask / Django / Tornado 等常见写法）
REQUEST_ATTRS = {
    "args", "form", "values", "GET", "POST", "data", "json",
    "cookies", "headers", "files", "META", "params", "query_params",
}

# 净化：转换为这些类型后不再构成注入风险
SANITIZERS = {"int", "float", "bool", "len", "abs", "round"}

# 确定性传播的调用（污点随返回值继续传播）
PROPAGATING_CALLS = {"str", "repr", "bytes", "chr", "format"}

# 确定性传播的方法
PROPAGATING_METHODS = {
    "upper", "lower", "strip", "lstrip", "rstrip", "replace", "join",
    "split", "rsplit", "title", "capitalize", "encode", "decode",
    "format", "zfill", "ljust", "rjust", "center", "partition",
    "removeprefix", "removesuffix",
}
