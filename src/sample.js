/**
 * 示例剧情。
 * - buildSampleStory：新建项目时可选的小型「三分支 + 汇合点」模板。
 * - mistyLighthouseStory：完整示例「雾中的灯塔」，
 *   含条件分支、汇合点、多入口、循环路径、变量读写和三种语言（少量缺译）。
 */
import {
  STORY_FORMAT,
  STORY_VERSION,
  normalizeStory,
} from './story.js';

function fx(id, variableId, op, value) {
  return { id, variableId, op, value };
}

export function buildSampleStory({ title = '三分支示例', locale = 'zh-CN' } = {}) {
  const labels = { 'zh-CN': '简体中文', en: 'English', ja: '日本語' };

  const story = {
    format: STORY_FORMAT,
    version: STORY_VERSION,
    meta: {
      id: 'story_branch_sample',
      title,
      description: '三分支在「汇合」节点重新合流的小示例。',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    settings: { defaultLocale: locale, maxSteps: 120, maxVisitsPerNode: 3 },
    locales: [{ code: locale, label: labels[locale] || locale }],
    variables: [
      { id: 'var_friend', name: '好感', type: 'number', hasInitial: true, initial: 0, description: '同伴对你的好感' },
      { id: 'var_tool', name: '带着工具', type: 'boolean', hasInitial: true, initial: false, description: '' },
    ],
    characters: [
      { id: 'char_narrator', name: { [locale]: '旁白' }, color: '#8a94a6', description: '' },
      { id: 'char_friend', name: { [locale]: '同伴' }, color: '#c9a36b', description: '' },
    ],
    nodes: [
      {
        id: 'sample_start',
        title: '岔路口',
        type: 'dialogue',
        position: { x: 100, y: 240 },
        characterId: 'char_narrator',
        text: { [locale]: '三条路摆在面前，同伴在等你拿主意。' },
        choices: [
          { id: 'sample_c1', text: { [locale]: '走左边，陪同伴聊聊' }, condition: '', effects: [fx('s_fx1', 'var_friend', 'add', 2)], target: 'sample_left' },
          { id: 'sample_c2', text: { [locale]: '走右边，捡些工具' }, condition: '', effects: [fx('s_fx2', 'var_tool', 'set', true)], target: 'sample_right' },
          { id: 'sample_c3', text: { [locale]: '直走，什么也不带' }, condition: '', effects: [], target: 'sample_mid' },
        ],
        next: '',
        onEnter: [],
      },
      {
        id: 'sample_left',
        title: '左边的路',
        type: 'dialogue',
        position: { x: 440, y: 80 },
        characterId: 'char_friend',
        text: { [locale]: '“难得你愿意听我说话。”' },
        choices: [],
        next: 'sample_merge',
        onEnter: [],
      },
      {
        id: 'sample_right',
        title: '右边的路',
        type: 'dialogue',
        position: { x: 440, y: 260 },
        characterId: 'char_narrator',
        text: { [locale]: '你捡到一把还能用的扳手。' },
        choices: [],
        next: 'sample_merge',
        onEnter: [],
      },
      {
        id: 'sample_mid',
        title: '直路',
        type: 'dialogue',
        position: { x: 440, y: 440 },
        characterId: 'char_narrator',
        text: { [locale]: '路面平坦，但你总觉得少了点什么。' },
        choices: [],
        next: 'sample_merge',
        onEnter: [],
      },
      {
        id: 'sample_merge',
        title: '汇合点',
        type: 'hub',
        position: { x: 800, y: 260 },
        characterId: 'char_narrator',
        text: { [locale]: '三条路在前方重新汇成一条。' },
        choices: [
          {
            id: 'sample_c4',
            text: { [locale]: '和同伴一起继续' },
            condition: '好感 >= 2',
            effects: [],
            target: 'sample_end_good',
          },
          {
            id: 'sample_c5',
            text: { [locale]: '继续赶路' },
            condition: '',
            effects: [],
            target: 'sample_end_plain',
          },
        ],
        next: 'sample_end_plain',
        onEnter: [],
      },
      {
        id: 'sample_end_good',
        title: '结局·同行',
        type: 'end',
        position: { x: 1140, y: 160 },
        characterId: 'char_narrator',
        text: { [locale]: '你们并肩走下去，路也不再那么长。' },
        choices: [],
        next: '',
        onEnter: [],
      },
      {
        id: 'sample_end_plain',
        title: '结局·独行',
        type: 'end',
        position: { x: 1140, y: 360 },
        characterId: 'char_narrator',
        text: { [locale]: '你独自走完了剩下的路。' },
        choices: [],
        next: '',
        onEnter: [],
      },
    ],
    startNodeId: 'sample_start',
  };

  return normalizeStory(story);
}

const VARIABLES = [
  { id: 'var_trust', name: '信任', type: 'number', hasInitial: true, initial: 0 },
  { id: 'var_key', name: '持有钥匙', type: 'boolean', hasInitial: true, initial: false },
  { id: 'var_lit', name: '灯塔点亮', type: 'boolean', hasInitial: true, initial: false },
];

const CHARACTERS = [
  { id: 'char_narrator', name: { 'zh-CN': '旁白', en: 'Narrator', ja: 'ナレーション' }, color: '#8a94a6', description: '叙述者' },
  { id: 'char_keeper', name: { 'zh-CN': '守夜人', en: 'The Keeper', ja: '灯守' }, color: '#c9a36b', description: '灯塔的看守者' },
  { id: 'char_you', name: { 'zh-CN': '旅人', en: 'Traveler', ja: '旅人' }, color: '#7fa8c9', description: '玩家扮演的旅人' },
];

export function mistyLighthouseStory() {
  const story = {
    format: STORY_FORMAT,
    version: STORY_VERSION,
    meta: {
      id: 'story_misty_lighthouse',
      title: '雾中的灯塔',
      description: '示例剧情：海边、灯塔与守夜人。包含条件分支、汇合点、多入口与循环路径。',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    settings: { defaultLocale: 'zh-CN', maxSteps: 120, maxVisitsPerNode: 3 },
    locales: [
      { code: 'zh-CN', label: '简体中文' },
      { code: 'en', label: 'English' },
      { code: 'ja', label: '日本語' },
    ],
    variables: VARIABLES,
    characters: CHARACTERS,
    nodes: [
      {
        id: 'node_prologue',
        title: '序章·海边',
        type: 'dialogue',
        position: { x: 80, y: 300 },
        characterId: 'char_narrator',
        text: {
          'zh-CN': '海雾漫过礁石，灯塔在远处一明一灭。你已经走了很久，鞋里全是沙。',
          en: 'Sea fog crawls over the rocks. Far away, the lighthouse blinks. You have walked a long way, sand in your shoes.',
          ja: '海霧が岩場を這い、遠くで灯台がまたたく。長い道のりだった。靴の中は砂だらけだ。',
        },
        choices: [
          {
            id: 'choice_go_lighthouse',
            text: { 'zh-CN': '朝灯塔走去', en: 'Head for the lighthouse', ja: '灯台へ向かう' },
            condition: '',
            effects: [],
            target: 'node_door',
          },
          {
            id: 'choice_search_beach',
            text: { 'zh-CN': '先在沙滩上找找', en: 'Search the beach first', ja: 'まず浜辺を探す' },
            condition: '',
            effects: [],
            target: 'node_beach',
          },
        ],
        next: '',
        onEnter: [],
      },
      {
        id: 'node_beach',
        title: '退潮的沙滩',
        type: 'dialogue',
        position: { x: 400, y: 470 },
        characterId: 'char_narrator',
        text: {
          'zh-CN': '潮水退去，沙里露出一小截铜光。是一把锈迹斑斑的钥匙。',
          en: 'The tide has pulled back, and a glint of brass shows in the sand. A rusted key.',
          ja: '潮が引いた砂の中に、真鍮の光が覗いている。錆びた鍵だ。',
        },
        choices: [
          {
            id: 'choice_take_key',
            text: { 'zh-CN': '拾起铜钥匙', en: 'Pick up the brass key', ja: '真鍮の鍵を拾う' },
            condition: '',
            effects: [fx('fx_take_key', 'var_key', 'set', true)],
            target: 'node_door',
          },
          {
            id: 'choice_leave_key',
            text: { 'zh-CN': '空手离开', en: 'Leave it and go', ja: '何も持たずに立ち去る' },
            condition: '',
            effects: [],
            target: 'node_door',
          },
        ],
        next: '',
        onEnter: [],
      },
      {
        id: 'node_door',
        title: '灯塔门口（汇合点）',
        type: 'hub',
        position: { x: 720, y: 300 },
        characterId: 'char_narrator',
        text: {
          'zh-CN': '铁门紧闭，门缝里透出一点暖光。风把门吹得哐当作响。',
          en: 'The iron door is shut tight, a sliver of warm light leaking through. The wind rattles it.',
          ja: '鉄の扉は固く閉ざされ、隙間から暖かな光が漏れている。風が扉を揺らして鳴らす。',
        },
        choices: [
          {
            id: 'choice_use_key',
            text: { 'zh-CN': '用铜钥匙开门', en: 'Unlock the door with the key', ja: '鍵で扉を開ける' },
            condition: '持有钥匙 == true',
            effects: [],
            target: 'node_stairs',
          },
          {
            id: 'choice_knock',
            text: { 'zh-CN': '敲门', en: 'Knock', ja: '扉を叩く' },
            condition: '',
            effects: [],
            target: 'node_keeper_hub',
          },
        ],
        next: '',
        onEnter: [],
      },
      {
        id: 'node_keeper_hub',
        title: '守夜人（循环枢纽）',
        type: 'hub',
        position: { x: 1050, y: 300 },
        characterId: 'char_keeper',
        text: {
          'zh-CN': '守夜人坐在炉火边，没有回头。“门没锁，是风在推。”',
          en: 'The keeper sits by the stove without turning. "The door is not locked. That is the wind."',
          ja: '灯守は炉のそばで振り向きもしない。「扉は開いている。風が押しているだけだ」',
        },
        choices: [
          {
            id: 'choice_ask_lighthouse',
            text: { 'zh-CN': '打听灯塔的事', en: 'Ask about the lighthouse', ja: '灯台のことを尋ねる' },
            condition: '',
            effects: [],
            target: 'node_keeper_talk',
          },
          {
            id: 'choice_rest',
            text: { 'zh-CN': '请求借宿一晚', en: 'Ask to stay the night', ja: '一晩泊めてほしいと頼む' },
            condition: '信任 >= 2',
            effects: [],
            target: 'node_end_rest',
          },
          {
            id: 'choice_leave_keeper',
            text: { 'zh-CN': '回到门口', en: 'Return to the door', ja: '扉のところへ戻る' },
            condition: '',
            effects: [],
            target: 'node_door',
          },
        ],
        next: '',
        onEnter: [],
      },
      {
        id: 'node_keeper_talk',
        title: '守夜人的回忆',
        type: 'dialogue',
        position: { x: 1050, y: 620 },
        characterId: 'char_keeper',
        text: {
          'zh-CN': '“三十年前，我父亲也在这盏灯下等过一个人。后来灯灭了，人也没来。”',
          en: '"Thirty years ago my father waited beneath this lamp for someone too. Then the lamp went out, and no one came."',
          ja: '「三十年前、父もこの灯の下で誰かを待っていた。やがて灯は消え、その人は来なかった」',
        },
        onEnter: [fx('fx_trust_talk', 'var_trust', 'add', 1)],
        next: 'node_keeper_hub',
        choices: [],
      },
      {
        id: 'node_stairs',
        title: '旋梯',
        type: 'dialogue',
        position: { x: 1050, y: 60 },
        characterId: 'char_narrator',
        text: {
          'zh-CN': '石阶又窄又陡，海风从窗口灌进来，一级一级往上，灯光越来越近。',
          en: 'The stone steps are narrow and steep. Sea wind pours through the window. With every step the light grows closer.',
          ja: '石段は狭く険しい。窓から海風が吹き込む。一段上がるたび、灯が近づいてくる。',
        },
        next: 'node_lamp_room',
        choices: [],
        onEnter: [],
      },
      {
        id: 'node_lamp_room',
        title: '灯室',
        type: 'hub',
        position: { x: 1380, y: 60 },
        characterId: 'char_narrator',
        text: {
          'zh-CN': '巨大的透镜静静立在房间中央，灯芯只剩一点暗红。',
          en: 'The great lens stands still in the middle of the room. The wick is only a dull red ember.',
          ja: '巨大なレンズが部屋の中央に静かに立っている。芯には暗い赤だけが残っていた。',
        },
        choices: [
          {
            id: 'choice_light',
            text: { 'zh-CN': '点亮灯塔', en: 'Light the lighthouse', ja: '灯台に火をともす' },
            condition: '信任 >= 2',
            effects: [fx('fx_light', 'var_lit', 'set', true)],
            target: 'node_end_dawn',
          },
          {
            id: 'choice_turn_back',
            text: { 'zh-CN': '转身下楼', en: 'Turn back down the stairs', ja: '階段を下りる' },
            condition: '',
            effects: [],
            target: 'node_end_return',
          },
        ],
        next: '',
        onEnter: [],
      },
      {
        id: 'node_ch2_entry',
        title: '第二章·灯室',
        type: 'dialogue',
        position: { x: 1380, y: 380 },
        characterId: 'char_narrator',
        entry: true,
        entryLabel: '第二章：灯室',
        text: {
          'zh-CN': '（第二章起点）你在天亮前爬到了灯室，手里还攥着那枚冰凉的钥匙。',
          en: '(Chapter Two entry) You climbed to the lamp room before dawn, the cold key still in your hand.',
          ja: '（第二章開始）夜明け前に灯室へたどり着いた。冷たい鍵をまだ握りしめている。',
        },
        next: 'node_lamp_room',
        choices: [],
        onEnter: [],
      },
      {
        id: 'node_end_dawn',
        title: '结局·黎明',
        type: 'end',
        position: { x: 1740, y: 60 },
        characterId: 'char_narrator',
        text: {
          'zh-CN': '灯亮起来的那一刻，雾向海面退去。远处的船鸣了一声笛。',
          en: 'The moment the lamp catches, the fog retreats toward the sea. A ship sounds its horn in the distance.',
          ja: '灯がともった瞬間、霧は海へと退いていった。遠くで船が汽笛を鳴らす。',
        },
        next: '',
        choices: [],
        onEnter: [],
      },
      {
        id: 'node_end_return',
        title: '结局·归途',
        type: 'end',
        position: { x: 1740, y: 380 },
        characterId: 'char_narrator',
        text: {
          'zh-CN': '你回到雾里。身后的灯依旧一明一灭，像一声没有说完的话。',
          en: 'You walk back into the fog. Behind you the lamp still blinks, like a sentence left unfinished.',
          ja: '',
        },
        next: '',
        choices: [],
        onEnter: [],
      },
      {
        id: 'node_end_rest',
        title: '结局·炉火',
        type: 'end',
        position: { x: 1380, y: 700 },
        characterId: 'char_keeper',
        text: {
          'zh-CN': '守夜人往炉子里添了一块柴。“睡吧。天亮之前，雾不会散。”',
          en: 'The keeper adds a log to the stove. "Sleep. The fog will not lift before dawn."',
          ja: '',
        },
        next: '',
        choices: [],
        onEnter: [],
      },
    ],
    startNodeId: 'node_prologue',
  };

  return normalizeStory(story);
}

export { VARIABLES as sampleVariables, CHARACTERS as sampleCharacters };