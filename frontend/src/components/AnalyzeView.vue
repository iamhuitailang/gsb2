<script setup>
import { computed } from 'vue'
import { FIELD_META, FIELD_ORDER } from '../api'
import ResultPanel from './ResultPanel.vue'

const props = defineProps({
  form: { type: Object, required: true },
  configs: { type: Array, default: () => [] },
  result: { type: Object, default: null },
  resultMeta: { type: Object, default: null },
  error: { type: Object, default: null },
  analyzing: { type: Boolean, default: false },
  notice: { type: String, default: '' },
  lastAnalysisId: { type: Number, default: null },
})

const emit = defineEmits(['update:form', 'submit', 'load-config', 'open-record', 'create-config'])

const fields = FIELD_ORDER

const headerErrorMessages = computed(() => {
  if (!props.error?.body?.errors) return []
  return props.error.body.errors.filter((item) =>
    String(item.field || '').startsWith('headers'),
  )
})

const configErrorMessages = computed(() => {
  if (!props.error?.body?.errors) return []
  return props.error.body.errors.filter(
    (item) => !String(item.field || '').startsWith('headers'),
  )
})

function updatePeer(value) {
  emit('update:form', { ...props.form, peer: value })
}

function updateHeaderLine(key, index, value) {
  const headers = { ...props.form.headers }
  const lines = [...(headers[key] || [''])]
  lines[index] = value
  headers[key] = lines
  emit('update:form', { ...props.form, headers })
}

function addHeaderLine(key) {
  const headers = { ...props.form.headers }
  headers[key] = [...(headers[key] || ['']), '']
  emit('update:form', { ...props.form, headers })
}

function removeHeaderLine(key, index) {
  const headers = { ...props.form.headers }
  const lines = [...(headers[key] || [''])]
  lines.splice(index, 1)
  headers[key] = lines.length ? lines : ['']
  emit('update:form', { ...props.form, headers })
}

function selectConfig(event) {
  const id = Number(event.target.value)
  const saved = props.configs.find((item) => item.id === id)
  if (saved) emit('load-config', saved)
}

function updateConfig(next) {
  emit('update:form', { ...props.form, configId: null, config: next })
}

function setConfigName(value) {
  const config = JSON.parse(JSON.stringify(props.form.config))
  config.name = value
  updateConfig(config)
}

function setConfigEntry(index, key, value) {
  const config = JSON.parse(JSON.stringify(props.form.config))
  config.entries[index][key] = value
  updateConfig(config)
}

function addConfigEntry() {
  const config = JSON.parse(JSON.stringify(props.form.config))
  config.entries.push({ value: '', label: '' })
  updateConfig(config)
}

function removeConfigEntry(index) {
  const config = JSON.parse(JSON.stringify(props.form.config))
  config.entries.splice(index, 1)
  updateConfig(config)
}

function setConfigEnabled(key, enabled) {
  const config = JSON.parse(JSON.stringify(props.form.config))
  config.fields[key].enabled = enabled
  updateConfig(config)
}

function setConfigMaxHops(key, value) {
  const config = JSON.parse(JSON.stringify(props.form.config))
  const number = Number(value)
  config.fields[key].max_hops = Number.isFinite(number) ? number : 0
  updateConfig(config)
}

const selectedConfigId = computed(() => props.form.configId ?? '')
</script>

