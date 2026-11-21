/* 内置示例场景：多声源、墙体遮挡、不同混响区 */
'use strict';

const Samples = [
  {
    key: 'courtyard',
    label: '示例1：多声源广场（方向性 + 环绕走动）',
    build() {
      const sc = new Scene();
      sc.name = '多声源广场';
      sc.duration = 16;
      sc.listener = Scene.makeListener({ x: 0, y: 0, angle: -Math.PI / 2 });
      // 听者在广场中缓慢绕行一圈
      const lp = [];
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        lp.push({ t: i, x: Math.cos(a) * 4, y: Math.sin(a) * 4, angle: a + Math.PI / 2 });
      }
      sc.listener.path = lp;

      const fountain = Scene.makeSource({
        name: '喷泉(全向)', x: 0, y: 0, volume: 0.7,
        distModel: 'inverse', refDistance: 1.5, rolloff: 1,
        sound: { type: 'noise', bandFreq: 2500, bandQ: 0.5 },
      });
      const speaker = Scene.makeSource({
        name: '广播喇叭(定向)', x: -8, y: -6, angle: Math.PI / 4, volume: 0.9,
        coneInner: 60, coneOuter: 120, coneOuterGain: 0.15,
        distModel: 'linear', refDistance: 2, maxDistance: 25, rolloff: 1,
        sound: { type: 'melody', tempo: 100, notes: [660, 550, 660, 440, 550, 660, 880, 660] },
      });
      const machine = Scene.makeSource({
        name: '发电机(移动)', x: 8, y: 6, volume: 0.8,
        distModel: 'exponential', refDistance: 1, rolloff: 1.2,
        sound: { type: 'engine', freq: 65 },
        path: [
          { t: 0, x: 8, y: 6, angle: 0 }, { t: 4, x: 8, y: -6, angle: 0 },
          { t: 8, x: -8, y: -6, angle: 0 }, { t: 12, x: -8, y: 6, angle: 0 },
          { t: 16, x: 8, y: 6, angle: 0 },
        ],
      });
      const bird = Scene.makeSource({
        name: '蜂鸣器', x: 5, y: -8, volume: 0.5,
        sound: { type: 'beep', freq: 1200, rate: 3 },
      });
      sc.sources.push(fountain, speaker, machine, bird);
      return sc;
    },
  },
  {
    key: 'corridor',
    label: '示例2：走廊遮挡（墙体低通 + 衰减）',
    build() {
      const sc = new Scene();
      sc.name = '走廊遮挡';
      sc.duration = 12;
      sc.listener = Scene.makeListener({ x: 0, y: 6, angle: -Math.PI / 2 });
      sc.listener.path = [
        { t: 0, x: -10, y: 6, angle: -Math.PI / 2 },
        { t: 6, x: 10, y: 6, angle: -Math.PI / 2 },
        { t: 12, x: -10, y: 6, angle: -Math.PI / 2 },
      ];
      // 房间与走廊墙体
      sc.walls.push(
        Scene.makeWall(-6, -4, -6, 4),   // 左房间右墙
        Scene.makeWall(-6, -4, 2, -4),   // 上墙（留门洞 2..6）
        Scene.makeWall(6, -4, 12, -4),
        Scene.makeWall(-6, 4, 12, 4),    // 下墙
        Scene.makeWall(12, -4, 12, 4),   // 右墙
        Scene.makeWall(-6, -4, -6, 4),
      );
      sc.walls[1].damping = 0.85;
      const radio = Scene.makeSource({
        name: '房间里的收音机', x: 2, y: 0, volume: 0.9,
        distModel: 'inverse', refDistance: 1, rolloff: 1,
        sound: { type: 'melody', tempo: 132, notes: [523, 659, 784, 1047, 784, 659] },
      });
      const alarm = Scene.makeSource({
        name: '走廊警报', x: -12, y: 6, volume: 0.6,
        sound: { type: 'beep', freq: 880, rate: 1.5 },
      });
      sc.sources.push(radio, alarm);
      return sc;
    },
  },
  {
    key: 'hall',
    label: '示例3：混响区穿行（大厅 / 洞穴 / 露天）',
    build() {
      const sc = new Scene();
      sc.name = '混响区穿行';
      sc.duration = 15;
      sc.listener = Scene.makeListener({ x: -14, y: 0, angle: 0 });
      sc.listener.path = [
        { t: 0, x: -14, y: 0, angle: 0 },
        { t: 5, x: -4, y: 0, angle: 0 },
        { t: 10, x: 6, y: 0, angle: 0 },
        { t: 15, x: 16, y: 0, angle: 0 },
      ];
      sc.zones.push(
        Object.assign(Scene.makeZone(-6, 0, 6), { name: '大厅', decay: 3.5, wet: 0.7 }),
        Object.assign(Scene.makeZone(8, 0, 5), { name: '洞穴', decay: 6, wet: 0.9 }),
      );
      const voice = Scene.makeSource({
        name: '歌者(跟随)', x: -12, y: 0, volume: 0.85,
        distModel: 'inverse', refDistance: 2, rolloff: 0.8,
        sound: { type: 'tone', wave: 'sine', freq: 330 },
        path: [
          { t: 0, x: -12, y: 0, angle: 0 }, { t: 5, x: -2, y: 0, angle: 0 },
          { t: 10, x: 8, y: 0, angle: 0 }, { t: 15, x: 18, y: 0, angle: 0 },
        ],
      });
      const ambient = Scene.makeSource({
        name: '洞穴水滴', x: 9, y: -2, volume: 0.6,
        sound: { type: 'beep', freq: 2000, rate: 0.7 },
      });
      sc.sources.push(voice, ambient);
      return sc;
    },
  },
];
