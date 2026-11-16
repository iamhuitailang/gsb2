import assert from 'node:assert/strict';
import test from 'node:test';

import { INVITE_STATUS, ROLES, Store } from '../src/store.js';

function freshStore() {
  return new Store({ seed: true });
}

function setup() {
  const store = freshStore();
  const admin = store.findUserByEmail('admin@gsb2.local');
  const alice = store.findUserByEmail('alice@example.com');
  const bob = store.findUserByEmail('bob@example.com');
  const unverified = store.findUserByEmail('unverified@example.com');
  return { store, admin, alice, bob, unverified };
}

function tokenFromInbox(store, email) {
  const messages = store.listMessagesForEmail(email).filter((m) => m.kind === 'invite');
  return messages[0]?.token ?? null;
}

test('受邀邮箱与实际账号不一致时不能接受', () => {
  const { store, admin, bob } = setup();
  const sent = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  assert.equal(sent.ok, true);

  const result = store.acceptInvite({ token: sent.token, userId: bob.id });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'email_mismatch');
  assert.equal(store.findMembership('team-jia', bob.id), null);
  assert.equal(store.getInvite(sent.invite.id).status, INVITE_STATUS.PENDING);
});

test('邮箱未验证的账号不能接受邀请', () => {
  const { store, admin, unverified } = setup();
  const sent = store.createInvite({
    email: 'unverified@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  const result = store.acceptInvite({ token: sent.token, userId: unverified.id });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'email_unverified');
  assert.equal(store.getInvite(sent.invite.id).status, INVITE_STATUS.PENDING);
});

test('同一用户可同时收到多个团队邀请，各团队独立处理', () => {
  const { store, admin, alice } = setup();
  const jia = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  const yi = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-yi',
    role: ROLES.VIEWER,
    actorUserId: admin.id,
  });

  assert.equal(store.acceptInvite({ token: jia.token, userId: alice.id }).ok, true);
  // Accepting 甲 leaves 乙 pending.
  assert.equal(store.getInvite(yi.invite.id).status, INVITE_STATUS.PENDING);

  const second = store.acceptInvite({ token: yi.token, userId: alice.id });
  assert.equal(second.ok, true);
  assert.equal(store.findMembership('team-jia', alice.id).role, ROLES.EDITOR);
  assert.equal(store.findMembership('team-yi', alice.id).role, ROLES.VIEWER);
});

test('改发邀请后旧链接作废，新链接接受得到新角色（甲团队编辑→只读）', () => {
  const { store, admin, alice } = setup();
  const first = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  const second = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.VIEWER,
    actorUserId: admin.id,
  });

  assert.equal(store.getInvite(first.invite.id).status, INVITE_STATUS.SUPERSEDED);
  assert.equal(store.getInvite(second.invite.id).status, INVITE_STATUS.PENDING);

  const old = store.acceptInvite({ token: first.token, userId: alice.id });
  assert.equal(old.ok, false);
  assert.equal(old.reason, 'not_pending');

  const fresh = store.acceptInvite({ token: second.token, userId: alice.id });
  assert.equal(fresh.ok, true);
  assert.equal(store.findMembership('team-jia', alice.id).role, ROLES.VIEWER);
});

test('改发甲团队邀请不影响乙团队邀请，乙仍可接受', () => {
  const { store, admin, alice } = setup();
  const yi = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-yi',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  const jiaOld = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.VIEWER,
    actorUserId: admin.id,
  });

  assert.equal(store.getInvite(jiaOld.invite.id).status, INVITE_STATUS.SUPERSEDED);
  assert.equal(store.getInvite(yi.invite.id).status, INVITE_STATUS.PENDING);

  const result = store.acceptInvite({ token: yi.token, userId: alice.id });
  assert.equal(result.ok, true);
  assert.equal(store.findMembership('team-yi', alice.id).role, ROLES.EDITOR);
});

test('已有成员再次打开同一邀请不会生成重复成员关系', () => {
  const { store, admin, alice } = setup();
  const sent = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });

  assert.equal(store.acceptInvite({ token: sent.token, userId: alice.id }).ok, true);
  const membershipCount = store.listMembershipsForTeam('team-jia').length;

  const again = store.acceptInvite({ token: sent.token, userId: alice.id });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'not_pending');
  assert.equal(store.listMembershipsForTeam('team-jia').length, membershipCount);
});

test('已有成员重复接受新邀请也不重复生成成员关系', () => {
  const { store, admin, alice } = setup();
  const first = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  store.acceptInvite({ token: first.token, userId: alice.id });

  const second = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.VIEWER,
    actorUserId: admin.id,
  });
  const result = store.acceptInvite({ token: second.token, userId: alice.id });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyMember, true);
  assert.equal(store.listMembershipsForTeam('team-jia').length, 1);
});

test('旧邀请不能把管理员已调整的新角色改回去', () => {
  const { store, admin, alice } = setup();
  // alice becomes a member with 编辑.
  const initial = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  store.acceptInvite({ token: initial.token, userId: alice.id });

  // A still-pending invite carrying the old 编辑 role exists.
  const stale = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  assert.equal(store.getInvite(stale.invite.id).status, INVITE_STATUS.PENDING);

  // Admin downgrades the member directly, after the stale invite was created.
  const adjusted = store.setMemberRole({
    teamId: 'team-jia',
    userId: alice.id,
    role: ROLES.VIEWER,
  });
  assert.equal(adjusted.ok, true);

  // Accepting the older invite must not restore 编辑.
  const replay = store.acceptInvite({ token: stale.token, userId: alice.id });
  assert.equal(replay.ok, true);
  assert.equal(replay.roleApplied, false);
  assert.equal(store.findMembership('team-jia', alice.id).role, ROLES.VIEWER);
  assert.equal(store.listMembershipsForTeam('team-jia').length, 1);
});