<template>
  <div class="grid two">
    <section class="card">
      <div class="card-head">
        <h2>请求与信任配置</h2>
        <span class="hint">所有内容只在本机计算</span>
      </div>

      <div class="field">
        <label for="peer">连接对端地址</label>
        <input
          id="peer"
          :value="form.peer"
          placeholder="例如 10.0.0.5 或 [2001:db8::1]:443"
          autocomplete="off"
          spellcheck="false"
          @input="updatePeer($event.target.value)"
        />
        <p class="hint">
          这是服务器实际建立 TCP 连接的对端地址，不是请求头里的值。判定信任时只看它。
        </p>
      </div>

      <div class="field">
        <label>转发地址字段</label>
        <p class="hint" style="margin-bottom: 10px">
          同一个字段如果出现多次，请分别在多行填写；系统不会把它们拼接后继续判定。
        </p>
        <div v-for="key in fields" :key="key" class="field">
          <label :for="`header-${key}`" class="small">{{ FIELD_META[key].label }}</label>
          <div
            v-for="(line, index) in form.headers[key] || ['']"
            :key="`${key}-${index}`"
            style="display: flex; gap: 6px; margin-bottom: 6px"
          >
            <textarea
              v-if="FIELD_META[key].multiline"
              :id="index === 0 ? `header-${key}` : undefined"
              :value="line"
              :placeholder="index === 0 ? FIELD_META[key].placeholder : '再次出现的同一请求头（可选）'"
              rows="2"
              spellcheck="false"
              @input="updateHeaderLine(key, index, $event.target.value)"
            ></textarea>
            <input
              v-else
              :id="index === 0 ? `header-${key}` : undefined"
              :value="line"
              :placeholder="FIELD_META[key].placeholder"
              autocomplete="off"
              spellcheck="false"
              @input="updateHeaderLine(key, index, $event.target.value)"
            />
            <button
              v-if="index > 0"
              class="ghost"
              title="删除这一行"
              @click="removeHeaderLine(key, index)"
            >
              ×
            </button>
          </div>
          <div class="button-row">
            <button class="ghost small" @click="addHeaderLine(key)">
              + 增加一次出现
            </button>
            <span class="hint">{{ FIELD_META[key].hint }}</span>
          </div>
        </div>
      </div>

      <div class="field">
        <label for="config-select">信任配置</label>
        <select id="config-select" :value="selectedConfigId" @change="selectConfig">
          <option value="">（临时配置，未保存）</option>
          <option v-for="item in configs" :key="item.id" :value="item.id">
            {{ item.name }}（{{ item.config.entries.length }} 个可信条目）
          </option>
        </select>
        <p class="hint">
          选择已保存配置，或直接编辑下方临时配置；判定时会记录当时的配置快照。
        </p>
      </div>

      <details v-if="form.config" class="notice info" open>
        <summary style="cursor: pointer; font-weight: 600">临时配置（可直接修改）</summary>
        <div class="field" style="margin-top: 10px">
          <label for="inline-name">配置名称</label>
          <input
            id="inline-name"
            :value="form.config.name"
            maxlength="80"
            @input="setConfigName($event.target.value)"
          />
        </div>
        <div class="field">
          <label>可信代理地址 / 地址段</label>
          <div v-for="(entry, index) in form.config.entries" :key="index" class="entry-row">
            <input
              :value="entry.value"
              placeholder="10.0.0.0/8 或 192.0.2.10"
              autocomplete="off"
              spellcheck="false"
              @input="setConfigEntry(index, 'value', $event.target.value)"
            />
            <input
              :value="entry.label || ''"
              placeholder="可选标签"
              maxlength="60"
              @input="setConfigEntry(index, 'label', $event.target.value)"
            />
            <button
              class="ghost danger"
              title="删除"
              :disabled="form.config.entries.length <= 1"
              @click="removeConfigEntry(index)"
            >
              删除
            </button>
          </div>
          <button class="ghost small" @click="addConfigEntry">+ 添加可信地址</button>
        </div>
        <div class="field" style="margin-bottom: 0">
          <label>允许参考的转发字段</label>
          <div v-for="key in fields" :key="key" class="field-policy" :class="{ disabled: !form.config.fields[key].enabled }">
            <div>
              <div class="name">{{ FIELD_META[key].label }}</div>
              <div class="note">{{ FIELD_META[key].hint }}</div>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                :checked="form.config.fields[key].enabled"
                @change="setConfigEnabled(key, $event.target.checked)"
              />
              启用
            </label>
            <div>
              <label :for="`inline-hops-${key}`" class="small">最大跳数</label>
              <input
                :id="`inline-hops-${key}`"
                type="number"
                min="1"
                max="10"
                :value="form.config.fields[key].max_hops"
                @input="setConfigMaxHops(key, $event.target.value)"
              />
            </div>
          </div>
        </div>
      </details>
      <div v-else class="notice warn">
        还没有可用的信任配置。可以先到「信任配置」页保存一份再开始判定。
        <button class="ghost small" style="margin-left: 8px" @click="emit('create-config')">
          新建临时配置
        </button>
      </div>

      <div class="button-row" style="margin-top: 14px">
        <button class="primary" :disabled="analyzing || !form.config" @click="emit('submit')">
          {{ analyzing ? '正在判定…' : '开始判定' }}
        </button>
        <span v-if="notice" class="badge ok">{{ notice }}</span>
        <span v-if="lastAnalysisId" class="muted small">记录 #{{ lastAnalysisId }}</span>
      </div>

      <div v-if="error" class="notice error" style="margin-top: 12px">
        <strong>{{ error.message }}</strong>
        <ul v-if="headerErrorMessages.length" style="margin-top: 6px">
          <li v-for="(item, index) in headerErrorMessages" :key="`h-${index}`">
            {{ item.field }}：{{ item.message }}
          </li>
        </ul>
        <ul v-if="configErrorMessages.length">
          <li v-for="(item, index) in configErrorMessages" :key="`c-${index}`">
            {{ item.field }}：{{ item.message }}
          </li>
        </ul>
      </div>
    </section>

    <section class="card">
      <ResultPanel :result="result" :meta="resultMeta" @open-record="emit('open-record', $event)" />
    </section>
  </div>
</template>
