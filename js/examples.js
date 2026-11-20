/*
 * 内置演示示例：覆盖正常轮换、旧钥匙提前移除、相同标识换内容、
 * 重复标识、签发者不匹配、密钥信息不足六种场景。
 * 所有密钥材料均为演示用假数据，不对应任何真实提供方。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OidcExamples = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 演示用 RSA 公钥参数（虚构）
  const N_A = '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_rcvB8dsoZfHJKf8jKgTHz6wZgMIyTywGLHZvM';
  const N_B = 'sXchd8KXYEu6QqFkTzR3gX0mV7wJ2yN5bH8cL1pA4dF6gI9oU0eS3rT7vW2xZ5aB8cD1eF4gH6jK9lM2nP5qR7sT0uV3wX6yZ1aB4cE7dF9gH2iK5lM8nO1pQ4rS6tU9vW2xY5zA7bC0dE3fG6hI9jK1lM4nO7pQ0rS3tU6vW9xY2zA5bC8dE1fG4hI7jK0lM3nO6pQ9rS2tU5vW8xY1zA4bC7dE0fG3hI6jK9lM2nO5pQ8';
  const N_C = 'mVz8xK2nP5qR7sT0uV3wX6yZ1aB4cE7dF9gH2iK5lM8nO1pQ4rS6tU9vW2xY5zA7bC0dE3fG6hI9jK1lM4nO7pQ0rS3tU6vW9xY2zA5bC8dE1fG4hI7jK0lM3nO6pQ9rS2tU5vW8xY1zA4bC7dE0fG3hI6jK9lM2nO5pQ8rS1tU4vW7xY0zA3bC6dE9fG2hI5jK8lM1nO4pQ7rS0tU3vW6xY9zA2bC5dE8fG1hI4jK7lM0n';
  const N_D = 'kLw3nP6qS9tU1vX4yZ7aB0cE3dF6gH9iK2lM5nO8pQ1rS4tU7vW0xY3zA6bC9dE2fG5hI8jK1lM4nO7pQ0rS3tU6vW9xY2zA5bC8dE1fG4hI7jK0lM3nO6pQ9rS2tU5vW8xY1zA4bC7dE0fG3hI6jK9lM2nO5pQ8rS1tU4vW7xY0zA3bC6dE9fG2hI5jK8lM1nO4pQ7rS0tU3vW6xY9zA2bC5dE8fG1hI4jK7lM0nP3q';

  function rsaKey(kid, n, alg) {
    return { kty: 'RSA', kid, use: 'sig', alg: alg || 'RS256', n, e: 'AQAB' };
  }

  function goodDiscovery(issuer) {
    return {
      issuer,
      authorization_endpoint: issuer + '/authorize',
      token_endpoint: issuer + '/oauth/token',
      userinfo_endpoint: issuer + '/userinfo',
      jwks_uri: issuer + '/.well-known/jwks.json',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    };
  }

  const IDP = 'https://idp.example.com';

  const scenarios = [
    {
      id: 'normal-rotation',
      title: '正常轮换（通过）',
      description: '新密钥先与旧密钥并行发布，旧密钥保留，无断档。',
      env: {
        name: 'demo-正常轮换',
        expectedIssuer: IDP,
        discovery: goodDiscovery(IDP),
        snapshots: [
          { label: '2026-09 快照', jwks: { keys: [rsaKey('key-1', N_A), rsaKey('key-2', N_B)] } },
          { label: '2026-11 快照', jwks: { keys: [rsaKey('key-1', N_A), rsaKey('key-2', N_B), rsaKey('key-3', N_C)] } },
        ],
      },
    },
    {
      id: 'early-removal',
      title: '旧钥匙提前移除（需要关注）',
      description: '第二份快照中旧密钥 key-1 被直接移除，仍在有效期内的令牌可能无法验证。',
      env: {
        name: 'demo-旧钥匙提前移除',
        expectedIssuer: IDP,
        discovery: goodDiscovery(IDP),
        snapshots: [
          { label: '2026-09 快照', jwks: { keys: [rsaKey('key-1', N_A), rsaKey('key-2', N_B)] } },
          { label: '2026-11 快照', jwks: { keys: [rsaKey('key-2', N_B)] } },
        ],
      },
    },
    {
      id: 'kid-reuse',
      title: '相同标识换了密钥内容（拒绝）',
      description: 'kid "key-1" 不变，但公钥内容被替换，验证方无法区分新旧密钥。',
      env: {
        name: 'demo-标识复用',
        expectedIssuer: IDP,
        discovery: goodDiscovery(IDP),
        snapshots: [
          { label: '2026-09 快照', jwks: { keys: [rsaKey('key-1', N_A), rsaKey('key-2', N_B)] } },
          { label: '2026-11 快照', jwks: { keys: [rsaKey('key-1', N_D), rsaKey('key-2', N_B)] } },
        ],
      },
    },
    {
      id: 'duplicate-kid',
      title: '重复密钥标识（拒绝）',
      description: '同一份 JWKS 中 kid "key-1" 出现两次。',
      env: {
        name: 'demo-重复标识',
        expectedIssuer: IDP,
        discovery: goodDiscovery(IDP),
        snapshots: [
          { label: '2026-11 快照', jwks: { keys: [rsaKey('key-1', N_A), rsaKey('key-1', N_D), rsaKey('key-2', N_B)] } },
        ],
      },
    },
    {
      id: 'issuer-mismatch',
      title: '签发者不匹配（拒绝）',
      description: '预期签发者为 https://idp.example.com，文档中却是另一个地址，且 jwks_uri 指向不同源。',
      env: {
        name: 'demo-签发者不匹配',
        expectedIssuer: IDP,
        discovery: {
          issuer: 'https://login.example-corp.net',
          authorization_endpoint: 'https://login.example-corp.net/authorize',
          token_endpoint: 'https://login.example-corp.net/oauth/token',
          userinfo_endpoint: 'https://login.example-corp.net/userinfo',
          jwks_uri: 'https://static-files.example.org/jwks.json',
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        },
        snapshots: [
          { label: '2026-11 快照', jwks: { keys: [rsaKey('key-1', N_A)] } },
        ],
      },
    },
    {
      id: 'incomplete-keys',
      title: '密钥信息不足（无法确认）',
      description: '包含缺少 kid、密钥类型不支持、未声明 alg 的密钥，均标为无法确认而非可信。',
      env: {
        name: 'demo-信息不足',
        expectedIssuer: IDP,
        discovery: goodDiscovery(IDP),
        snapshots: [
          {
            label: '2026-11 快照',
            jwks: {
              keys: [
                rsaKey('key-1', N_A),
                { kty: 'RSA', use: 'sig', alg: 'RS256', n: N_B, e: 'AQAB' },
                { kty: 'OKP', kid: 'key-3', use: 'sig', alg: 'EdDSA', crv: 'Ed25519', x: '11qYAYdkxLr2p5dHkB8z9cV7nM3jF6gH1iK4lN8oP0q' },
                { kty: 'RSA', kid: 'key-4', use: 'sig', n: N_C, e: 'AQAB' },
              ],
            },
          },
        ],
      },
    },
  ];

  return { scenarios };
});
