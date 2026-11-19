// 运行参数与业务常量。端口可用环境变量覆盖，便于测试时并行启动。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const AUTH_PORT = Number(process.env.GSB_AUTH_PORT || 4000);
export const APP_A_PORT = Number(process.env.GSB_APP_A_PORT || 4101);
export const APP_B_PORT = Number(process.env.GSB_APP_B_PORT || 4102);

// 授权服务/接口的基础地址。本地演示固定走 127.0.0.1，避免 localhost 解析差异。
export const AUTH_ORIGIN = `http://127.0.0.1:${AUTH_PORT}`;

export const STATE_FILE_NAME = 'state.json';
export const CLIENTS_FILE_NAME = 'clients.json';
export const AUDIT_FILE_NAME = 'audit.log';

// 有效期（秒）
export const CODE_TTL = 60;
export const ACCESS_TOKEN_TTL = 15 * 60;
export const REFRESH_TOKEN_TTL = 14 * 24 * 60 * 60;
export const SESSION_TTL = 8 * 60 * 60;
export const PENDING_REQUEST_TTL = 10 * 60;

// 可授权范围。工单系统对外只暴露两类能力：
//  - tickets:read   只读，且只返回标题，绝不返回正文/状态；
//  - tickets:update 更新状态，不含读取正文。
export const SCOPES = {
  'tickets:read': {
    label: '查看工单标题（只读）',
    description: '读取当前用户有权访问的工单标题，仅标题，不含正文和状态，不能做任何修改。',
  },
  'tickets:update': {
    label: '更新工单状态',
    description: '修改当前用户有权访问的工单状态。仍受用户自身的工单可见范围限制。',
  },
};

export const ALL_SCOPES = Object.keys(SCOPES);

export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

export const TICKET_STATUS_LABELS = {
  open: '待处理',
  in_progress: '处理中',
  resolved: '已解决',
  closed: '已关闭',
};

// 演示应用定义。两个应用各有独立凭据，且甲只能申请只读范围。
export const DEMO_APPS = {
  'app-a': {
    clientId: 'app-a',
    name: '甲应用（只读演示）',
    port: APP_A_PORT,
    redirectUri: `http://127.0.0.1:${APP_A_PORT}/callback`,
    allowedScopes: ['tickets:read'],
  },
  'app-b': {
    clientId: 'app-b',
    name: '乙应用（可更新演示）',
    port: APP_B_PORT,
    redirectUri: `http://127.0.0.1:${APP_B_PORT}/callback`,
    allowedScopes: ['tickets:read', 'tickets:update'],
  },
};

export function dataPaths(dataDir) {
  return {
    dir: dataDir,
    state: path.join(dataDir, STATE_FILE_NAME),
    clients: path.join(dataDir, CLIENTS_FILE_NAME),
    audit: path.join(dataDir, AUDIT_FILE_NAME),
  };
}
