/**
 * API 请求鉴权与授权。
 *
 * 每把钥匙调用查库存 / 提交盘点时都要走同一套核对：
 * 1. 明文 -> 哈希，定位钥匙；
 * 2. 钥匙本身处于可用状态（生效中或轮换重叠期，且未到截止时刻）；
 * 3. 所属服务账号仍启用（管理员停用账号 -> 所有钥匙立即失效）；
 * 4. 请求动作与仓库同时落在钥匙范围和服务账号权限内（双重边界）。
 */
import { hashSecret, isUsable } from './credentials.js';
import { err } from './errors.js';

export function extractSecret(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) {
    throw err.unauthorized('缺少 Authorization: Bearer <apiKey> 请求头');
  }
  const secret = header.slice('Bearer '.length).trim();
  if (!secret) throw err.unauthorized('钥匙为空');
  return secret;
}

/**
 * 核对一次调用是否被允许。
 * @returns {{account: object, key: object}}
 */
export function authorize(store, clock, req, action, warehouse) {
  const secret = extractSecret(req);
  const key = store.findKeyByHash(hashSecret(secret));
  if (!key) throw err.unauthorized('钥匙不存在或已被删除');

  if (!isUsable(key, clock)) {
    throw err.unauthorized('钥匙已失效（到期或吊销）');
  }

  const account = store.findAccount(key.serviceAccountId);
  if (!account) throw err.unauthorized('服务账号不存在');
  if (!account.enabled) {
    // 管理员提前停用整个服务账号：所有钥匙立即失效
    throw err.unauthorized('所属服务账号已停用，钥匙立即失效');
  }

  if (!key.actions.includes(action)) {
    throw err.forbidden(`钥匙范围不包含动作 ${action}`);
  }
  if (warehouse && !key.warehouses.includes(warehouse)) {
    throw err.forbidden(`钥匙范围不包含仓库 ${warehouse}`);
  }
  // 第二层边界：即使钥匙记录里写着权限，也不能突破服务账号当前权限
  if (!account.allowedActions.includes(action)) {
    throw err.forbidden(`服务账号无权执行动作 ${action}`);
  }
  if (warehouse && !account.allowedWarehouses.includes(warehouse)) {
    throw err.forbidden(`服务账号无权访问仓库 ${warehouse}`);
  }

  return { account, key };
}
