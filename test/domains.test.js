'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSeed } = require('../server/store');
const { createService, ServiceError } = require('../server/service');

const HOUR = 60 * 60 * 1000;

function setup() {
  const db = createSeed();
  const service = createService(db);
  return { db, service };
}

function stepClock(service, ms) {
  service.setClock({ offsetMs: (service.now() - Date.now()) + ms });
}

function idsOfTodos(service, userId) {
  return service.listTodos(userId).map((todo) => todo.id);
}

test('乙接受委托后：门店一可见，门店二不可见', () => {
  const { service } = setup();
  const todos = idsOfTodos(service, 'u_yi');
  assert.deepEqual(todos.sort(), ['a1', 'a2']);

  assert.throws(
    () => service.getApplicationForUser('u_yi', 'a3'),
    (error) => error.status === 403 && error.code === 'NO_PERMISSION'
  );
});

test('乙在门店二上无法提交审核（范围外）', () => {
  const { service } = setup();
  assert.throws(
    () => service.decide('u_yi', 'a3', 'approve', ''),
    (error) => error.status === 403
  );
});

test('乙通过代审通过门店一申请，记录代审来源', () => {
  const { service } = setup();
  const result = service.decide('u_yi', 'a1', 'approve', '同意');
  assert.equal(result.application.status, 'approved');
  assert.equal(result.application.decision.via.type, 'delegation');
  assert.equal(result.application.decision.via.delegationId, 'd1');
  assert.deepEqual(idsOfTodos(service, 'u_yi'), ['a2']);
});

test('委托到期后：待办消失，直接地址仍被拦住', () => {
  const { service } = setup();
  assert.deepEqual(idsOfTodos(service, 'u_yi').sort(), ['a1', 'a2']);

  stepClock(service, 2 * HOUR + 60 * 1000);

  assert.deepEqual(idsOfTodos(service, 'u_yi'), []);
  assert.throws(
    () => service.getApplicationForUser('u_yi', 'a1'),
    (error) => error.status === 403 && error.code === 'DELEGATION_EXPIRED'
  );
  assert.throws(
    () => service.decide('u_yi', 'a1', 'approve', ''),
    (error) => error.status === 403 && error.code === 'DELEGATION_EXPIRED'
  );
});

test('主管提前结束委托：待办消失，审核页与提交都被拦', () => {
  const { service } = setup();
  service.endDelegation('u_jia', 'd1', '休假取消');

  assert.deepEqual(idsOfTodos(service, 'u_yi'), []);
  assert.throws(
    () => service.getApplicationForUser('u_yi', 'a1'),
    (error) => error.code === 'DELEGATION_ENDED'
  );
  assert.throws(
    () => service.decide('u_yi', 'a1', 'approve', ''),
    (error) => error.code === 'DELEGATION_ENDED'
  );
});

test('主管权限被收回：代审权限同步失效', () => {
  const { service } = setup();
  service.setGrantActive('u_jia', 's1', false);

  assert.deepEqual(idsOfTodos(service, 'u_yi'), []);
  assert.throws(
    () => service.decide('u_yi', 'a1', 'approve', ''),
    (error) => error.code === 'DELEGATOR_PERMISSION_REVOKED'
  );

  // 主管自己的权限被收回后也不能审
  assert.throws(
    () => service.decide('u_jia', 'a1', 'approve', ''),
    (error) => error.status === 403
  );
});

test('主管的权限继续有效（委托不影响自有权限）', () => {
  const { service } = setup();
  const result = service.decide('u_jia', 'a3', 'approve', '');
  assert.equal(result.application.status, 'approved');
  assert.equal(result.application.decision.via.type, 'direct');
});

test('委托范围不能超过发起人当前权限', () => {
  const { service } = setup();
  service.setGrantActive('u_jia', 's1', false);

  assert.throws(
    () =>
      service.createDelegation({
        delegatorId: 'u_jia',
        delegateeId: 'u_bing',
        storeIds: ['s1'],
        actions: ['approve'],
        startsAt: new Date(service.now()).toISOString(),
        endsAt: new Date(service.now() + HOUR).toISOString()
      }),
    (error) => error.status === 403 && error.code === 'SCOPE_EXCEEDS_OWN_PERMISSION'
  );
});

