// 所有鉴权都在服务端完成：机构与角色一律从持久化的成员关系读取，
// 不接受客户端声明的角色，也不缓存权限判断结果。

export class HttpError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function findUser(store, userId) {
  return store.data.users.find((u) => u.id === userId) ?? null;
}

/** 读取用户在指定机构的“当前生效”成员关系；撤销过的记录直接视为不存在。 */
export function activeMembership(store, userId, orgId) {
  if (!orgId) return null;
  return (
    store.data.memberships.find(
      (m) => m.userId === userId && m.orgId === orgId && m.active === true && !m.revokedAt,
    ) ?? null
  );
}

export function membershipsOf(store, userId) {
  return store.data.memberships
    .filter((m) => m.userId === userId && m.active === true && !m.revokedAt)
    .map((m) => {
      const org = store.data.orgs.find((o) => o.id === m.orgId);
      return { orgId: m.orgId, orgName: org?.name ?? m.orgId, role: m.role, membershipId: m.id };
    });
}
export function findOrg(store, orgId) {
  return store.data.orgs.find((o) => o.id === orgId) ?? null;
}

/**
 * 每个请求都重新做一次：机构是否存在、成员关系是否仍然生效。
 * 返回 { membership, org }。
 */
export function requireMembership(store, userId, orgId) {
  const org = findOrg(store, orgId);
  if (!org) throw new HttpError(404, 'ORG_NOT_FOUND', '机构不存在');
  const membership = activeMembership(store, userId, orgId);
  if (!membership) {
    throw new HttpError(403, 'NO_ORG_ACCESS', '你已没有该机构的操作权限', { orgId });
  }
  return { org, membership };
}

/** 当前机构下，该成员可以看到的工单集合。主管=全机构，员工=分给自己的。 */
export function visibleTickets(store, membership) {
  const inOrg = store.data.tickets.filter((t) => t.orgId === membership.orgId);
  if (membership.role === 'supervisor') return inOrg;
  return inOrg.filter((t) => t.assigneeId === membership.userId);
}

export function canSeeTicket(membership, ticket) {
  if (!ticket || ticket.orgId !== membership.orgId) return false;
  if (membership.role === 'supervisor') return true;
  return ticket.assigneeId === membership.userId;
}

/** 详情 / 附件 / 导出统一走这里：先校验机构成员关系，再校验工单可见性。 */
export function requireTicketAccess(store, userId, orgId, ticketId) {
  const ctx = requireMembership(store, userId, orgId);
  const ticket = store.data.tickets.find((t) => t.id === ticketId && t.orgId === orgId);
  // 跨机构或不存在都返回 404，避免泄露其他机构的工单是否存在。
  if (!ticket) throw new HttpError(404, 'TICKET_NOT_FOUND', '工单不存在或不属于该机构');
  if (!canSeeTicket(ctx.membership, ticket)) {
    throw new HttpError(403, 'TICKET_FORBIDDEN', '你没有查看该工单的权限', { orgId, ticketId });
  }
  return { ...ctx, ticket };
}

export function isSupervisor(membership) {
  return membership?.role === 'supervisor';
}
