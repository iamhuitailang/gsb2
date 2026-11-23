/**
 * 语言代码 ↔ ISO 639-2 标签 ↔ 界面显示名。
 *
 * 服务端写 ffmpeg 元数据、前端下拉框、导出回读校验共用这一份数据，
 * 保证界面里看到的语言和文件里的语言标记不会各说各话。
 */

export const LANGUAGES = [
  { code: 'zh', tag: 'zho', label: '中文', native: '简体中文', short: '中' },
  { code: 'yue', tag: 'yue', label: '粤语', native: '粵語', short: '粤' },
  { code: 'en', tag: 'eng', label: '英语', native: 'English', short: 'EN' },
  { code: 'ja', tag: 'jpn', label: '日语', native: '日本語', short: '日' },
  { code: 'ko', tag: 'kor', label: '韩语', native: '한국어', short: '한' },
  { code: 'fr', tag: 'fra', label: '法语', native: 'Français', short: 'FR' },
  { code: 'de', tag: 'deu', label: '德语', native: 'Deutsch', short: 'DE' },
  { code: 'es', tag: 'spa', label: '西班牙语', native: 'Español', short: 'ES' },
  { code: 'ru', tag: 'rus', label: '俄语', native: 'Русский', short: 'RU' },
  { code: 'pt', tag: 'por', label: '葡萄牙语', native: 'Português', short: 'PT' },
  { code: 'it', tag: 'ita', label: '意大利语', native: 'Italiano', short: 'IT' },
  { code: 'ar', tag: 'ara', label: '阿拉伯语', native: 'العربية', short: 'AR' },
  { code: 'und', tag: 'und', label: '未指定', native: 'Undetermined', short: '—' },
];

const BY_CODE = new Map(LANGUAGES.map((entry) => [entry.code, entry]));
const BY_TAG = new Map(LANGUAGES.map((entry) => [entry.tag, entry]));

const ALIASES = new Map();

for (const lang of LANGUAGES) {
  ALIASES.set(lang.code, lang.code);
  ALIASES.set(lang.tag, lang.code);
  ALIASES.set(lang.native.toLowerCase(), lang.code);
  ALIASES.set(lang.label.toLowerCase(), lang.code);
}

const EXTRA_ALIASES = {
  chi: 'zh', chs: 'zh', cht: 'zh', cn: 'zh', cmn: 'zh', zho: 'zh',
  'zh-cn': 'zh', 'zh-hans': 'zh', 'zh-hant': 'zh', 'zh-tw': 'zh', 'zh-hk': 'zh',
  chinese: 'zh', mandarin: 'zh', '中文': 'zh', '简体': 'zh', '繁体': 'zh',
  '中字': 'zh', '汉语': 'zh', '漢語': 'zh', '普通话': 'zh', '國語': 'zh',
  cantonese: 'yue', '粵語': 'yue', '粤语': 'yue', '廣東話': 'yue', '广东话': 'yue',
  eng: 'en', 'en-us': 'en', 'en-gb': 'en', english: 'en', '英语': 'en',
  '英文': 'en', '英': 'en', 'english (us)': 'en', 'english (uk)': 'en',
  jpn: 'ja', jp: 'ja', japanese: 'ja', '日语': 'ja', '日文': 'ja', '日本語': 'ja',
  kor: 'ko', kr: 'ko', korean: 'ko', '韩语': 'ko', '韓語': 'ko', '한국어': 'ko',
  fre: 'fr', fra: 'fr', french: 'fr', '法语': 'fr', 'français': 'fr',
  ger: 'de', deu: 'de', german: 'de', '德语': 'de', 'deutsch': 'de',
  spa: 'es', spanish: 'es', '西班牙语': 'es', 'español': 'es',
  rus: 'ru', russian: 'ru', '俄语': 'ru', 'русский': 'ru',
  por: 'pt', portuguese: 'pt', '葡萄牙语': 'pt', 'português': 'pt',
  ita: 'it', italian: 'it', '意大利语': 'it', 'italiano': 'it',
  ara: 'ar', arabic: 'ar', '阿拉伯语': 'ar', 'العربية': 'ar',
  und: 'und', unknown: 'und', '未指定': 'und',
};

for (const [alias, code] of Object.entries(EXTRA_ALIASES)) {
  ALIASES.set(alias.toLowerCase(), code);
}

/** 把任意常见写法（zh / zho / Chinese / 中文 / zh-CN）归一为内部语言代码。 */
export function normalizeLanguage(value, fallback = 'und') {
  if (value == null) return fallback;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return fallback;
  if (ALIASES.has(raw)) return ALIASES.get(raw);
  // 文件名里常见 "audio.zh.srt" / "音轨-en.wav" 这类片段
  const cleaned = raw.replace(/[_\s]+/g, '-');
  if (ALIASES.has(cleaned)) return ALIASES.get(cleaned);
  const base = cleaned.split('-')[0];
  if (ALIASES.has(base)) return ALIASES.get(base);
  return fallback;
}

export function languageInfo(code) {
  return BY_CODE.get(normalizeLanguage(code)) || BY_CODE.get('und');
}

/** ISO 639-2 三字母标签，写进 mkv 的 language 字段。 */
export function languageTag(code) {
  return languageInfo(code).tag;
}

/** 从 ISO 639-2 标签或任意别名还原为内部代码。 */
export function languageFromTag(tag) {
  const entry = BY_TAG.get(String(tag || '').toLowerCase());
  return entry ? entry.code : normalizeLanguage(tag);
}

export function languageLabel(code) {
  const info = languageInfo(code);
  return info.code === 'und' ? '未指定' : `${info.label} · ${info.native}`;
}

/**
 * 从文件名猜测语言，例如 "lesson.en.srt"、"中文字幕.srt"、"音轨-粤语.wav"。
 * 只在用户没有显式指定语言时使用。
 *
 * 先按分隔符切成 token 精确匹配；再做子串匹配时只接受含 CJK 的别名，
 * 避免 "subtitles" 里的 "es" 把字幕误判成西班牙语。
 */
export function guessLanguageFromFileName(fileName = '') {
  const raw = String(fileName).toLowerCase();
  const stem = raw.replace(/\.[a-z0-9]{1,5}$/i, '');
  const tokens = stem.split(/[.\-_\s()[\]{}]+/).filter(Boolean);
  for (const token of tokens) {
    if (ALIASES.has(token)) return ALIASES.get(token);
  }
  for (const [alias, code] of ALIASES) {
    if (alias.length < 2) continue;
    if (!/[㐀-鿿]/.test(alias)) continue;
    if (raw.includes(alias)) return code;
  }
  return 'und';
}
