#!/bin/zsh
# 验收走查（需要服务已在 127.0.0.1:8911 运行，数据库为种子状态）：
# 1. 甲、乙两个管理员会话同时点退出，只允许一人成功
# 2. 被拦截者仍能打开管理页，把丙升为管理员后自己退出成功
# 3. 乙方机构名单保持原样
set -u
BASE=http://127.0.0.1:8911
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

login() { # $1=用户名 $2=cookie 文件
  curl -s -c "$2" -o /dev/null -d "username=$1&password=pass1234" "$BASE/login"
}

# POST 后只取首个 303 的 Location（不跟随，避免 curl 把重定向再发成 POST）
post_once() { # $1=cookie $2=路径 -> 输出 Location
  curl -s -b "$1" -c "$1" -o /dev/null -D - -X POST "$BASE$2" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="location"{print $2}'
}

get_body() { # $1=cookie $2=路径 $3=输出文件
  curl -s -b "$1" -c "$1" -o "$3" -w "%{http_code}" "$BASE$2"
}

flash() { # 从 HTML 中提取 flash 文案
  grep -o '<div class="flash [^"]*">.*</div>' "$1" | sed 's/<[^>]*>//g' | head -1
}

echo "== 1. 甲、乙分别登录 =="
login jia "$TMP/jia.jar"
login yi  "$TMP/yi.jar"
get_body "$TMP/jia.jar" /orgs/1 "$TMP/page_before.html" > /dev/null
grep -o '当前有效管理员 <strong>[0-9]*</strong> 名' "$TMP/page_before.html"

echo "== 2. 两人同时提交退出 =="
post_once "$TMP/jia.jar" /orgs/1/leave > "$TMP/jia_loc.txt" &
post_once "$TMP/yi.jar"  /orgs/1/leave > "$TMP/yi_loc.txt" &
wait
JIA_LOC=$(cat "$TMP/jia_loc.txt"); YI_LOC=$(cat "$TMP/yi_loc.txt")
echo "甲 -> $JIA_LOC"
echo "乙 -> $YI_LOC"

# 拉取各自重定向落地页的提示
get_body "$TMP/jia.jar" "$JIA_LOC" "$TMP/jia_res.html" > /dev/null
get_body "$TMP/yi.jar"  "$YI_LOC"  "$TMP/yi_res.html"  > /dev/null
echo "-- 甲的页面提示: $(flash "$TMP/jia_res.html")"
echo "-- 乙的页面提示: $(flash "$TMP/yi_res.html")"

case "$JIA_LOC" in *"/orgs/1"*) SURVIVOR="$TMP/jia.jar"; SURVIVOR_NAME=甲;; *) SURVIVOR="$TMP/yi.jar"; SURVIVOR_NAME=乙;; esac
echo "== 3. 被拦截者（$SURVIVOR_NAME）仍能打开管理页 =="
code=$(get_body "$SURVIVOR" /orgs/1 "$TMP/survivor_page.html")
echo "管理页 HTTP $code，含成员管理标题: $(grep -c '成员管理' "$TMP/survivor_page.html")"
grep -o '当前有效管理员 <strong>[0-9]*</strong> 名' "$TMP/survivor_page.html"

echo "== 4. $SURVIVOR_NAME 把丙(uid=3)升为管理员 =="
loc=$(post_once "$SURVIVOR" /orgs/1/members/3/promote)
get_body "$SURVIVOR" "$loc" "$TMP/promote.html" > /dev/null
echo "提示: $(flash "$TMP/promote.html")"

echo "== 5. $SURVIVOR_NAME 自己退出 =="
loc=$(post_once "$SURVIVOR" /orgs/1/leave)
get_body "$SURVIVOR" "$loc" "$TMP/leave2.html" > /dev/null
echo "落地页: $loc"
echo "提示: $(flash "$TMP/leave2.html")"

echo "== 6. 丙登录查看机构 A 最终成员与操作记录 =="
login bing "$TMP/bing.jar"
get_body "$TMP/bing.jar" /orgs/1 "$TMP/final.html" > /dev/null
grep -o '<tr><td>[^|]*<div class=.muted.>[^<]*</div></td>.*</tr>' "$TMP/final.html" \
  | sed 's/<[^>]*>/ /g' | tr -s ' '
grep -o '当前有效管理员 <strong>[0-9]*</strong> 名' "$TMP/final.html"
get_body "$TMP/bing.jar" /orgs/1/audit "$TMP/audit.html" > /dev/null
echo "-- 操作记录（时间/操作者/动作/对象/结果/详情）:"
python3 - "$TMP/audit.html" <<'PY'
import re, sys, html
body = open(sys.argv[1], encoding="utf-8").read()
for tr in re.findall(r"<tr><td>(.*?)</td></tr>", body, re.S):
    cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<td>(.*?)</td>", tr, re.S)]
    if cells:
        print(" | ".join(cells))
PY

echo "== 7. 乙方机构名单保持原样 =="
login ding "$TMP/ding.jar"
get_body "$TMP/ding.jar" /orgs/2 "$TMP/org2.html" > /dev/null
grep -o '当前有效管理员 <strong>[0-9]*</strong> 名' "$TMP/org2.html"
grep -o '<tr><td>[丁戊].*</tr>' "$TMP/org2.html" | sed 's/<[^>]*>/ /g' | tr -s ' '
