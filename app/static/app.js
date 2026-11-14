const $ = (id) => document.getElementById(id);

function showMsg(el, kind, text) {
  el.hidden = false;
  el.className = `msg ${kind}`;
  el.textContent = text;
}

function clearMsg(el) {
  el.hidden = true;
  el.textContent = "";
}

// ---------- 导入 ----------
$("importBtn").addEventListener("click", async () => {
  const fileInput = $("fileInput");
  const msgEl = $("importMsg");
  if (!fileInput.files.length) {
    showMsg(msgEl, "warn", "请先选择一个 CSV 文件");
    return;
  }
  const form = new FormData();
  form.append("file", fileInput.files[0]);
  try {
    const resp = await fetch("/api/import", { method: "POST", body: form });
    const data = await resp.json();
    if (resp.ok) {
      const v = data.version;
      const replaced = v.replaced_version
        ? `\n已替换该业务日期的旧版本 v${v.replaced_version}，旧版仍保留在归档记录中。`
        : "";
      showMsg(
        msgEl,
        "ok",
        `导入成功：版本 v${v.version_id}，业务日期 ${v.biz_date}，` +
          `总人数 ${v.total_boardings}，${v.row_count} 行。${replaced}`
      );
      fileInput.value = "";
      await refreshRoutes();
      await refreshArchive();
    } else if (resp.status === 409) {
      const ev = data.detail.existing_version;
      showMsg(
        msgEl,
        "warn",
        `该文件与已有版本内容完全一致（sha256 相同），未重复入库。\n` +
          `已有版本：v${ev.version_id}，业务日期 ${ev.biz_date}，收到时间 ${ev.received_at}，` +
          `总人数 ${ev.total_boardings}。`
      );
    } else {
      showMsg(msgEl, "err", `导入失败：${data.detail || resp.statusText}`);
    }
  } catch (err) {
    showMsg(msgEl, "err", `请求失败：${err}`);
  }
});

// ---------- 查询 ----------
async function runQuery() {
  const msgEl = $("queryMsg");
  clearMsg(msgEl);
  const start = $("startDate").value;
  const end = $("endDate").value;
  const route = $("routeSelect").value;
  if (!start || !end) {
    showMsg(msgEl, "warn", "请选择开始和结束日期");
    return;
  }
  const params = new URLSearchParams({ start_date: start, end_date: end });
  if (route) params.set("route", route);
  try {
    const resp = await fetch(`/api/query?${params}`);
    const data = await resp.json();
    if (!resp.ok) {
      showMsg(msgEl, "err", `查询失败：${data.detail || resp.statusText}`);
      $("resultArea").hidden = true;
      return;
    }
    renderResult(data);
  } catch (err) {
    showMsg(msgEl, "err", `请求失败：${err}`);
  }
}

function renderResult(data) {
  $("resultArea").hidden = false;
  $("totalBoardings").textContent = data["总上车人数"];
  $("partitionCount").textContent = data["读取分区数"];
  $("readDates").innerHTML = data["读取日期"]
    .map((d) => `<li>${d}</li>`)
    .join("") || "<li>（区间内无数据）</li>";

  $("lineTbody").innerHTML =
    data["线路汇总"].map((r) => `<tr><td>${r["线路"]}</td><td class="num">${r["上车人数"]}</td></tr>`).join("") ||
    '<tr><td colspan="2">无数据</td></tr>';

  $("stationTbody").innerHTML =
    data["站点明细"]
      .map((r) => `<tr><td>${r["线路"]}</td><td>${r["站点"]}</td><td class="num">${r["上车人数"]}</td></tr>`)
      .join("") || '<tr><td colspan="3">无数据</td></tr>';
}

$("queryBtn").addEventListener("click", runQuery);

function exportCsv(level) {
  const start = $("startDate").value;
  const end = $("endDate").value;
  const route = $("routeSelect").value;
  if (!start || !end) {
    showMsg($("queryMsg"), "warn", "请先选择开始和结束日期");
    return;
  }
  const params = new URLSearchParams({ start_date: start, end_date: end, level });
  if (route) params.set("route", route);
  window.open(`/api/export?${params}`, "_blank");
}
$("exportStationBtn").addEventListener("click", () => exportCsv("station"));
$("exportLineBtn").addEventListener("click", () => exportCsv("line"));

// ---------- 线路下拉 ----------
async function refreshRoutes() {
  const resp = await fetch("/api/routes");
  const routes = await resp.json();
  const select = $("routeSelect");
  const current = select.value;
  select.innerHTML =
    '<option value="">全部线路</option>' +
    routes.map((r) => `<option value="${r}">${r}</option>`).join("");
  select.value = current;
}

// ---------- 归档记录 ----------
async function refreshArchive() {
  const bizDate = $("archiveDate").value;
  const params = new URLSearchParams();
  if (bizDate) params.set("biz_date", bizDate);
  const resp = await fetch(`/api/versions?${params}`);
  const versions = await resp.json();
  $("archiveTbody").innerHTML = versions
    .map((v) => {
      const status = v.is_current
        ? '<span class="badge current">当前生效</span>'
        : '<span class="badge old">已被替换</span>';
      return `<tr>
        <td>v${v.version_id}</td>
        <td>${v.biz_date}</td>
        <td>${v.received_at}</td>
        <td class="num">${v.total_boardings}</td>
        <td class="num">${v.row_count}</td>
        <td>${status}</td>
        <td>${v.replaces ? "v" + v.replaces : "—"}</td>
        <td><code>${v.checksum.slice(0, 12)}</code></td>
      </tr>`;
    })
    .join("") || '<tr><td colspan="8">暂无归档记录</td></tr>';
}
$("refreshArchiveBtn").addEventListener("click", refreshArchive);
$("archiveDate").addEventListener("change", refreshArchive);

// 初始化
refreshRoutes();
refreshArchive();