test('调整角色后新发出的邀请可以应用新角色', () => {
  const { store, admin, alice } = setup();
  const first = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.VIEWER,
    actorUserId: admin.id,
  });
  store.acceptInvite({ token: first.token, userId: alice.id });
  store.setMemberRole({ teamId: 'team-jia', userId: alice.id, role: ROLES.VIEWER });

  const newer = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  const result = store.acceptInvite({ token: newer.token, userId: alice.id });
  assert.equal(result.ok, true);
  assert.equal(result.roleApplied, true);
  assert.equal(store.findMembership('team-jia', alice.id).role, ROLES.EDITOR);
});

test('撤销后接受、接受后撤销都只有一个最终结果', () => {
  const { store, admin, alice } = setup();

  const revokedFirst = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  assert.equal(store.revokeInvite({ inviteId: revokedFirst.invite.id, actorUserId: admin.id }).ok, true);
  const afterRevoke = store.acceptInvite({ token: revokedFirst.token, userId: alice.id });
  assert.equal(afterRevoke.ok, false);
  assert.equal(afterRevoke.reason, 'not_pending');
  assert.equal(store.getInvite(revokedFirst.invite.id).status, INVITE_STATUS.REVOKED);
  assert.equal(store.findMembership('team-jia', alice.id), null);

  const acceptedFirst = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-yi',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  assert.equal(store.acceptInvite({ token: acceptedFirst.token, userId: alice.id }).ok, true);
  const revokeAfterAccept = store.revokeInvite({
    inviteId: acceptedFirst.invite.id,
    actorUserId: admin.id,
  });
  assert.equal(revokeAfterAccept.ok, false);
  assert.equal(revokeAfterAccept.reason, 'not_pending');
  assert.equal(store.getInvite(acceptedFirst.invite.id).status, INVITE_STATUS.ACCEPTED);
});

test('撤销与接受并发时只有一个成功', async () => {
  const { store, admin, alice } = setup();
  const sent = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });

  // Node is single-threaded, but both branches still race through the event
  // loop; the synchronous check-and-set must let exactly one win.
  const outcomes = await Promise.all([
    Promise.resolve().then(() =>
      store.acceptInvite({ token: sent.token, userId: alice.id }),
    ),
    Promise.resolve().then(() =>
      store.revokeInvite({ inviteId: sent.invite.id, actorUserId: admin.id }),
    ),
  ]);

  const successes = outcomes.filter((outcome) => outcome.ok);
  assert.equal(successes.length, 1, 'exactly one of accept/revoke may win');

  const finalStatus = store.getInvite(sent.invite.id).status;
  const membership = store.findMembership('team-jia', alice.id);
  if (finalStatus === INVITE_STATUS.ACCEPTED) {
    assert.ok(membership, 'accepted invite must have created a membership');
  } else {
    assert.equal(finalStatus, INVITE_STATUS.REVOKED);
    assert.equal(membership, null, 'revoked invite must not create a membership');
  }
});

test('角色以服务端邀请记录为准，链接参数无法影响角色', () => {
  const { store, admin, alice } = setup();
  const sent = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.VIEWER,
    actorUserId: admin.id,
  });
  // The accept API intentionally takes only token + userId.
  const result = store.acceptInvite({ token: sent.token, userId: alice.id, role: ROLES.EDITOR });
  assert.equal(result.ok, true);
  assert.equal(store.findMembership('team-jia', alice.id).role, ROLES.VIEWER);
});

test('本地收件箱按受邀邮箱投递，他人看不到', () => {
  const { store, admin } = setup();
  store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  const aliceMessages = store.listMessagesForEmail('alice@example.com');
  const bobMessages = store.listMessagesForEmail('bob@example.com');
  assert.equal(aliceMessages.length, 1);
  assert.equal(bobMessages.length, 0);
  assert.ok(tokenFromInbox(store, 'alice@example.com'));
});

test('邀请令牌不可被猜测，服务端只存哈希', () => {
  const { store, admin } = setup();
  const sent = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: ROLES.EDITOR,
    actorUserId: admin.id,
  });
  const invite = store.getInvite(sent.invite.id);
  assert.equal(invite.token, undefined);
  assert.notEqual(invite.tokenHash, sent.token);
  assert.equal(store.findInviteByToken('not-a-real-token'), null);
  assert.equal(store.findInviteByToken(sent.token).id, sent.invite.id);
});

test('非管理员不能通过存储层伪造邀请之外的越权', () => {
  const { store } = setup();
  // Team names are resolved from the server-side team record.
  const bad = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-does-not-exist',
    role: ROLES.EDITOR,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid_team');

  const badRole = store.createInvite({
    email: 'alice@example.com',
    teamId: 'team-jia',
    role: 'owner',
  });
  assert.equal(badRole.ok, false);
  assert.equal(badRole.reason, 'invalid_role');
});
