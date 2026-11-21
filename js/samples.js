/*
 * 内置本地战斗样例
 *
 * 每个样例包含两套可直接对比的配置（A / B），以及说明与推荐的批量模拟参数。
 * 不依赖任何服务端数据，全部为本地静态数据。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CombatSamples = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function damage(min, max) { return { min: min, max: max }; }
  function flat(v) { return { min: v, max: v }; }

  function skill(id, name, opts) {
    return {
      id: id,
      name: name,
      cooldown: opts.cooldown != null ? opts.cooldown : 0,
      castTime: opts.castTime != null ? opts.castTime : 0,
      target: opts.target || 'lowestHpEnemy',
      damage: opts.damage || flat(0),
      heal: opts.heal || flat(0),
      effect: opts.effect || null
    };
  }

  function unit(id, name, stats, skills) {
    return {
      id: id,
      name: name,
      maxHp: stats.maxHp,
      atk: stats.atk,
      def: stats.def,
      speed: stats.speed,
      skills: skills || []
    };
  }

  function setup(name, units, opts) {
    opts = opts || {};
    return {
      name: name,
      seed: opts.seed || '1',
      rules: {
        maxTime: opts.maxTime || 30,
        speedTieBreak: opts.speedTieBreak || 'id-asc'
      },
      allies: units.allies,
      enemies: units.enemies
    };
  }

  var samples = [
    {
      id: 'basic',
      name: '基础对拼：剑士 vs 守卫',
      description: '最基础的技能循环：两名单位都只有单体伤害技能，用来确认基础伤害、冷却与胜负判定。',
      recommendedRuns: 100,
      setupA: setup('A · 剑士 + 学徒', {
        allies: [
          unit('a-sword', '剑士', { maxHp: 620, atk: 58, def: 24, speed: 100 }, [
            skill('a-sword-1', '斩击', {
              cooldown: 2.5,
              damage: damage(65, 85)
            }),
            skill('a-sword-2', '重击', {
              cooldown: 7,
              castTime: 1,
              damage: damage(140, 170)
            })
          ]),
          unit('a-apprentice', '学徒', { maxHp: 380, atk: 34, def: 12, speed: 88 }, [
            skill('a-apprentice-1', '火花', {
              cooldown: 3,
              damage: damage(34, 48)
            })
          ])
        ],
        enemies: [
          unit('b-guard', '守卫', { maxHp: 760, atk: 42, def: 46, speed: 78 }, [
            skill('b-guard-1', '盾击', {
              cooldown: 3.5,
              damage: damage(48, 62)
            })
          ])
        ]
      }, { maxTime: 30, seed: '11' }),
      setupB: setup('B · 剑士 + 学徒（换武器）', {
        allies: [
          unit('a-sword', '剑士', { maxHp: 620, atk: 52, def: 30, speed: 102 }, [
            skill('a-sword-1', '斩击', {
              cooldown: 2,
              damage: damage(62, 78)
            }),
            skill('a-sword-2', '重击', {
              cooldown: 6,
              castTime: 1,
              damage: damage(150, 180)
            })
          ]),
          unit('a-apprentice', '学徒', { maxHp: 380, atk: 34, def: 12, speed: 88 }, [
            skill('a-apprentice-1', '火花', {
              cooldown: 3,
              damage: damage(34, 48)
            })
          ])
        ],
        enemies: [
          unit('b-guard', '守卫', { maxHp: 760, atk: 42, def: 46, speed: 78 }, [
            skill('b-guard-1', '盾击', {
              cooldown: 3.5,
              damage: damage(48, 62)
            })
          ])
        ]
      }, { maxTime: 30, seed: '11' })
    },
    {
      id: 'cooldown-cast',
      name: '冷却与引导：法师读条',
      description: '法师的「火球」有 3 秒冷却与 1.2 秒引导，「奥术洪流」为 2 秒引导的群体技能。日志中可以看到 cast → cast_complete 的间隔，以及技能冷却开始计时的时刻。',
      recommendedRuns: 100,
      setupA: setup('A · 引导法师', {
        allies: [
          unit('a-mage', '法师', { maxHp: 430, atk: 55, def: 10, speed: 90 }, [
            skill('a-mage-1', '火球', {
              cooldown: 3,
              castTime: 1.2,
              damage: damage(85, 110)
            }),
            skill('a-mage-2', '奥术洪流', {
              cooldown: 8,
              castTime: 2,
              target: 'allEnemies',
              damage: damage(70, 90)
            })
          ])
        ],
        enemies: [
          unit('b-soldier-1', '民兵甲', { maxHp: 340, atk: 32, def: 14, speed: 108 }, [
            skill('b-soldier-1-s', '挥砍', { cooldown: 2.4, damage: damage(26, 36) })
          ]),
          unit('b-soldier-2', '民兵乙', { maxHp: 340, atk: 32, def: 14, speed: 104 }, [
            skill('b-soldier-2-s', '挥砍', { cooldown: 2.4, damage: damage(26, 36) })
          ])
        ]
      }, { maxTime: 30, seed: '23' }),
      setupB: setup('B · 瞬发法师', {
        allies: [
          unit('a-mage', '法师', { maxHp: 430, atk: 55, def: 10, speed: 90 }, [
            skill('a-mage-1', '火球', {
              cooldown: 3,
              damage: damage(58, 74)
            }),
            skill('a-mage-2', '奥术洪流', {
              cooldown: 8,
              target: 'allEnemies',
              damage: damage(44, 56)
            })
          ])
        ],
        enemies: [
          unit('b-soldier-1', '民兵甲', { maxHp: 340, atk: 32, def: 14, speed: 108 }, [
            skill('b-soldier-1-s', '挥砍', { cooldown: 2.4, damage: damage(26, 36) })
          ]),
          unit('b-soldier-2', '民兵乙', { maxHp: 340, atk: 32, def: 14, speed: 104 }, [
            skill('b-soldier-2-s', '挥砍', { cooldown: 2.4, damage: damage(26, 36) })
          ])
        ]
      }, { maxTime: 30, seed: '23' })
    },
    {
      id: 'stacking-dot',
      name: '叠层流血：刺客的持续伤害',
      description: '刺客的「割裂」每 1 秒结算一次持续伤害，最多叠 5 层。A 用「叠层」（层数累加，强度按层数放大），B 用「刷新」（层数恒为 1，只重置时长），可直接对比层数曲线与总伤害差异。',
      recommendedRuns: 100,
      setupA: setup('A · 叠层刺客', {
        allies: [
          unit('a-rogue', '刺客', { maxHp: 520, atk: 66, def: 16, speed: 118 }, [
            skill('a-rogue-1', '割裂', {
              cooldown: 1.2,
              damage: damage(20, 28),
              effect: {
                kind: 'dot',
                value: damage(10, 14),
                duration: 4,
                interval: 1,
                stackMode: 'stack',
                maxStacks: 5
              }
            }),
            skill('a-rogue-2', '背刺', {
              cooldown: 5,
              damage: damage(70, 95)
            })
          ])
        ],
        enemies: [
          unit('b-tank', '重甲兵', { maxHp: 1200, atk: 38, def: 60, speed: 72 }, [
            skill('b-tank-1', '重锤', { cooldown: 3, damage: damage(55, 72) })
          ])
        ]
      }, { maxTime: 30, seed: '37' }),
      setupB: setup('B · 刷新刺客', {
        allies: [
          unit('a-rogue', '刺客', { maxHp: 520, atk: 66, def: 16, speed: 118 }, [
            skill('a-rogue-1', '割裂', {
              cooldown: 1.2,
              damage: damage(20, 28),
              effect: {
                kind: 'dot',
                value: damage(10, 14),
                duration: 4,
                interval: 1,
                stackMode: 'refresh',
                maxStacks: 5
              }
            }),
            skill('a-rogue-2', '背刺', {
              cooldown: 5,
              damage: damage(70, 95)
            })
          ])
        ],
        enemies: [
          unit('b-tank', '重甲兵', { maxHp: 1200, atk: 38, def: 60, speed: 72 }, [
            skill('b-tank-1', '重锤', { cooldown: 3, damage: damage(55, 72) })
          ])
        ]
      }, { maxTime: 30, seed: '37' })
    },
    {
      id: 'simultaneous',
      name: '同时行动：同速单位的稳定顺序',
      description: '双方速度完全相同时，由固定排序规则决定出手顺序：先比行动时刻，再比速度，再比阵营（我方优先），最后按 id。A 与 B 只把「同速排序」分别设为 id 升序 / id 降序，可直接看到顺序变化对结果的影响。',
      recommendedRuns: 100,
      setupA: setup('A · 同速（id 升序）', {
        allies: [
          unit('x-1', '先锋', { maxHp: 500, atk: 48, def: 20, speed: 100 }, [
            skill('x-1-s', '突刺', { cooldown: 2, damage: damage(45, 60) })
          ]),
          unit('x-2', '副官', { maxHp: 480, atk: 44, def: 22, speed: 100 }, [
            skill('x-2-s', '横扫', { cooldown: 2.4, damage: damage(40, 54) })
          ])
        ],
        enemies: [
          unit('y-1', '敌兵甲', { maxHp: 460, atk: 46, def: 18, speed: 100 }, [
            skill('y-1-s', '劈砍', { cooldown: 2, damage: damage(42, 56) })
          ]),
          unit('y-2', '敌兵乙', { maxHp: 460, atk: 46, def: 18, speed: 100 }, [
            skill('y-2-s', '劈砍', { cooldown: 2, damage: damage(42, 56) })
          ])
        ]
      }, { maxTime: 25, seed: '5', speedTieBreak: 'id-asc' }),
      setupB: setup('B · 同速（id 降序）', {
        allies: [
          unit('x-1', '先锋', { maxHp: 500, atk: 48, def: 20, speed: 100 }, [
            skill('x-1-s', '突刺', { cooldown: 2, damage: damage(45, 60) })
          ]),
          unit('x-2', '副官', { maxHp: 480, atk: 44, def: 22, speed: 100 }, [
            skill('x-2-s', '横扫', { cooldown: 2.4, damage: damage(40, 54) })
          ])
        ],
        enemies: [
          unit('y-1', '敌兵甲', { maxHp: 460, atk: 46, def: 18, speed: 100 }, [
            skill('y-1-s', '劈砍', { cooldown: 2, damage: damage(42, 56) })
          ]),
          unit('y-2', '敌兵乙', { maxHp: 460, atk: 46, def: 18, speed: 100 }, [
            skill('y-2-s', '劈砍', { cooldown: 2, damage: damage(42, 56) })
          ])
        ]
      }, { maxTime: 25, seed: '5', speedTieBreak: 'id-desc' })
    },
    {
      id: 'heal-refresh',
      name: '治疗与刷新：持续效果的结束时机',
      description: '牧师的「愈合」是持续治疗。A 使用「刷新时长」（层数不变，时间重置），B 使用「叠层」。两条治疗曲线会在日志里出现 apply / stack / refresh / effect_end 的不同事件序列。',
      recommendedRuns: 100,
      setupA: setup('A · 刷新愈合', {
        allies: [
          unit('a-priest', '牧师', { maxHp: 560, atk: 30, def: 18, speed: 96 }, [
            skill('a-priest-1', '愈合', {
              cooldown: 1.5,
              target: 'lowestHpAlly',
              heal: flat(0),
              effect: {
                kind: 'hot',
                value: damage(16, 22),
                duration: 5,
                interval: 1,
                stackMode: 'refresh',
                maxStacks: 3
              }
            }),
            skill('a-priest-2', '圣光', {
              cooldown: 4,
              target: 'lowestHpEnemy',
              damage: damage(30, 42)
            })
          ]),
          unit('a-knight', '骑士', { maxHp: 900, atk: 40, def: 40, speed: 84 }, [
            skill('a-knight-1', '盾击', { cooldown: 3, damage: damage(36, 50) })
          ])
        ],
        enemies: [
          unit('b-warlock', '术士', { maxHp: 700, atk: 48, def: 20, speed: 92 }, [
            skill('b-warlock-1', '腐蚀', {
              cooldown: 2.5,
              damage: damage(18, 26),
              effect: {
                kind: 'dot',
                value: damage(8, 12),
                duration: 4,
                interval: 1,
                stackMode: 'refresh',
                maxStacks: 3
              }
            }),
            skill('b-warlock-2', '暗影箭', { cooldown: 3, damage: damage(45, 60) })
          ]),
          unit('b-imp', '小鬼', { maxHp: 320, atk: 30, def: 8, speed: 112 }, [
            skill('b-imp-1', '火焰弹', { cooldown: 2, damage: damage(22, 30) })
          ])
        ]
      }, { maxTime: 40, seed: '61' }),
      setupB: setup('B · 叠层愈合', {
        allies: [
          unit('a-priest', '牧师', { maxHp: 560, atk: 30, def: 18, speed: 96 }, [
            skill('a-priest-1', '愈合', {
              cooldown: 1.5,
              target: 'lowestHpAlly',
              heal: flat(0),
              effect: {
                kind: 'hot',
                value: damage(16, 22),
                duration: 5,
                interval: 1,
                stackMode: 'stack',
                maxStacks: 3
              }
            }),
            skill('a-priest-2', '圣光', {
              cooldown: 4,
              target: 'lowestHpEnemy',
              damage: damage(30, 42)
            })
          ]),
          unit('a-knight', '骑士', { maxHp: 900, atk: 40, def: 40, speed: 84 }, [
            skill('a-knight-1', '盾击', { cooldown: 3, damage: damage(36, 50) })
          ])
        ],
        enemies: [
          unit('b-warlock', '术士', { maxHp: 700, atk: 48, def: 20, speed: 92 }, [
            skill('b-warlock-1', '腐蚀', {
              cooldown: 2.5,
              damage: damage(18, 26),
              effect: {
                kind: 'dot',
                value: damage(8, 12),
                duration: 4,
                interval: 1,
                stackMode: 'refresh',
                maxStacks: 3
              }
            }),
            skill('b-warlock-2', '暗影箭', { cooldown: 3, damage: damage(45, 60) })
          ]),
          unit('b-imp', '小鬼', { maxHp: 320, atk: 30, def: 8, speed: 112 }, [
            skill('b-imp-1', '火焰弹', { cooldown: 2, damage: damage(22, 30) })
          ])
        ]
      }, { maxTime: 40, seed: '61' })
    },
    {
      id: 'buff-stack',
      name: '属性增益：越打越疼',
      description: '「战意」是属性增益（攻击），A 每层 +6 攻击并叠到 3 层，B 只刷新不叠层。伤害公式含“1 + 有效攻击 / 100”，可从总伤害差异直接看出增益的价值。',
      recommendedRuns: 100,
      setupA: setup('A · 叠层战意', {
        allies: [
          unit('a-captain', '队长', { maxHp: 720, atk: 30, def: 26, speed: 98 }, [
            skill('a-captain-1', '战意', {
              cooldown: 1.2,
              target: 'self',
              effect: {
                kind: 'buff', stat: 'atk', value: flat(6),
                duration: 6, interval: 1,
                stackMode: 'stack', maxStacks: 3
              }
            }),
            skill('a-captain-2', '挥砍', { cooldown: 2, damage: damage(40, 52) })
          ])
        ],
        enemies: [
          unit('b-orc', '兽人', { maxHp: 1100, atk: 44, def: 34, speed: 86 }, [
            skill('b-orc-1', '砸击', { cooldown: 2.4, damage: damage(50, 66) })
          ])
        ]
      }, { maxTime: 30, seed: '43' }),
      setupB: setup('B · 刷新战意', {
        allies: [
          unit('a-captain', '队长', { maxHp: 720, atk: 30, def: 26, speed: 98 }, [
            skill('a-captain-1', '战意', {
              cooldown: 1.2,
              target: 'self',
              effect: {
                kind: 'buff', stat: 'atk', value: flat(6),
                duration: 6, interval: 1,
                stackMode: 'refresh', maxStacks: 3
              }
            }),
            skill('a-captain-2', '挥砍', { cooldown: 2, damage: damage(40, 52) })
          ])
        ],
        enemies: [
          unit('b-orc', '兽人', { maxHp: 1100, atk: 44, def: 34, speed: 86 }, [
            skill('b-orc-1', '砸击', { cooldown: 2.4, damage: damage(50, 66) })
          ])
        ]
      }, { maxTime: 30, seed: '43' })
    },
    {
      id: 'random-batch',
      name: '随机伤害与批量模拟',
      description: 'A 的「不稳定术」伤害在 20–180 间大幅波动，B 的「稳定术」伤害固定在 80。单次结果参考价值有限，适合用批量模拟观察胜率与战斗时长的分布范围。',
      recommendedRuns: 300,
      setupA: setup('A · 波动法师', {
        allies: [
          unit('a-gambler', '波动法师', { maxHp: 640, atk: 50, def: 20, speed: 96 }, [
            skill('a-gambler-1', '不稳定术', {
              cooldown: 1.6,
              damage: damage(20, 180)
            })
          ])
        ],
        enemies: [
          unit('b-brute', '蛮兵', { maxHp: 900, atk: 46, def: 30, speed: 84 }, [
            skill('b-brute-1', '猛击', {
              cooldown: 2,
              damage: damage(48, 64)
            })
          ])
        ]
      }, { maxTime: 30, seed: '77' }),
      setupB: setup('B · 稳定法师', {
        allies: [
          unit('a-gambler', '稳定法师', { maxHp: 640, atk: 50, def: 20, speed: 96 }, [
            skill('a-gambler-1', '稳定术', {
              cooldown: 1.6,
              damage: damage(80, 80)
            })
          ])
        ],
        enemies: [
          unit('b-brute', '蛮兵', { maxHp: 900, atk: 46, def: 30, speed: 84 }, [
            skill('b-brute-1', '猛击', {
              cooldown: 2,
              damage: damage(48, 64)
            })
          ])
        ]
      }, { maxTime: 30, seed: '77' })
    }
  ];

  function getSample(id) {
    for (var i = 0; i < samples.length; i++) {
      if (samples[i].id === id) return clone(samples[i]);
    }
    return null;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  return {
    samples: samples,
    getSample: getSample
  };
});
