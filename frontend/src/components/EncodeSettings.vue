<template>
  <div style="margin-top: 18px; border-top: 1px solid var(--border); padding-top: 16px">
    <h2>3. 输出格式与编码参数</h2>

    <div class="row" style="align-items: flex-start">
      <label class="field">
        输出容器格式
        <select v-model="formatModel">
          <option v-for="(spec, key) in options.formats" :key="key" :value="key">
            {{ spec.label }}
          </option>
        </select>
      </label>

      <label class="field">
        视频编码器（-c:v）
        <select v-model="videoCodecModel">
          <option v-for="c in currentSpec.video_codecs" :key="c" :value="c">
            {{ codecLabel(c, true) }}
          </option>
        </select>
      </label>

      <label class="field">
        音频编码器（-c:a）
        <select v-model="audioCodecModel">
          <option v-for="c in currentSpec.audio_codecs" :key="c" :value="c">
            {{ codecLabel(c, false) }}
          </option>
        </select>
      </label>
    </div>

    <div class="row" style="align-items: flex-start; margin-top: 12px">
      <label class="field" v-if="supportsCrf">
        CRF 质量（{{ options.crf_range[0] }}-{{ options.crf_range[1] }}，越小越清晰/越大）
        <input type="number" v-model.number="crfModel" :min="options.crf_range[0]" :max="options.crf_range[1]" />
      </label>

      <label class="field" v-if="supportsPreset">
        编码预设（-preset，速度/压缩权衡）
        <select v-model="presetModel">
          <option v-for="p in options.presets" :key="p.value" :value="p.value">
            {{ p.label }}
          </option>
        </select>
      </label>

      <label class="field">
        视频码率（-b:v，可留空；示例 2000k / 2M）
        <input v-model="videoBitrateModel" placeholder="留空使用 CRF 控制" />
      </label>

      <label class="field">
        音频码率（-b:a，可留空；示例 128k）
        <input v-model="audioBitrateModel" placeholder="如 128k" />
      </label>
    </div>

    <p class="muted" style="font-size: 12px; margin: 12px 0 0">
      提示：选择 <b>copy</b> 表示直接复制流、不重新编码（速度最快，但裁切只能定位到关键帧，
      毫秒精度无法保证）；要精确裁切到指定毫秒请选择真实编码器（如 H.264/AAC）。
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  options: { type: Object, required: true },
  format: String,
  videoCodec: String,
  audioCodec: String,
  crf: Number,
  preset: String,
  videoBitrate: String,
  audioBitrate: String,
})
const emit = defineEmits([
  'update:format',
  'update:videoCodec',
  'update:audioCodec',
  'update:crf',
  'update:preset',
  'update:videoBitrate',
  'update:audioBitrate',
])

const formatModel = computed({
  get: () => props.format,
  set: (v) => emit('update:format', v),
})
const videoCodecModel = computed({
  get: () => props.videoCodec,
  set: (v) => emit('update:videoCodec', v),
})
const audioCodecModel = computed({
  get: () => props.audioCodec,
  set: (v) => emit('update:audioCodec', v),
})
const crfModel = computed({
  get: () => props.crf,
  set: (v) => emit('update:crf', v),
})
const presetModel = computed({
  get: () => props.preset,
  set: (v) => emit('update:preset', v),
})
const videoBitrateModel = computed({
  get: () => props.videoBitrate,
  set: (v) => emit('update:videoBitrate', v),
})
const audioBitrateModel = computed({
  get: () => props.audioCodec === 'copy' ? '' : props.audioBitrate,
  set: (v) => emit('update:audioBitrate', v),
})

const currentSpec = computed(() => props.options.formats[props.format] || { video_codecs: [], audio_codecs: [] })
const supportsCrf = computed(() => ['h264', 'hevc', 'vp9', 'vp8'].includes(props.videoCodec))
const supportsPreset = computed(() => ['h264', 'hevc'].includes(props.videoCodec))

const ENCODER_LABELS = {
  h264: 'H.264 / AVC (libx264)',
  hevc: 'H.265 / HEVC (libx265)',
  vp9: 'VP9 (libvpx-vp9)',
  vp8: 'VP8 (libvpx)',
  mpeg4: 'MPEG-4 Part 2 (mpeg4)',
  prores: 'Apple ProRes (prores_ks)',
  aac: 'AAC (原生编码器)',
  opus: 'Opus (libopus)',
  mp3: 'MP3 (libmp3lame)',
  vorbis: 'Vorbis (libvorbis)',
  pcm_s16le: 'PCM 16-bit 无损 (pcm_s16le)',
  copy: 'copy 直接复制流（不重编码）',
  none: '无视频流',
}

function codecLabel(codec) {
  return ENCODER_LABELS[codec] || codec
}
</script>
