<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { api, emptyConfig, FIELD_META, FIELD_ORDER } from '../api'

const props = defineProps({
  configs: { type: Array, default: () => [] },
})

const emit = defineEmits(['saved', 'use-config', 'go-analyze'])

const draft = ref(emptyConfig())
const selectedId = ref(null)
const errors = ref([])
const warnings = ref([])
const message = ref('')
const messageKind = ref('info')
const saving = ref(false)
const validating = ref(false)
const lastFingerprint = ref('')

const list = computed(() => props.configs)

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function newConfig() {
  draft.value = emptyConfig()
  selectedId.value = null
  errors.value = []
  warnings.value = []
  message.value = ''
  lastFingerprint.value = ''
}

function editSaved(saved) {
  draft.value = clone(saved.config)
  selectedId.value = saved.id
  errors.value = []
  warnings.value = []
  message.value = ''
  lastFingerprint.value = saved.fingerprint || ''
}

function addEntry() {
  draft.value.entries.push({ value: '', label: '' })
}

function removeEntry(index) {
  draft.value.entries.splice(index, 1)
}

function fieldEnabled(key) {
  return draft.value.fields[key].enabled
}

function setEnabled(key, value) {
  draft.value.fields[key].enabled = value
}

function setMaxHops(key, value) {
  const number = Number(value)
  draft.value.fields[key].max_hops = Number.isFinite(number) ? number : 0
}

function buildPayload() {
  return {
    name: draft.value.name,
    entries: draft.value.entries.map((entry) => ({
      value: String(entry.value || '').trim(),
      label: String(entry.label || '').trim() || null,
    })),
    fields: Object.fromEntries(
      FIELD_ORDER.map((key) => [
        key,
        {
          enabled: Boolean(draft.value.fields[key].enabled),
          max_hops: Number(draft.value.fields[key].max_hops),
        },
      ]),
    ),
  }
}

async function validate() {
  validating.value = true
  errors.value = []
  warnings.value = []
  message.value = ''
  try {
    const body = await api.validateConfig(buildPayload())
    errors.value = body.errors || []
    warnings.value = body.warnings || []
    if (body.valid) {
      messageKind.value = 'ok'
      message.value = '配置可保存。'
      lastFingerprint.value = body.fingerprint || ''
    } else {
      messageKind.value = 'error'
      message.value = '配置不合法，不会按默认值继续。'
    }
  } catch (err) {
    messageKind.value = 'error'
    message.value = err.message
  } finally {
    validating.value = false
  }
}

async function save() {
  saving.value = true
  errors.value = []
  warnings.value = []
  message.value = ''
  try {
    const body = await api.saveConfig(buildPayload(), selectedId.value)
    selectedId.value = body.id
    lastFingerprint.value = body.fingerprint
    draft.value = clone(body.config)
    messageKind.value = 'ok'
    message.value = `配置已保存（#${body.id}）。`
    emit('saved')
  } catch (err) {
    messageKind.value = 'error'
    message.value = err.message
    if (err.body?.errors) errors.value = err.body.errors
    if (err.body?.warnings) warnings.value = err.body.warnings
  } finally {
    saving.value = false
  }
}

function useSaved(saved) {
  emit('use-config', saved)
  emit('go-analyze')
}

async function remove(saved) {
  if (!window.confirm(`确定删除配置「${saved.name}」？已保存的分析记录不受影响。`)) {
    return
  }
  try {
    await api.deleteConfig(saved.id)
    if (selectedId.value === saved.id) newConfig()
    emit('saved')
  } catch (err) {
    messageKind.value = 'error'
    message.value = err.message
  }
}

watch(
  () => props.configs,
  (items) => {
    if (!selectedId.value && items.length && !draft.value.entries.some((e) => e.value)) {
      editSaved(items[0])
    }
  },
)

onMounted(() => {
  if (props.configs.length) editSaved(props.configs[0])
})
</script>

