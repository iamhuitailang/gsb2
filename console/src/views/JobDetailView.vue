<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api.js';
import { jobStatus, recordStatus } from '../status.js';

const props = defineProps({ jobId: Number });
const emit = defineEmits(['back']);

const data = ref(null); // { job, records, counts }
const logs = ref([]);
const error = ref('');
const busy = ref(false);
let eventSource = null;

const progressPct = computed(() => {
  if (!data.value) return 0;
  const c = data.value.counts;
  const done = c.success + c.skipped + c.failed;
  return data.value.job.total ? Math.round((done / data.value.job.total) * 100) : 0;
});

const canStart = computed(() =>
  data.value &&
  !data.value.job.running &&
  ['ready', 'interrupted', 'failed'].includes(data.value.job.status)
);

const canStop = computed(() => data.value?.job.running);

async function load() {
  try {
    data.value = await api.getJob(props.jobId);
    logs.value = await api.getLogs(props.jobId);
    error.value = '';
    // 任务仍在执行（例如页面刷新后）则重新挂 SSE
    if (data.value.job.running) subscribe();
  } catch (err) {
    error.value = err.message;
  }
}

function subscribe() {
  if (eventSource) return;
  eventSource = api.openEvents(props.jobId, {
    onJob: () => {},
    onRecord: (evt) => {
      data.value.counts = evt.counts;
      const rec = data.value.records.find((r) => r.id === evt.recordId);
      if (rec) {
        rec.status = evt.patch.status;
        rec.error = evt.patch.error ?? rec.error;
        rec.mock_ref = evt.patch.mockRef ?? rec.mock_ref;
        rec.screenshot = evt.patch.screenshot ?? rec.screenshot;
      }
    },
    onLog: (evt) => logs.value.push(evt),
    onEnd: (evt) => {
      data.value.job = evt.job;
      data.value.counts = evt.counts;
      data.value.job.running = false;
      eventSource?.close();
      eventSource = null;
    },
  });
}

async function start() {
  busy.value = true;
  error.value = '';
  try {
    const result = await api.startJob(props.jobId);
    if (result.nothingToDo) {
      await load();
      return;
    }
    data.value.job.status = 'running';
    data.value.job.running = true;
    subscribe();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function stop() {
  busy.value = true;
  try {
    await api.stopJob(props.jobId);
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString() : '';
}

onMounted(load);
onUnmounted(() => eventSource?.close());
</script>

<template>
  <button class="ghost sm" @click="emit('back')">← 返回任务列表</button>

  <div v-if="error" class="error-box" style="margin-top: 12px">{{ error }}</div>
  <div v-if="!data" class="muted" style="margin-top: 16px">加载中…</div>

  <template v-else>
    <div class="toolbar" style="margin: 14px 0 10px; justify-content: space-between">
      <div>
        <h1 class="page-title" style="display: inline; margin-right: 12px">
          任务 #{{ data.job.id }} · {{ data.job.name }}
        </h1>
        <span class="st" :class="jobStatus(data.job.status).cls">
          {{ data.job.running ? '执行中' : jobStatus(data.job.status).label }}
        </span>
        <a class="mock-link" href="/mock/" target="_blank" style="margin-left: 14px">
          在浏览器打开模拟业务网站 ↗
        </a>
      </div>
      <div class="toolbar">
        <button v-if="canStart" @click="start" :disabled="busy">
          {{ data.job.status === 'interrupted' || data.job.status === 'failed' ? '恢复未完成记录' : '开始执行' }}
        </button>
        <button v-if="canStop" class="danger" @click="stop" :disabled="busy">停止（执行完当前条后中断）</button>
      </div>
    </div>

    <!-- 重启恢复提示 -->
    <div v-if="data.job.status === 'interrupted'" class="banner warn">
      <span>⚠️</span>
      <div>
        该任务处于中断状态（可能由服务重启或手动停止导致）。已完成（{{ data.counts.success }}）与已跳过（{{ data.counts.skipped }}）的
        记录不会再次提交，点击「恢复未完成记录」将只处理待处理 / 中断 / 失败的记录。
      </div>
    </div>

    <div class="card">
      <h3>执行进度</h3>
      <div class="stat-row">
        <div class="stat"><div class="n">{{ data.job.total }}</div><div class="l">总记录</div></div>
        <div class="stat"><div class="n" style="color: var(--green)">{{ data.counts.success }}</div><div class="l">已完成</div></div>
        <div class="stat"><div class="n" style="color: var(--amber)">{{ data.counts.skipped }}</div><div class="l">跳过(重复)</div></div>
        <div class="stat"><div class="n" style="color: var(--red)">{{ data.counts.failed }}</div><div class="l">失败</div></div>
        <div class="stat"><div class="n" style="color: var(--blue)">{{ data.counts.running }}</div><div class="l">执行中</div></div>
        <div class="stat">
          <div class="n" style="color: var(--gray)">{{ data.counts.pending + data.counts.interrupted }}</div>
          <div class="l">待处理/中断</div>
        </div>
      </div>
      <div class="progress"><div :style="{ width: progressPct + '%' }"></div></div>
      <div class="progress-text">{{ progressPct }}% · 创建于 {{ new Date(data.job.created_at).toLocaleString() }}</div>
    </div>

    <div class="card">
      <h3>逐条处理状态</h3>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>CSV 行</th><th>申请编号</th><th>业务类型</th><th>申请人</th>
              <th>状态</th><th>尝试次数</th><th>受理号/结果</th><th class="wrap">错误信息</th><th>截图</th><th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.records" :key="r.id">
              <td>{{ r.row_no }}</td>
              <td class="mono">{{ r.application_no }}</td>
              <td>{{ r.payload.businessType }}</td>
              <td>{{ r.payload.applicantName }}</td>
              <td><span class="st" :class="recordStatus(r.status).cls">{{ recordStatus(r.status).label }}</span></td>
              <td>{{ r.attempts }}</td>
              <td class="mono">{{ r.mock_ref || '—' }}</td>
              <td class="detail-err">{{ r.error || '—' }}</td>
              <td>
                <a v-if="r.screenshot" :href="'/screenshots/' + r.screenshot.split('/').pop()" target="_blank">
                  查看
                </a>
                <span v-else class="muted">—</span>
              </td>
              <td class="mono">{{ fmtTime(r.updated_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>操作日志（手机号、身份证等个人字段已自动遮蔽）</h3>
      <div class="log-panel" ref="logBox">
        <div v-if="!logs.length" class="muted">暂无日志</div>
        <div v-for="l in logs" :key="l.id" class="log-line" :class="l.level">
          <span class="time">{{ fmtTime(l.created_at) }}</span>
          <span class="tag">[{{ l.event }}]</span> {{ l.message }}
        </div>
      </div>
    </div>
  </template>
</template>
