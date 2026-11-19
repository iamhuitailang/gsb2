// 种子数据：用户、工单、两个演示应用及其独立凭据。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DEMO_APPS } from './config.js';
import { hashPassword, hashSecret, randomToken } from './util.js';

export const DEMO_PASSWORD = 'ticket-demo-pass';

// 两个用户，可见范围不同，用于验证“权限不超过当前用户还能访问的工单”。
//  alice: 平台组 + 自己是发起人的工单
//  bob:   平台组、运维组
export const DEMO_USERS = [
  {
    username: 'alice',
    displayName: '爱丽丝',
    teams: ['platform'],
  },
  {
    username: 'bob',
    displayName: '鲍勃',
    teams: ['platform', 'ops'],
  },
];

// 两张工单：
//  T-1001 属于 platform 组，alice 与 bob 都能看到（alice 也是发起人）。
//  T-1002 属于 ops 组，只有 ops 组（bob）能看到；alice 看不到。
//  发起人刻意设为系统外的演示用户，避免“发起人可见”掩盖团队可见性的验证。
export const DEMO_TICKETS = [
  {
    id: 'T-1001',
    title: '登录页偶发白屏',
    body: '复现步骤：多次刷新登录页，偶尔白屏。',
    status: 'open',
    team: 'platform',
    requesterUsername: 'alice',
  },
  {
    id: 'T-1002',
    title: '导出报表超时',
    body: '导出超过 50 万行时接口超时。',
    status: 'in_progress',
    team: 'ops',
    requesterUsername: 'dave',
  },
];

export async function seedUsers(state) {
  if (state.users.length > 0) return { created: 0 };
  for (const u of DEMO_USERS) {
    const { salt, hash } = hashPassword(DEMO_PASSWORD);
    state.users.push({
      username: u.username,
      displayName: u.displayName,
      teams: [...u.teams],
      passwordSalt: salt,
      passwordHash: hash,
      active: true,
    });
  }
  return { created: DEMO_USERS.length };
}

export async function seedTickets(state) {
  if (state.tickets.length > 0) return { created: 0 };
  for (const t of DEMO_TICKETS) {
    state.tickets.push({ ...t });
  }
  return { created: DEMO_TICKETS.length };
}

function makeClient(def, redirectUri) {
  const secret = randomToken('cs_');
  const secretSalt = randomToken();
  return {
    client: {
      clientId: def.clientId,
      name: def.name,
      redirectUris: [redirectUri],
      allowedScopes: [...def.allowedScopes],
      secretSalt,
      secretHash: hashSecret(secret, secretSalt),
      active: true,
      createdAt: Math.floor(Date.now() / 1000),
    },
    secret,
  };
}

// 为两个演示应用生成独立凭据。已有同 clientId 且凭据文件存在时，保留原有 secret，
// 避免每次启动都让应用手里的旧 secret 失效。redirectUris 允许测试覆盖注册回调地址。
export async function seedClients(state, { clientsFile = null, redirectUris = {} } = {}) {
  let existing = {};
  if (clientsFile) {
    try {
      existing = JSON.parse(await fsp.readFile(clientsFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  const provisioned = { ...existing };
  const created = [];
  for (const def of Object.values(DEMO_APPS)) {
    const redirectUri = redirectUris[def.clientId] || def.redirectUri;
    let record = state.clients.find((c) => c.clientId === def.clientId);
    if (!record) {
      const { client, secret } = makeClient(def, redirectUri);
      state.clients.push(client);
      provisioned[def.clientId] = {
        clientId: def.clientId,
        name: def.name,
        redirectUri,
        clientSecret: secret,
      };
      created.push(def.clientId);
      continue;
    }
    // 注册信息以代码为准（redirect/scope），凭据沿用已有 secret。
    record.name = def.name;
    record.redirectUris = [redirectUri];
    record.allowedScopes = [...def.allowedScopes];
    if (!provisioned[def.clientId]) {
      // 状态里有客户端但凭据文件丢失：此时无法恢复旧 secret，重新签发。
      const secret = randomToken('cs_');
      record.secretSalt = randomToken();
      record.secretHash = hashSecret(secret, record.secretSalt);
      provisioned[def.clientId] = {
        clientId: def.clientId,
        name: def.name,
        redirectUri,
        clientSecret: secret,
      };
      created.push(def.clientId);
    } else {
      // 已注册的凭据文件里的 redirectUri 也要同步，供测试/环境覆盖使用。
      provisioned[def.clientId].redirectUri = redirectUri;
    }
  }
  if (clientsFile) {
    await fsp.mkdir(path.dirname(clientsFile), { recursive: true });
    await fsp.writeFile(clientsFile, JSON.stringify(provisioned, null, 2), { mode: 0o600 });
  }
  return { created, provisioned };
}

export async function seedAll(store, { clientsFile = null, redirectUris = {} } = {}) {
  return store.transaction(async (state) => {
    const users = await seedUsers(state);
    const tickets = await seedTickets(state);
    const clients = await seedClients(state, { clientsFile, redirectUris });
    return { users, tickets, clients, credentials: clients.provisioned };
  });
}