<template>
  <div class="grid two">
    <section class="card">
      <div class="card-head">
        <h2>信任配置</h2>
        <div class="button-row">
          <button class="ghost" @click="newConfig">新建</button>
          <button :disabled="validating" @click="validate">
            {{ validating ? '校验中…' : '校验' }}
          </button>
          <button class="primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : selectedId ? '保存修改' : '保存配置' }}
          </button>
        </div>
      </div>

      <div class="field">
        <label for="config-name">配置名称</label>
        <input id="config-name" v-model="draft.name" maxlength="80" />
      </div>

      <div class="field">
        <label>可信代理地址 / 地址段</label>
        <p class="hint" style="margin-bottom: 8px">
          接受裸 IPv4、IPv6 或 CIDR。带端口、方括号、引号、区域标识的写法会被拒绝；
          网段主机位不为零时也不会被悄悄改写。
        </p>
        <div v-for="(entry, index) in draft.entries" :key="index" class="entry-row">
          <input
            v-model="entry.value"
            placeholder="10.0.0.0/8 或 2001:db8::/32 或 192.0.2.10"
            autocomplete="off"
            spellcheck="false"
          />
          <input v-model="entry.label" placeholder="可选标签，如：内网代理" maxlength="60" />
          <button class="ghost danger" title="删除" @click="removeEntry(index)">删除</button>
        </div>
        <button class="ghost" @click="addEntry">+ 添加可信地址</button>
      </div>

      <div class="field">
        <label>允许参考的转发字段</label>
        <p class="hint" style="margin-bottom: 8px">
          只有启用的字段会被读取。单值字段最多只能表示一跳，链路长度上限必须为 1。
        </p>
        <div
          v-for="key in FIELD_ORDER"
          :key="key"
          class="field-policy"
          :class="{ disabled: !fieldEnabled(key) }"
        >
          <div>
            <div class="name">{{ FIELD_META[key].label }}</div>
            <div class="note">{{ FIELD_META[key].hint }}</div>
          </div>
          <label class="toggle">
            <input
              type="checkbox"
              :checked="fieldEnabled(key)"
              @change="setEnabled(key, $event.target.checked)"
            />
            启用
          </label>
          <div>
            <label :for="`hops-${key}`" class="small">最大链路跳数</label>
            <input
              :id="`hops-${key}`"
              type="number"
              min="1"
              max="10"
              :value="draft.fields[key].max_hops"
              @input="setMaxHops(key, $event.target.value)"
            />
          </div>
        </div>
      </div>

      <div v-if="message" class="notice" :class="messageKind">{{ message }}</div>
      <div v-if="errors.length" class="notice error">
        <strong>配置错误（未保存）：</strong>
        <ul>
          <li v-for="(item, index) in errors" :key="`e-${index}`">
            <span class="mono">{{ item.field }}</span>：{{ item.message }}
          </li>
        </ul>
      </div>
      <div v-if="warnings.length" class="notice warn">
        <strong>提示（不影响保存）：</strong>
        <ul>
          <li v-for="(item, index) in warnings" :key="`w-${index}`">
            <span class="mono">{{ item.field }}</span>：{{ item.message }}
          </li>
        </ul>
      </div>
      <div v-if="lastFingerprint" class="notice info small mono break">
        指纹：{{ lastFingerprint }}
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>已保存的配置</h2>
        <span class="hint">共 {{ list.length }} 份</span>
      </div>
      <div v-if="!list.length" class="empty">还没有保存的配置。</div>
      <div v-for="saved in list" :key="saved.id" class="demo-card">
        <div class="card-head" style="margin-bottom: 4px">
          <div>
            <h3>{{ saved.name }}</h3>
            <p class="desc">
              {{ saved.config.entries.length }} 个可信条目 · 更新于 {{ saved.updated_at }}
            </p>
          </div>
          <span v-if="selectedId === saved.id" class="badge ok">当前编辑</span>
        </div>
        <div class="chip-list" style="margin-bottom: 6px">
          <span v-for="entry in saved.config.entries" :key="entry.value" class="chip">
            {{ entry.value }}<template v-if="entry.label"> · {{ entry.label }}</template>
          </span>
        </div>
        <div class="small muted">
          启用字段：
          {{
            FIELD_ORDER.filter((key) => saved.config.fields[key]?.enabled)
              .map((key) => `${FIELD_META[key].label}(${saved.config.fields[key].max_hops})`)
              .join('、') || '无'
          }}
        </div>
        <div class="button-row" style="margin-top: 10px">
          <button @click="editSaved(saved)">编辑</button>
          <button @click="useSaved(saved)">用于判定</button>
          <button class="ghost danger" @click="remove(saved)">删除</button>
        </div>
      </div>
    </section>
  </div>
</template>
