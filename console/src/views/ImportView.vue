<script setup>
import { ref } from 'vue';
import { api } from '../api.js';
import { jobStatus, recordStatus } from '../status.js';

const emit = defineEmits(['imported']);

const dragging = ref(false);
const uploading = ref(false);
const error = ref('');
const importResult = ref(null); // { job, records, counts, validationErrors }
const confirming = ref(false);

async function handleFile(file) {
  if (!file) return;
  if (!/\.csv$/i.test(file.name)) {
    error.value = '请选择 .csv 文件';
    return;
  }
  uploading.value = true;
  error.value = '';
  importResult.value = null;
  try {
    importResult.value = await api.importCsv(file);
  } catch (err) {
    error.value = err.message;
  } finally {
    uploading.value = false;
  }
}

function onPick(e) {
  handleFile(e.target.files[0]);
}
function onDrop(e) {
  dragging.value = false;
  handleFile(e.dataTransfer.files[0]);
}

async function confirmPreview() {
  confirming.value = true;
  try {
    await api.confirmJob(importResult.value.job.id);
    emit('imported', importResult.value.job.id);
  } catch (err) {
    error.value = err.message;
  } finally {
    confirming.value = false;
  }
}

function reset() {
  importResult.value = null;
  error.value = '';
}
</script>

<template>
  <h1 class="page-title">导入申请 CSV</h1>
  <p class="page-sub">
    导入后仅生成预览，不会执行任何自动化操作；确认无误后任务才进入就绪状态。
    字段模板见仓库 <span class="mono">samples/demo-applications.csv</span>。
  </p>

  <div v-if="!importResult" class="card">
    <label
      class="dropzone"
      :class="{ drag: dragging }"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input type="file" accept=".csv" @change="onPick" />
      <div class="big">{{ uploading ? '正在解析上传…' : '点击选择 或 拖拽 CSV 到此处' }}</div>
      <div class="hint">仅支持 UTF-8 编码 CSV，单文件 ≤ 5MB，全部解析在本机完成</div>
    </label>
    <div v-if="error" class="error-box" style="margin-top: 14px">{{ error }}</div>
  </div>

  <template v-else>
    <div class="banner info">
      <span>📋</span>
      <div>
        预览任务 #{{ importResult.job.id }}（来源：{{ importResult.job.source_file }}），
        共 <b>{{ importResult.records.length }}</b> 条有效记录，当前状态：
        <span class="st" :class="jobStatus(importResult.job.status).cls">
          {{ jobStatus(importResult.job.status).label }}
        </span>
      </div>
    </div>

    <div v-if="importResult.validationErrors?.length" class="error-box">
      <b>{{ importResult.validationErrors.length }} 行校验未通过，已被排除（不会录入）：</b>
      <ul>
        <li v-for="(e, i) in importResult.validationErrors" :key="i">
          第 {{ e.rowNo }} 行（{{ e.applicationNo }}）：{{ e.messages.join('；') }}
        </li>
      </ul>
    </div>

    <div class="card">
      <h3>记录预览（个人信息仅在本机界面展示，操作日志将自动遮蔽）</h3>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>CSV 行</th><th>申请编号</th><th>业务类型</th><th>申请人</th>
              <th>手机号</th><th>身份证号</th><th>邮箱</th><th>金额(元)</th>
              <th>城市</th><th>详细住址</th><th>银行账号</th><th class="wrap">申请说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in importResult.records" :key="r.id">
              <td>{{ r.row_no }}</td>
              <td class="mono">{{ r.payload.applicationNo }}</td>
              <td>{{ r.payload.businessType }}</td>
              <td>{{ r.payload.applicantName }}</td>
              <td class="mono">{{ r.payload.phone }}</td>
              <td class="mono">{{ r.payload.idCard }}</td>
              <td>{{ r.payload.email }}</td>
              <td>{{ r.payload.amount }}</td>
              <td>{{ r.payload.city }}</td>
              <td>{{ r.payload.address }}</td>
              <td class="mono">{{ r.payload.bankAccount }}</td>
              <td class="wrap">{{ r.payload.remark || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="toolbar" style="margin-top: 16px">
        <button @click="confirmPreview" :disabled="confirming">
          {{ confirming ? '确认中…' : '确认预览，进入任务' }}
        </button>
        <button class="ghost" @click="reset">重新上传</button>
        <span class="muted" style="font-size: 12px">
          确认后仍需在任务页手动点击「开始执行」，不会自动录入
        </span>
      </div>
    </div>
  </template>
</template>