test('可以用当前自有权限发起委托，但审核动作必须被勾选', () => {
  const { service } = setup();
  assert.throws(
    () =>
      service.createDelegation({
        delegatorId: 'u_jia',
        delegateeId: 'u_bing',
        storeIds: ['s2'],
        actions: ['view'],
        startsAt: new Date(service.now()).toISOString(),
        endsAt: new Date(service.now() + HOUR).toISOString()
      }),
    (error) => error.code === 'ACTION_REQUIRED'
  );

  const { delegation } = service.createDelegation({
    delegatorId: 'u_jia',
    delegateeId: 'u_bing',
    storeIds: ['s2'],
    actions: ['approve'],
    startsAt: new Date(service.now()).toISOString(),
    endsAt: new Date(service.now() + HOUR).toISOString()
  });
  // approve 隐含 view
  assert.deepEqual(delegation.actions, ['view', 'approve']);
  assert.equal(delegation.status, 'pending_acceptance');
  // 未接受前不生效
  assert.ok(!idsOfTodos(service, 'u_bing').includes('a3'));
  service.acceptDelegation('u_bing', delegation.id);
  assert.ok(idsOfTodos(service, 'u_bing').includes('a3'));
});

test('受托人不能再把代来的权限委托给第三人', () => {
  const { service } = setup();
  assert.throws(
    () =>
      service.createDelegation({
        delegatorId: 'u_yi',
        delegateeId: 'u_bing',
        storeIds: ['s1'],
        actions: ['approve'],
        startsAt: new Date(service.now()).toISOString(),
        endsAt: new Date(service.now() + HOUR).toISOString()
      }),
    (error) => error.status === 403 && error.code === 'DELEGATION_CANNOT_BE_REDELEGATED'
  );
});

test('委托结束后受托人仍不能转委托（权限已不存在）', () => {
  const { service } = setup();
  service.endDelegation('u_jia', 'd1');
  assert.throws(
    () =>
      service.createDelegation({
        delegatorId: 'u_yi',
        delegateeId: 'u_bing',
        storeIds: ['s1'],
        actions: ['approve'],
        startsAt: new Date(service.now()).toISOString(),
        endsAt: new Date(service.now() + HOUR).toISOString()
      }),
    (error) => error.status === 403 && error.code === 'SCOPE_EXCEEDS_OWN_PERMISSION'
  );
});

test('只有被委托人可接受；只有发起人可结束', () => {
  const { service } = setup();
  const { delegation } = service.createDelegation({
    delegatorId: 'u_jia',
    delegateeId: 'u_bing',
    storeIds: ['s2'],
    actions: ['approve'],
    startsAt: new Date(service.now()).toISOString(),
    endsAt: new Date(service.now() + HOUR).toISOString()
  });

  assert.throws(
    () => service.acceptDelegation('u_yi', delegation.id),
    (error) => error.code === 'NOT_DELEGATEE'
  );
  assert.throws(
    () => service.endDelegation('u_yi', delegation.id),
    (error) => error.code === 'NOT_DELEGATOR'
  );
});

test('未生效的委托不能用于审核', () => {
  const { service } = setup();
  const { delegation } = service.createDelegation({
    delegatorId: 'u_jia',
    delegateeId: 'u_bing',
    storeIds: ['s2'],
    actions: ['approve'],
    startsAt: new Date(service.now() + HOUR).toISOString(),
    endsAt: new Date(service.now() + 2 * HOUR).toISOString()
  });
  service.acceptDelegation('u_bing', delegation.id);

  assert.throws(
    () => service.getApplicationForUser('u_bing', 'a3'),
    (error) => error.code === 'DELEGATION_NOT_STARTED'
  );

  stepClock(service, HOUR + 1000);
  assert.ok(idsOfTodos(service, 'u_bing').includes('a3'));
});

