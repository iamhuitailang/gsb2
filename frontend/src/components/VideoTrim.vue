<template>
  <div class="panel" v-if="file">
    <h2>2. 预览并设置裁切区间（精确到毫秒）</h2>
    <video ref="videoRef" controls preload="metadata" :src="sourceUrl" />

    <div class="task-meta">
      <span>分辨率：{{ file.width }}×{{ file.height }}</span>
      <span>源编码：{{ file.video_codec || '-' }} / {{ file.audio_codec || '-' }}</span>
      <span>总时长：<b class="mono">{{ msToText(duration) }}</b></span>
    </div>

    <!-- 双柄时间轴 -->
    <div class="range-picker">
      <div class="track" />
      <div class="selection" :style="selectionStyle" />
      <input
        type="range"
        :min="0"
        :max="duration"
        :step="1"
        :value="startMs"
        @input="onStartChange(Number($event.target.value))"
        aria-label="起始时间"
      />
      <input
        type="range"
        :min="0"
        :max="duration"
        :step="1"
        :value="endMs"
        @input="onEndChange(Number($event.target.value))"
        aria-label="结束时间"
      />
    </div>

    <div class="time-inputs">
      <label class="field">
        起始时间（时:分:秒.毫秒）
        <input
          v-model="startText"
          :class="{ invalid: startInvalid }"
          @change="commitStartText"
          placeholder="00:00:00.000"
        />
      </label>
      <button class="ghost" type="button" @click="seekTo(startMs)">定位到起点</button>
      <label class="field">
        结束时间（时:分:秒.毫秒）
        <input
          v-model="endText"
          :class="{ invalid: endInvalid }"
          @change="commitEndText"
          placeholder="00:00:00.000"
        />
      </label>
      <button class="ghost" type="button" @click="seekTo(endMs)">定位到终点</button>
      <div class="muted mono" style="align-self: center">
        裁切时长：{{ msToText(clipDuration) }}
      </div>
    </div>
    <div v-if="trimError" class="error-text" style="margin-top: 8px">{{ trimError }}</div>

    <EncodeSettings
      :options="options"
      v-model:format="format"
      v-model:video-codec="videoCodec"
      v-model:audio-codec="audioCodec"
      v-model:crf="crf"
      v-model:preset="preset"
      v-model:video-bitrate="videoBitrate"
      v-model:audio-bitrate="audioBitrate"
    />

    <div class="row" style="margin-top: 14px">
      <button :disabled="!canSubmit || submitting" @click="submit">
        {{ submitting ? '提交中…' : '提交裁切/转码任务' }}
      </button>
      <span v-if="submitError" class="error-text">{{ submitError }}</span>
    </div>
  </div>

  <div class="panel muted" v-else>
    请先上传并选择一个视频文件。
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { api } from '../api'
import { msToText, textToMs } from '../utils/time'
import EncodeSettings from './EncodeSettings.vue'

const props = defineProps({
  file: { type: Object, default: null },
  options: { type: Object, required: true },
})
const emit = defineEmits(['created'])

const videoRef = ref(null)
const startMs = ref(0)
const endMs = ref(0)
const startText = ref('00:00:00.000')
const endText = ref('00:00:00.000')
const startInvalid = ref(false)
const endInvalid = ref(false)
const trimError = ref('')
const submitError = ref('')
const submitting = ref(false)

const format = ref('mp4')
const videoCodec = ref('h264')
const audioCodec = ref('aac')
const crf = ref(23)
const preset = ref('medium')
const videoBitrate = ref('')
const audioBitrate = ref('')

const duration = computed(() => props.file?.duration_ms || 0)
const sourceUrl = computed(() => (props.file ? api.sourceUrl(props.file.id) : ''))
const clipDuration = computed(() => Math.max(0, endMs.value - startMs.value))

