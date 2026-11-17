/**
 * 主管页面：授权管理 + 服务端正式检查单。
 * 本页不读取检查员的断网开关，始终直接访问服务端。
 */
import { apiFetch, toast, formatTime } from './common.js';

const RESULT_LABEL = { pass: '合格', fail: '不合格', 'n/a': '不适用' };
let busy = false;

async function loadState() {
  const state = await apiFetch('/api/admin/state');
  renderGrants(state);
  renderRecords(state.records);
}

function renderGrants(state) {
  const body = document.getElementById('permBody');
  const rows = [];
  for (const employee of state.employees) {
    for (const perm of employee.permissions) {
      rows.push(`
        <tr>
          <td>${employee.name}</td>
          <td>${perm.checkpointName}</td>
          <td>${
            perm.granted
              ? '<span class="badge ok">已授权</span>'
              : '<span class="badge no">已撤销</span>'
          }</td>
          <td>
            <button
              class="${perm.granted ? 'ghost' : 'secondary'} small"
              data-employee="${employee.id}"
              data-cp="${perm.checkpointId}"
              data-granted="${perm.granted ? '0' : '1'}"
              ${busy ? 'disabled' : ''}>
              ${perm.granted ? '撤销授权' : '恢复授权'}
            </button>
          </td>
        </tr>`);
    }
  }
  body.innerHTML = rows.join('');

  body.querySelectorAll('button[data-employee]').forEach((btn) => {
    btn.addEventListener('click', () =>
      setGrant(btn.dataset.employee, btn.dataset.cp, btn.dataset.granted === '1')
    );
  });
}

async function setGrant(employeeId, checkpointId, granted) {
  busy = true;
  try {
    await apiFetch('/api/admin/grants', {
      method: 'POST',
      body: JSON.stringify({ employeeId, checkpointId, granted }),
    });
    toast(granted ? '授权已恢复，检查员下次同步即可提交' : '授权已撤销，检查员的相关草稿同步时将被拦下', granted ? 'success' : 'error');
    await loadState();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    busy = false;
  }
}

function renderRecords(records) {
  const body = document.getElementById('recordsBody');
  if (!records.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">还没有正式检查单入库</td></tr>`;
    return;
  }
  body.innerHTML = records
    .map(
      (r, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${r.checkpointName}</td>
        <td>${r.employeeId}</td>
        <td><span class="badge ${r.result === 'fail' ? 'no' : 'ok'}">${RESULT_LABEL[r.result]}</span></td>
        <td style="max-width:320px">${r.note}</td>
        <td class="small">${formatTime(r.submittedAt)}</td>
        <td><code class="mono">${r.draftId.slice(0, 8)}</code></td>
      </tr>`
    )
    .join('');
}

document.getElementById('resetBtn').addEventListener('click', async () => {
  if (!window.confirm('重置服务端全部演示数据（授权恢复初始、正式检查单清空）？')) return;
  await apiFetch('/api/admin/reset', { method: 'POST' });
  toast('服务端数据已重置（检查员本机队列不受影响，可在其页面清除）', 'success');
  await loadState();
});

loadState().catch((err) => toast(err.message, 'error'));
// 主管端轮询：检查员入库后这里自动刷新
setInterval(() => loadState().catch(() => {}), 2500);
