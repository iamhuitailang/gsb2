// 工单领域：用户可见范围 + 对外只暴露最小字段。
import { TICKET_STATUSES } from '../config.js';

// 用户能访问的工单：工单所属团队在用户的团队集合内，或用户是该工单的发起人。
// 这是“当前用户还能访问的工单”的唯一判定入口，每次请求实时计算，
// 不把结论固化进令牌/授权记录，从而保证权限随用户可见范围即时收紧。
export function canAccessTicket(user, ticket) {
  if (!user || !ticket) return false;
  if (ticket.requesterUsername && ticket.requesterUsername === user.username) return true;
  const teams = Array.isArray(user.teams) ? user.teams : [];
  return teams.includes(ticket.team);
}

export function visibleTickets(state, user) {
  return state.tickets
    .filter((t) => canAccessTicket(user, t))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// 只读视图：仅 id + title。绝不返回正文、状态、发起人等任何额外字段。
export function toReadView(ticket) {
  return { id: ticket.id, title: ticket.title };
}

// 写操作返回体：仅回写后的 id + status，属于本次写操作的结果，不是读取接口。
export function toStatusView(ticket) {
  return { id: ticket.id, status: ticket.status };
}

export function isValidStatus(status) {
  return TICKET_STATUSES.includes(status);
}
