/**
 * Small display helpers: canonical string breakdown, whitespace visualisation,
 * and masking for sensitive header values.
 */

const FIELD_LABELS = {
  METHOD: "方法（大写）",
  PATH: "路径（百分号编码）",
  QUERY: "查询串（排序后）",
  TIMESTAMP: "时间戳（秒）",
  NONCE: "nonce（原样）",
  "KEY-ID": "密钥 ID",
  "BODY-SHA256": "请求体 SHA-256",
};

export function describeCanonical(canonicalString) {
  if (!canonicalString) return [];
  return canonicalString.split("\n").map((line, index) => {
    if (index === 0) {
      return { index, label: "协议行", key: line, value: line };
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      return { index, label: "未知行", key: line, value: line };
    }
    const key = line.slice(0, colon);
    return {
      index,
      label: FIELD_LABELS[key] || key,
      key,
      value: line.slice(colon + 1),
    };
  });
}

export function visibleWhitespace(value) {
  if (!value) return "";
  return value.replace(/ /g, "·").replace(/\t/g, "→");
}

export function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}
