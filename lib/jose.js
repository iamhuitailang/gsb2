// 本地 JWT 签发/校验工具，仅用于离线演示，不连接任何真实身份服务。
// 支持 RS256 / ES256 / none（none 只用于演示被拒绝的场景）。
// 签名统一走 Node 内置 Web Crypto：ECDSA 直接产出 JOSE 要求的原始 r||s，免去 DER 转换。
import crypto from 'node:crypto';

const webcrypto = crypto.webcrypto;

export function b64u(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function b64uJson(obj) {
  return b64u(JSON.stringify(obj));
}

export function parseB64uJson(segment) {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64url').toString('utf8'));
}

function webAlg(alg) {
  if (alg === 'RS256') return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  if (alg === 'ES256') return { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  throw new Error(`不支持的密钥算法: ${alg}`);
}

function keyGenParams(alg) {
  if (alg === 'RS256') {
    return { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  }
  if (alg === 'ES256') return { name: 'ECDSA', namedCurve: 'P-256' };
  throw new Error(`不支持的密钥算法: ${alg}`);
}

// 生成演示用密钥对（私钥仅存于本地 data 文件，不进仓库、不进入任何 API 响应）
export function generateKeyPair(alg) {
  if (alg !== 'RS256' && alg !== 'ES256') throw new Error(`不支持的密钥算法: ${alg}`);
  return webcrypto.subtle.generateKey(
    keyGenParams(alg),
    true,
    ['sign', 'verify'],
  );
}

// 公钥 -> 演示用 JWK（只含公开参数）
export async function publicJwk(cryptoKey, kid, alg) {
  const jwk = await webcrypto.subtle.exportKey('jwk', cryptoKey);
  delete jwk.key_ops;
  delete jwk.ext;
  return { ...jwk, kid, alg, use: 'sig' };
}

// 私钥 -> 可持久化的 JWK（只落本地 data 文件，不对外返回）
export async function privateJwk(cryptoKey) {
  return webcrypto.subtle.exportKey('jwk', cryptoKey);
}

export async function importPrivateJwk(jwk) {
  const alg = guessAlg(jwk);
  const clean = { ...jwk };
  delete clean.kid;
  delete clean.alg;
  delete clean.use;
  return webcrypto.subtle.importKey('jwk', clean, webAlg(alg), false, ['sign']);
}

function guessAlg(jwk) {
  if (jwk.kty === 'EC') return 'ES256';
  return 'RS256';
}

export async function importPublicJwk(jwk) {
  const alg = jwk.alg || guessAlg(jwk);
  const clean = { ...jwk };
  delete clean.kid;
  delete clean.alg;
  delete clean.use;
  delete clean.status;
  return webcrypto.subtle.importKey('jwk', clean, webAlg(alg), false, ['verify']);
}

// 签发紧凑 JWT。headerAlg 用于制造“header 声明算法与实际签名算法不一致”的演示样例
export async function signJwt({ alg, key, kid, payload, headerAlgOverride = null }) {
  const header = { alg: headerAlgOverride || alg, typ: 'JWT' };
  if (kid !== undefined) header.kid = kid;
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  if (alg === 'none') {
    return `${signingInput}.`;
  }
  const sigBuf = await webcrypto.subtle.sign(webAlg(alg), key, Buffer.from(signingInput));
  return `${signingInput}.${Buffer.from(sigBuf).toString('base64url')}`;
}

// 验证签名；返回 true/false，不抛异常
export async function verifySignature({ alg, publicKey, signingInput, signature }) {
  try {
    if (alg === 'none') return false;
    return await webcrypto.subtle.verify(
      webAlg(alg),
      publicKey,
      Buffer.from(signature, 'base64url'),
      Buffer.from(signingInput),
    );
  } catch {
    return false;
  }
}

export function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
