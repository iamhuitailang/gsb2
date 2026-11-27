import { clanCapacity, generateResident, getClan } from './generator.js';
import { streamFor } from './rng.js';
import type { NamingRules, Resident, ResidentSpec, TownState } from './types.js';

/**
 * 城镇：持有一份可持久化状态，所有操作只追加、不改写老居民。
 */
export class Town {
  constructor(public readonly state: TownState) {}

  static create(townId: string, seed: string, rules: NamingRules): Town {
    return new Town({ townId, seed, rules, residents: [], nextSerial: 1 });
  }

  get residents(): readonly Resident[] {
    return this.state.residents;
  }

  find(id: string): Resident {
    const r = this.state.residents.find((x) => x.id === id);
    if (!r) throw new Error(`城镇 ${this.state.townId} 没有居民 ${id}`);
    return r;
  }

  private countFullName = (fullName: string): number =>
    this.state.residents.filter((r) => r.fullName === fullName).length;

  private nextId(): string {
    const id = `r-${String(this.state.nextSerial).padStart(4, '0')}`;
    this.state.nextSerial += 1;
    return id;
  }

  private commit(spec: ResidentSpec, inheritedSurname?: { surname: string; side: 'father' | 'mother' }): Resident {
    const ctx = {
      townId: this.state.townId,
      seed: this.state.seed,
      rules: this.state.rules,
      countFullName: this.countFullName,
      ...(inheritedSurname ? { inheritedSurname } : {}),
    };
    const resident = generateResident(spec, ctx);
    this.state.residents.push(resident);
    return resident;
  }

  /** 新增普通居民（无父母记录）。 */
  addResident(clanId: string): Resident {
    getClan(this.state.rules, clanId); // 提前校验族群存在
    return this.commit({ id: this.nextId(), clanId });
  }

  /**
   * 新增子女：可继承父家或母家的姓，族群跟随被继承的一边。
   * inheritFrom = 'auto' 时由子女自己的随机流决定，重放结果一致。
   */
  addChild(opts: {
    fatherId?: string;
    motherId?: string;
    inheritFrom?: 'father' | 'mother' | 'auto';
  }): Resident {
    const { fatherId, motherId } = opts;
    const father = fatherId ? this.find(fatherId) : undefined;
    const mother = motherId ? this.find(motherId) : undefined;
    if (!father && !mother) throw new Error('addChild 至少需要一位家长');

    let side: 'father' | 'mother';
    if (father && mother) {
      const pref = opts.inheritFrom ?? 'auto';
      if (pref === 'auto') {
        // 注意：id 必须先定，决定结果只依赖 (seed, townId, id)
        const id = this.nextId();
        side = streamFor(this.state.seed, this.state.townId, id, 'inherit').int(2) === 0 ? 'father' : 'mother';
        const parent = side === 'father' ? father : mother;
        const spec: ResidentSpec = {
          id,
          clanId: parent.clanId,
          inheritFrom: 'auto',
          ...(fatherId ? { fatherId } : {}),
          ...(motherId ? { motherId } : {}),
        };
        return this.commit(spec, { surname: parent.surname, side });
      }
      side = pref;
    } else {
      side = father ? 'father' : 'mother';
    }

    const parent = side === 'father' ? father! : mother!;
    const spec: ResidentSpec = {
      id: this.nextId(),
      clanId: parent.clanId,
      inheritFrom: side,
      ...(fatherId ? { fatherId } : {}),
      ...(motherId ? { motherId } : {}),
    };
    return this.commit(spec, { surname: parent.surname, side });
  }

  /**
   * 迁居：把本城居民迁入目标城镇。名字与来历原样保留，
   * 目标城名册追加一条 migratedFrom 记录。
   */
  migrateOut(residentId: string, target: Town): Resident {
    const r = this.find(residentId);
    const spec: ResidentSpec = {
      id: target.nextId(),
      clanId: r.clanId,
      migratedFrom: {
        townId: this.state.townId,
        name: r.fullName,
        surname: r.surname,
        given: r.given,
        suffix: r.suffix,
        provenance: r.provenance,
      },
    };
    return target.commit(spec);
  }

  /** 各族群剩余容量报告：词库快用尽时能提前看出哪个族群会卡住。 */
  capacityReport(): Array<{ clanId: string; label: string; capacity: number; used: number; remaining: number }> {
    return this.state.rules.clans.map((clan) => {
      const capacity = clanCapacity(clan);
      const used = this.state.residents.filter((r) => r.clanId === clan.id && !r.migratedFrom).length;
      return { clanId: clan.id, label: clan.label, capacity, used, remaining: capacity - used };
    });
  }

  /** 导出已生成居民（JSON 字符串）。 */
  exportResidents(): string {
    return JSON.stringify(
      this.state.residents.map((r) => ({
        id: r.id,
        fullName: r.fullName,
        clanId: r.clanId,
        originTownId: r.originTownId,
        grandfathered: r.grandfathered === true,
      })),
      null,
      2,
    );
  }
}

/**
 * 从状态中的“规格”重放整个名册，重新生成所有名字。
 * 用于验证：同一城镇 + 同一规则 + 同一种子 ⇒ 名册可完整重建。
 */
export function replayRoster(state: TownState): Resident[] {
  const replayed: Resident[] = [];
  const countFullName = (fullName: string): number =>
    replayed.filter((r) => r.fullName === fullName).length;

  for (const r of state.residents) {
    const spec: ResidentSpec = {
      id: r.id,
      clanId: r.clanId,
      ...(r.fatherId ? { fatherId: r.fatherId } : {}),
      ...(r.motherId ? { motherId: r.motherId } : {}),
      ...(r.inheritFrom ? { inheritFrom: r.inheritFrom } : {}),
      ...(r.migratedFrom ? { migratedFrom: r.migratedFrom } : {}),
    };
    let inheritedSurname: { surname: string; side: 'father' | 'mother' } | undefined;
    if (!r.migratedFrom && (r.fatherId || r.motherId)) {
      let side: 'father' | 'mother';
      if (r.inheritFrom === 'father' || r.inheritFrom === 'mother') {
        side = r.inheritFrom;
      } else {
        // auto：与 Town.addChild 用同一条派生流重放决定
        side =
          streamFor(state.seed, state.townId, r.id, 'inherit').int(2) === 0 ? 'father' : 'mother';
      }
      const parentId = side === 'father' ? r.fatherId : r.motherId;
      const parent = replayed.find((x) => x.id === parentId);
      if (!parent) throw new Error(`重放失败：找不到家长 ${parentId}`);
      inheritedSurname = { surname: parent.surname, side };
    }
    const ctx = {
      townId: state.townId,
      seed: state.seed,
      rules: state.rules,
      countFullName,
      ...(inheritedSurname ? { inheritedSurname } : {}),
    };
    replayed.push(generateResident(spec, ctx));
  }
  return replayed;
}

/** 校验重放结果与已存名册逐字段一致。 */
export function verifyRoster(state: TownState): { ok: boolean; mismatches: string[] } {
  const replayed = replayRoster(state);
  const mismatches: string[] = [];
  for (let i = 0; i < state.residents.length; i++) {
    const a = state.residents[i]!;
    const b = replayed[i]!;
    if (a.fullName !== b.fullName) {
      mismatches.push(`${a.id}: 存档名 ${a.fullName} != 重放名 ${b.fullName}`);
    }
    if (JSON.stringify(a.provenance) !== JSON.stringify(b.provenance)) {
      mismatches.push(`${a.id}: 来历记录不一致`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