const selectionStyle = computed(() => ({
  left: `${(startMs.value / Math.max(1, duration.value)) * 100}%`,
  width: `${(clipDuration.value / Math.max(1, duration.value)) * 100}%`,
}))

const canSubmit = computed(() => {
  if (!props.file) return false
  if (startMs.value < 0 || endMs.value <= startMs.value) return false
  if (duration.value && endMs.value > duration.value) return false
  return true
})

// 切换文件时重置区间与编码默认值
watch(
  () => props.file?.id,
  () => {
    startMs.value = 0
    endMs.value = duration.value
    syncTexts()
    trimError.value = ''
    submitError.value = ''
    applyDefaultCodecs()
  },
  { immediate: true }
)

// 切换容器格式时，把不兼容的编码重置为该格式的首项
watch(format, (fmt) => {
  const spec = props.options.formats[fmt]
  if (!spec) return
  if (!spec.video_codecs.includes(videoCodec.value)) {
    videoCodec.value = spec.video_codecs[0]
  }
  if (!spec.audio_codecs.includes(audioCodec.value)) {
    audioCodec.value = spec.audio_codecs[0]
  }
})

function applyDefaultCodecs() {
  const spec = props.options.formats[format.value]
  if (spec) {
    videoCodec.value = spec.video_codecs[0]
    audioCodec.value = spec.audio_codecs[0]
  }
}

function syncTexts() {
  startText.value = msToText(startMs.value)
  endText.value = msToText(endMs.value)
  startInvalid.value = false
  endInvalid.value = false
}

function onStartChange(value) {
  // 至少留 1ms，保证结束晚于起始
  startMs.value = Math.min(value, Math.max(0, endMs.value - 1))
  startText.value = msToText(startMs.value)
  startInvalid.value = false
  seekTo(startMs.value)
}

function onEndChange(value) {
  endMs.value = Math.max(value, Math.min(duration.value, startMs.value + 1))
  endText.value = msToText(endMs.value)
  endInvalid.value = false
  seekTo(endMs.value)
}

function commitStartText() {
  const ms = textToMs(startText.value)
  if (Number.isNaN(ms) || ms < 0 || ms >= endMs.value) {
    startInvalid.value = true
    trimError.value = '起始时间格式非法，或不小于结束时间。格式：HH:MM:SS.mmm'
    startText.value = msToText(startMs.value)
    return
  }
  trimError.value = ''
  startMs.value = ms
  startText.value = msToText(ms)
}

function commitEndText() {
  const ms = textToMs(endText.value)
  if (
    Number.isNaN(ms) ||
    ms <= startMs.value ||
    (duration.value && ms > duration.value)
  ) {
    endInvalid.value = true
    trimError.value = '结束时间格式非法，或不晚于起始时间/超出总时长。格式：HH:MM:SS.mmm'
    endText.value = msToText(endMs.value)
    return
  }
  trimError.value = ''
  endMs.value = ms
  endText.value = msToText(ms)
}

function seekTo(ms) {
  const video = videoRef.value
  if (!video || !duration.value) return
  video.currentTime = ms / 1000
}

async function submit() {
  submitError.value = ''
  if (!canSubmit.value) {
    submitError.value = '裁切区间不合法'
    return
  }
  const payload = {
    file_id: props.file.id,
    start_ms: startMs.value,
    end_ms: endMs.value,
    format: format.value,
    video_codec: videoCodec.value,
    audio_codec: audioCodec.value,
    crf: ['h264', 'hevc', 'vp9', 'vp8'].includes(videoCodec.value) ? crf.value : null,
    preset: ['h264', 'hevc'].includes(videoCodec.value) ? preset.value : null,
    video_bitrate: videoBitrate.value || null,
    audio_bitrate: audioBitrate.value || null,
  }
  try {
    submitting.value = true
    const task = await api.createTask(payload)
    emit('created', task)
  } catch (err) {
    submitError.value = err.message
  } finally {
    submitting.value = false
  }
}
</script>
