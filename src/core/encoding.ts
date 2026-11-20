/** Float32Array / Uint8Array 与 base64 互转，用于工程文件内嵌高度数据。 */

export function encodeBase64(arr: Float32Array | Uint8Array): string {
  const bytes =
    arr instanceof Uint8Array ? arr : new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = "";
  // 分块拼接，避免长数组触发调用参数上限
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function decodeBase64(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // 复制到按 4 字节对齐的新缓冲，再以 Float32 视图读取
  const aligned = new ArrayBuffer(bytes.length);
  new Uint8Array(aligned).set(bytes);
  return new Float32Array(aligned);
}