test('申请被处理后再操作返回冲突，避免重复审核', () => {
  const { service } = setup();
  service.decide('u_yi', 'a1', 'approve', '');
  assert.throws(
    () => service.decide('u_yi', 'a1', 'reject', ''),
    (error) => error.status === 409 && error.code === 'APPLICATION_CLOSED'
  );
});

test('只委托 approve 时：可以查看、可以通过，但不能驳回', () => {
  const { service } = setup();
  const { delegation } = service.createDelegation({
    delegatorId: 'u_jia',
    delegateeId: 'u_bing',
    storeIds: ['s2'],
    actions: ['approve'],
    startsAt: new Date(service.now()).toISOString(),
    endsAt: new Date(service.now() + HOUR).toISOString()
  });
  service.acceptDelegation('u_bing', delegation.id);

  const detail = service.getApplicationForUser('u_bing', 'a3');
  assert.equal(detail.application.permission.canView, true);
  assert.equal(detail.application.permission.canApprove, true);
  assert.equal(detail.application.permission.canReject, false);

  assert.throws(
    () => service.decide('u_bing', 'a3', 'reject', ''),
    (error) => error.status === 403 && error.code === 'ACTION_NOT_DELEGATED'
  );
});

test('委托范围被部分收回时，只剩交集内的门店可审', () => {
  const { service } = setup();
  const { delegation } = service.createDelegation({
    delegatorId: 'u_jia',
    delegateeId: 'u_bing',
    storeIds: ['s1', 's2'],
    actions: ['approve'],
    startsAt: new Date(service.now()).toISOString(),
    endsAt: new Date(service.now() + HOUR).toISOString()
  });
  service.acceptDelegation('u_bing', delegation.id);
  assert.deepEqual(idsOfTodos(service, 'u_bing').sort(), ['a1', 'a2', 'a3', 'a4']);

  service.setGrantActive('u_jia', 's1', false);
  assert.deepEqual(idsOfTodos(service, 'u_bing').sort(), ['a3', 'a4']);
  assert.throws(
    () => service.getApplicationForUser('u_bing', 'a1'),
    (error) => error.code === 'DELEGATOR_PERMISSION_REVOKED'
  );
});

test('委托记录里能看到当前实际生效范围', () => {
  const { service } = setup();
  service.setGrantActive('u_jia', 's1', false);
  const state = service.getState('u_yi');
  const d1 = state.delegations.find((item) => item.id === 'd1');
  assert.equal(d1.revoked, true);
  assert.deepEqual(d1.effectiveScope, []);
  assert.equal(d1.status, 'active');
  assert.match(d1.statusLabel, /已失效/);
});

test('日志记录代审使用了哪条委托', () => {
  const { db, service } = setup();
  service.decide('u_yi', 'a2', 'reject', '毛利过低');
  const delegation = db.delegations.find((item) => item.id === 'd1');
  assert.equal(delegation.usage.length, 1);
  assert.equal(delegation.usage[0].applicationId, 'a2');
  assert.equal(delegation.usage[0].action, 'reject');
});

test('演示时钟可回拨，回到委托生效区间内', () => {
  const { service } = setup();
  stepClock(service, 3 * HOUR);
  assert.deepEqual(idsOfTodos(service, 'u_yi'), []);

  stepClock(service, -3 * HOUR);
  assert.deepEqual(idsOfTodos(service, 'u_yi').sort(), ['a1', 'a2']);
});

test('委托范围超出时给出具体缺少的动作', () => {
  const { service } = setup();
  service.setGrantActive('u_jia', 's1', false);
  try {
    service.createDelegation({
      delegatorId: 'u_jia',
      delegateeId: 'u_yi',
      storeIds: ['s1'],
      actions: ['approve'],
      startsAt: new Date(service.now()).toISOString(),
      endsAt: new Date(service.now() + HOUR).toISOString()
    });
    assert.fail('应当抛出错误');
  } catch (error) {
    assert.ok(error instanceof ServiceError);
    assert.match(error.message, /门店一/);
  }
});
