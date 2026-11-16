import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const ROLES = Object.freeze({ EDITOR: 'editor', VIEWER: 'viewer' });

export const ROLE_LABELS = Object.freeze({
  [ROLES.EDITOR]: '编辑',
  [ROLES.VIEWER]: '只读',
});

export const INVITE_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REVOKED: 'revoked',
  SUPERSEDED: 'superseded',
});

export const INVITE_STATUS_LABELS = Object.freeze({
  [INVITE_STATUS.PENDING]: '待接受',
  [INVITE_STATUS.ACCEPTED]: '已接受',
  [INVITE_STATUS.REVOKED]: '已撤销',
  [INVITE_STATUS.SUPERSEDED]: '已失效（已改发）',
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isValidEmail(value) {
  return EMAIL_RE.test(normalizeEmail(value));
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  const actual = scryptSync(String(password), salt, 64);
  const expected = Buffer.from(String(expectedHash), 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function emptyState() {
  return {
    seq: 0,
    users: [],
    teams: [],
    memberships: [],
    invites: [],
    messages: [],
  };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    emailVerified: Boolean(user.emailVerified),
  };
}

function publicInvite(invite) {
  if (!invite) return null;
  return {
    id: invite.id,
    email: invite.email,
    teamId: invite.teamId,
    role: invite.role,
    status: invite.status,
    createdAt: invite.createdAt,
    updatedAt: invite.updatedAt,
    acceptedAt: invite.acceptedAt ?? null,
    acceptedByUserId: invite.acceptedByUserId ?? null,
    supersededByInviteId: invite.supersededByInviteId ?? null,
  };
}

export class Store {
  constructor({ filePath = null, seed = true } = {}) {
    this.filePath = filePath;
    this.state = emptyState();
    if (filePath && existsSync(filePath)) {
      const loaded = JSON.parse(readFileSync(filePath, 'utf8'));
      this.state = { ...emptyState(), ...loaded };
      if (typeof this.state.seq !== 'number') this.state.seq = 0;
    } else if (seed) {
      seedDefaults(this);
    }
  }

  // ---- persistence -------------------------------------------------------

  save() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.filePath);
  }

  nextSeq() {
    this.state.seq += 1;
    return this.state.seq;
  }

  // ---- users -------------------------------------------------------------

  addUser({ email, name, role = 'member', emailVerified = true, password }) {
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) throw new Error(`invalid email: ${email}`);
    if (this.findUserByEmail(normalized)) {
      throw new Error(`duplicate email: ${normalized}`);
    }
    const { salt, hash } = hashPassword(password);
    const user = {
      id: randomUUID(),
      email: normalized,
      name,
      role,
      emailVerified,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
    };
    this.state.users.push(user);
    this.save();
    return publicUser(user);
  }

  findUserByEmail(email) {
    const normalized = normalizeEmail(email);
    return this.state.users.find((user) => user.email === normalized) ?? null;
  }

  getUser(id) {
    return this.state.users.find((user) => user.id === id) ?? null;
  }

  publicUser(id) {
    return publicUser(this.getUser(id));
  }

  listUsers() {
    return this.state.users.map(publicUser);
  }

  authenticate(email, password) {
    const user = this.findUserByEmail(email);
    if (!user) return null;
    if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) return null;
    return publicUser(user);
  }

  // ---- teams -------------------------------------------------------------

  listTeams() {
    return this.state.teams.map((team) => ({ ...team }));
  }

  getTeam(id) {
    return this.state.teams.find((team) => team.id === id) ?? null;
  }

  addTeam({ id, name }) {
    const team = { id: id ?? randomUUID(), name };
    this.state.teams.push(team);
    this.save();
    return team;
  }

  // ---- memberships -------------------------------------------------------

  findMembership(teamId, userId) {
    return (
      this.state.memberships.find(
        (membership) => membership.teamId === teamId && membership.userId === userId,
      ) ?? null
    );
  }

  listMembershipsForUser(userId) {
    return this.state.memberships
      .filter((membership) => membership.userId === userId)
      .map((membership) => ({
        ...membership,
        teamName: this.getTeam(membership.teamId)?.name ?? '未知团队',
      }))
      .sort((a, b) => a.teamName.localeCompare(b.teamName, 'zh-CN'));
  }

  listMembershipsForTeam(teamId) {
    return this.state.memberships
      .filter((membership) => membership.teamId === teamId)
      .map((membership) => {
        const user = this.getUser(membership.userId);
        return {
          ...membership,
          email: user?.email ?? '',
          name: user?.name ?? '',
        };
      });
  }

  /**
   * Directly adjust a member's role. This is deliberately the only way an
   * existing member's role changes; invites never overwrite a newer role.
   */
  setMemberRole({ teamId, userId, role }) {
    if (!Object.values(ROLES).includes(role)) {
      return { ok: false, reason: 'invalid_role' };
    }
    const membership = this.findMembership(teamId, userId);
    if (!membership) return { ok: false, reason: 'not_a_member' };
    membership.role = role;
    membership.roleUpdatedSeq = this.nextSeq();
    membership.updatedAt = new Date().toISOString();
    this.save();
    return { ok: true, membership: { ...membership } };
  }

  // ---- invites -----------------------------------------------------------

  /**
   * Send an invite. Any still-pending invite for the same (team, email) is
   * superseded, so exactly one link per team+email is live at a time. Other
   * teams are untouched.
   */
  createInvite({ email, teamId, role, actorUserId = null }) {
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) return { ok: false, reason: 'invalid_email' };
    const team = this.getTeam(teamId);
    if (!team) return { ok: false, reason: 'invalid_team' };
    if (!Object.values(ROLES).includes(role)) {
      return { ok: false, reason: 'invalid_role' };
    }

    const now = new Date().toISOString();
    const inviteId = randomUUID();
    const createdSeq = this.nextSeq();
    const token = randomBytes(32).toString('base64url');

    const superseded = [];
    for (const existing of this.state.invites) {
      if (
        existing.status === INVITE_STATUS.PENDING &&
        existing.teamId === teamId &&
        existing.email === normalized
      ) {
        existing.status = INVITE_STATUS.SUPERSEDED;
        existing.updatedAt = now;
        existing.supersededByInviteId = inviteId;
        superseded.push(existing.id);
      }
    }

    const invite = {
      id: inviteId,
      tokenHash: hashToken(token),
      email: normalized,
      teamId,
      role,
      status: INVITE_STATUS.PENDING,
      createdSeq,
      createdAt: now,
      updatedAt: now,
      createdByUserId: actorUserId,
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null,
      revokedByUserId: null,
      supersededByInviteId: null,
    };
    this.state.invites.push(invite);

    const actor = actorUserId ? this.getUser(actorUserId) : null;
    this.state.messages.push({
      id: randomUUID(),
      seq: this.nextSeq(),
      email: normalized,
      kind: 'invite',
      inviteId,
      token,
      subject: `邀请你加入「${team.name}」（${ROLE_LABELS[role]}）`,
      body:
        `${actor ? actor.name : '管理员'} 邀请你以「${ROLE_LABELS[role]}」身份加入「${team.name}」。` +
        `请用已验证的 ${normalized} 账号登录后打开邀请并接受。`,
      createdAt: now,
      readAt: null,
    });

    this.save();
    return { ok: true, invite: publicInvite(invite), token, superseded };
  }

  getInvite(id) {
    return this.state.invites.find((invite) => invite.id === id) ?? null;
  }

  findInviteByToken(token) {
    if (!token) return null;
    const tokenHash = hashToken(token);
    return (
      this.state.invites.find((invite) => invite.tokenHash === tokenHash) ?? null
    );
  }

  listInvites() {
    return [...this.state.invites]
      .sort((a, b) => b.createdSeq - a.createdSeq)
      .map((invite) => ({
        ...publicInvite(invite),
        teamName: this.getTeam(invite.teamId)?.name ?? '未知团队',
        createdByName: invite.createdByUserId
          ? (this.getUser(invite.createdByUserId)?.name ?? '-')
          : '-',
      }));
  }

  listInvitesForEmail(email) {
    const normalized = normalizeEmail(email);
    return this.state.invites
      .filter((invite) => invite.email === normalized)
      .sort((a, b) => b.createdSeq - a.createdSeq)
      .map(publicInvite);
  }

  /**
   * Revoke a pending invite. Returns a single, definite outcome: only a
   * pending invite transitions, everything else is reported as not_pending.
   */
  revokeInvite({ inviteId, actorUserId = null }) {
    const invite = this.getInvite(inviteId);
    if (!invite) return { ok: false, reason: 'not_found' };
    if (invite.status !== INVITE_STATUS.PENDING) {
      return { ok: false, reason: 'not_pending', status: invite.status };
    }
    // Synchronous critical section: no await between the check above and the
    // mutation below, so revoke/accept cannot both win.
    invite.status = INVITE_STATUS.REVOKED;
    invite.revokedAt = new Date().toISOString();
    invite.revokedByUserId = actorUserId;
    invite.updatedAt = invite.revokedAt;
    this.save();
    return { ok: true, invite: publicInvite(invite) };
  }

  /**
   * Accept an invite for a logged-in user.
   *
   * - The invite is located solely by its token; the role comes from the
   *   server-side invite record, never from the link/body.
   * - The account email must match the invited email and be verified.
   * - Exactly one of accept/revoke can transition the invite (synchronous
   *   check-and-set, no await in between).
   * - A user who is already a member never gets a duplicate membership.
   * - An invite older than the last role adjustment cannot revert that role;
   *   an invite created after the adjustment may apply its role.
   */
  acceptInvite({ token, userId }) {
    const invite = this.findInviteByToken(token);
    if (!invite) return { ok: false, reason: 'not_found' };
    if (invite.status !== INVITE_STATUS.PENDING) {
      return { ok: false, reason: 'not_pending', status: invite.status, invite: publicInvite(invite) };
    }

    const user = this.getUser(userId);
    if (!user) return { ok: false, reason: 'not_authenticated' };
    if (!user.emailVerified) {
      return { ok: false, reason: 'email_unverified', invite: publicInvite(invite) };
    }
    if (normalizeEmail(user.email) !== invite.email) {
      return { ok: false, reason: 'email_mismatch', invite: publicInvite(invite) };
    }

    // Claim the invite.
    const now = new Date().toISOString();
    invite.status = INVITE_STATUS.ACCEPTED;
    invite.acceptedAt = now;
    invite.acceptedByUserId = user.id;
    invite.updatedAt = now;

    let membership = this.findMembership(invite.teamId, user.id);
    let roleApplied = false;
    let alreadyMember = Boolean(membership);

    if (!membership) {
      membership = {
        id: randomUUID(),
        teamId: invite.teamId,
        userId: user.id,
        role: invite.role,
        createdSeq: this.nextSeq(),
        roleUpdatedSeq: this.state.seq,
        createdAt: now,
        updatedAt: now,
      };
      this.state.memberships.push(membership);
      roleApplied = true;
    } else if (invite.createdSeq > (membership.roleUpdatedSeq ?? 0)) {
      // The invite reflects a newer decision than the last role adjustment.
      membership.role = invite.role;
      membership.roleUpdatedSeq = this.nextSeq();
      membership.updatedAt = now;
      roleApplied = true;
    }

    this.save();
    return {
      ok: true,
      invite: publicInvite(invite),
      membership: { ...membership },
      teamName: this.getTeam(invite.teamId)?.name ?? '',
      roleApplied,
      alreadyMember,
    };
  }

  // ---- inbox -------------------------------------------------------------

  listMessagesForEmail(email) {
    const normalized = normalizeEmail(email);
    return this.state.messages
      .filter((message) => message.email === normalized)
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
      .map((message) => ({
        ...message,
        invite: message.inviteId ? publicInvite(this.getInvite(message.inviteId)) : null,
        teamName: message.inviteId
          ? (this.getTeam(this.getInvite(message.inviteId)?.teamId)?.name ?? '')
          : '',
      }));
  }

  countUnreadForEmail(email) {
    const normalized = normalizeEmail(email);
    return this.state.messages.filter(
      (message) => message.email === normalized && !message.readAt,
    ).length;
  }

  markMessagesReadForEmail(email) {
    const normalized = normalizeEmail(email);
    const now = new Date().toISOString();
    let changed = false;
    for (const message of this.state.messages) {
      if (message.email === normalized && !message.readAt) {
        message.readAt = now;
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

export function seedDefaults(store) {
  store.addTeam({ id: 'team-jia', name: '甲团队' });
  store.addTeam({ id: 'team-yi', name: '乙团队' });
  store.addTeam({ id: 'team-bing', name: '丙团队' });

  store.addUser({
    email: 'admin@gsb2.local',
    name: '管理员',
    role: 'admin',
    password: 'admin123',
  });
  store.addUser({
    email: 'alice@example.com',
    name: '李小雨',
    password: 'alice123',
  });
  store.addUser({
    email: 'bob@example.com',
    name: '王大明',
    password: 'bob123',
  });
  store.addUser({
    email: 'unverified@example.com',
    name: '未验证用户',
    password: 'unverified123',
    emailVerified: false,
  });
}
