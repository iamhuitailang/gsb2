"""纯标准库的演示用签名实现（RSA PKCS#1 v1.5 + SHA-256）。

警告：仅为离线演示而写，未做侧信道防护，常数时间等一概不保证。
真实环境请换成经过审计的库（如 cryptography 的 Ed25519）。
"""
from __future__ import annotations

import hashlib
import json
import secrets

# SHA-256 的 DigestInfo 前缀（PKCS#1 v1.5）
_SHA256_DER_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def _is_probable_prime(n: int, rounds: int = 16) -> bool:
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d = n - 1
    r = 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _gen_prime(bits: int) -> int:
    while True:
        candidate = secrets.randbits(bits) | (1 << (bits - 1)) | 1
        if _is_probable_prime(candidate):
            return candidate


def generate_keypair(bits: int = 2048):
    """返回 (public_dict, private_dict)。私钥只应写入受保护的本地文件。"""
    if bits < 512 or bits % 2:
        raise ValueError("bits 必须是 >=512 的偶数")
    e = 65537
    while True:
        p = _gen_prime(bits // 2)
        q = _gen_prime(bits // 2)
        if p == q:
            continue
        phi = (p - 1) * (q - 1)
        if phi % e == 0:
            continue
        d = pow(e, -1, phi)
        break
    n = p * q
    pub = {"kty": "demo-rsa", "n": format(n, "x"), "e": format(e, "x")}
    priv = dict(pub)
    priv["d"] = format(d, "x")
    return pub, priv


def key_id(pub: dict) -> str:
    """公钥的稳定标识（公钥内容的短摘要），用于清单和日志中引用钥匙。"""
    blob = json.dumps(pub, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def _emsa_encode(data: bytes, em_len: int) -> bytes:
    digest_info = _SHA256_DER_PREFIX + hashlib.sha256(data).digest()
    if em_len < len(digest_info) + 11:
        raise ValueError("密钥长度不足")
    padding = b"\xff" * (em_len - len(digest_info) - 3)
    return b"\x00\x01" + padding + b"\x00" + digest_info


def sign(priv: dict, data: bytes) -> bytes:
    n = int(priv["n"], 16)
    d = int(priv["d"], 16)
    em_len = (n.bit_length() + 7) // 8
    m = int.from_bytes(_emsa_encode(data, em_len), "big")
    return pow(m, d, n).to_bytes(em_len, "big")


def verify(pub: dict, data: bytes, signature: bytes) -> bool:
    try:
        n = int(pub["n"], 16)
        e = int(pub["e"], 16)
        em_len = (n.bit_length() + 7) // 8
        if len(signature) != em_len:
            return False
        m = pow(int.from_bytes(signature, "big"), e, n)
        return m.to_bytes(em_len, "big") == _emsa_encode(data, em_len)
    except Exception:
        return False
