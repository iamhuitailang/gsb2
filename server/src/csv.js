import { parse } from 'csv-parse/sync';

// CSV 表头（中文）-> 内部字段名
export const FIELD_MAP = {
  申请编号: 'applicationNo',
  业务类型: 'businessType',
  申请人姓名: 'applicantName',
  手机号: 'phone',
  身份证号: 'idCard',
  邮箱: 'email',
  申请金额: 'amount',
  所在城市: 'city',
  详细住址: 'address',
  银行账号: 'bankAccount',
  申请说明: 'remark',
};

export const REQUIRED_FIELDS = [
  'applicationNo',
  'businessType',
  'applicantName',
  'phone',
  'idCard',
  'email',
  'amount',
  'city',
  'address',
  'bankAccount',
];

const BUSINESS_TYPES = new Set(['新申请', '变更', '续期', '注销']);

function normalizePhone(v) {
  return String(v).replace(/[\s-]/g, '');
}

export function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const rows = parse(text, {
    columns: (header) => header.map((h) => h.trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  if (rows.length === 0) {
    throw new Error('CSV 内容为空');
  }

  const header = Object.keys(rows[0]);
  const missingHeaders = Object.keys(FIELD_MAP).filter((h) => !header.includes(h));
  if (missingHeaders.length) {
    throw new Error(`CSV 缺少必需列：${missingHeaders.join('、')}`);
  }

  const seen = new Set(); // 所有出现过的申请编号（含校验失败行），保证重复编号一定被发现
  const records = [];
  const errors = [];

  rows.forEach((raw, idx) => {
    const rowNo = idx + 2; // 表头占第 1 行
    const payload = {};
    for (const [cn, en] of Object.entries(FIELD_MAP)) {
      payload[en] = (raw[cn] ?? '').toString().trim();
    }
    const applicationNo = payload.applicationNo;

    const rowErrors = [];
    if (!applicationNo) rowErrors.push('申请编号为空');
    else if (seen.has(applicationNo)) rowErrors.push(`申请编号 ${applicationNo} 在文件内重复`);
    for (const f of REQUIRED_FIELDS) {
      if (!payload[f]) rowErrors.push(`字段 ${f} 为空`);
    }
    if (payload.phone && !/^1[3-9]\d{9}$/.test(normalizePhone(payload.phone))) {
      rowErrors.push('手机号格式不正确');
    }
    payload.phone = normalizePhone(payload.phone);
    if (payload.idCard && !/^\d{17}[\dXx]$/.test(payload.idCard)) {
      rowErrors.push('身份证号格式不正确');
    }
    if (payload.email && !/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(payload.email)) {
      rowErrors.push('邮箱格式不正确');
    }
    if (payload.amount && (Number.isNaN(Number(payload.amount)) || Number(payload.amount) <= 0)) {
      rowErrors.push('申请金额必须为正数');
    }
    if (payload.businessType && !BUSINESS_TYPES.has(payload.businessType)) {
      rowErrors.push(`业务类型必须为：${[...BUSINESS_TYPES].join('/')}`);
    }

    if (rowErrors.length) {
      errors.push({ rowNo, applicationNo: applicationNo || '(空)', messages: rowErrors });
    } else {
      records.push({ rowNo, applicationNo, payload });
    }
    if (applicationNo) seen.add(applicationNo); // 编号无论本行是否有效都登记，后续重复行必被捕获
  });

  return { records, errors };
}
