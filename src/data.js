/**
 * 演示数据。订单、联系人和地址均为虚构，请勿用于真实业务。
 */

export const SITES = Object.freeze([
  { id: 'site-a', name: '甲站' },
  { id: 'site-b', name: '乙站' },
]);

export const PERMISSIONS = Object.freeze({
  'contact:read': '联系人字段查看权限',
  'admin:users': '账号权限管理',
});

/**
 * 字段目录是页面、导出预览和 CSV 的唯一来源。
 * permission 为 null 表示所有登录客服都可查看；
 * page 表示该字段是否出现在订单列表页（列表默认只看订单号和状态）。
 */
export const FIELDS = Object.freeze([
  { key: 'order_no', label: '订单号', group: 'basic', permission: null, page: true },
  { key: 'status', label: '订单状态', group: 'basic', permission: null, page: true },
  { key: 'site', label: '站点', group: 'basic', permission: null, page: false },
  { key: 'amount', label: '订单金额', group: 'basic', permission: null, page: false },
  { key: 'created_at', label: '下单时间', group: 'basic', permission: null, page: false },
  { key: 'contact_name', label: '联系人姓名', group: 'contact', permission: 'contact:read', page: true },
  { key: 'contact_phone', label: '联系电话', group: 'contact', permission: 'contact:read', page: true },
  { key: 'contact_address', label: '收货地址', group: 'contact', permission: 'contact:read', page: true },
]);

export const ORDER_STATUSES = Object.freeze(['待发货', '已发货', '已完成', '已取消']);

export const USERS = Object.freeze({
  'agent-lin': {
    id: 'agent-lin',
    name: '客服小林',
    title: '客服 · 甲站',
    sites: ['site-a'],
    permissions: ['contact:read'],
    permissionVersion: 1,
  },
  'agent-zhou': {
    id: 'agent-zhou',
    name: '客服小周',
    title: '客服 · 乙站',
    sites: ['site-b'],
    permissions: [],
    permissionVersion: 1,
  },
  'lead-chen': {
    id: 'lead-chen',
    name: '主管小陈',
    title: '客服主管 · 甲乙站',
    sites: ['site-a', 'site-b'],
    permissions: [],
    permissionVersion: 1,
  },
  admin: {
    id: 'admin',
    name: '权限管理员',
    title: '演示管理员',
    sites: ['site-a', 'site-b'],
    permissions: ['admin:users'],
    permissionVersion: 1,
  },
});

export const ORDERS = Object.freeze([
  {
    id: 'o-a-1001',
    siteId: 'site-a',
    order_no: 'A20261116001',
    status: '待发货',
    amount: '128.00',
    created_at: '2026-11-16 09:12',
    contact_name: '林小满',
    contact_phone: '138-0000-0101',
    contact_address: '示例省甲市云杉路 18 号 3 栋 201（虚构）',
  },
  {
    id: 'o-a-1002',
    siteId: 'site-a',
    order_no: 'A20261116002',
    status: '已发货',
    amount: '86.50',
    created_at: '2026-11-16 10:05',
    contact_name: '周青禾',
    contact_phone: '138-0000-0102',
    contact_address: '示例省甲市青樟街 7 号 2 单元 502（虚构）',
  },
  {
    id: 'o-a-1003',
    siteId: 'site-a',
    order_no: 'A20261116003',
    status: '已完成',
    amount: '256.00',
    created_at: '2026-11-15 16:40',
    contact_name: '陈一川',
    contact_phone: '138-0000-0103',
    contact_address: '示例省甲市白榆巷 12 号（虚构）',
  },
  {
    id: 'o-a-1004',
    siteId: 'site-a',
    order_no: 'A20261116004',
    status: '已取消',
    amount: '49.90',
    created_at: '2026-11-15 11:22',
    contact_name: '苏叶',
    contact_phone: '138-0000-0104',
    contact_address: '示例省甲市枫桥路 5 号 1 栋 803（虚构）',
  },
  {
    id: 'o-a-1005',
    siteId: 'site-a',
    order_no: 'A20261116005',
    status: '待发货',
    amount: '399.00',
    created_at: '2026-11-14 20:18',
    contact_name: '何知夏',
    contact_phone: '138-0000-0105',
    contact_address: '示例省甲市竹影里 9 号（虚构）',
  },
  {
    id: 'o-b-2001',
    siteId: 'site-b',
    order_no: 'B20261116001',
    status: '待发货',
    amount: '76.00',
    created_at: '2026-11-16 08:30',
    contact_name: '顾南星',
    contact_phone: '139-0000-0201',
    contact_address: '示例省乙市松风路 21 号（虚构）',
  },
  {
    id: 'o-b-2002',
    siteId: 'site-b',
    order_no: 'B20261116002',
    status: '已发货',
    amount: '148.00',
    created_at: '2026-11-15 19:45',
    contact_name: '白露',
    contact_phone: '139-0000-0202',
    contact_address: '示例省乙市溪云街 3 号 1 单元 302（虚构）',
  },
  {
    id: 'o-b-2003',
    siteId: 'site-b',
    order_no: 'B20261116003',
    status: '已完成',
    amount: '32.80',
    created_at: '2026-11-15 14:08',
    contact_name: '江屿',
    contact_phone: '139-0000-0203',
    contact_address: '示例省乙市石楠巷 6 号（虚构）',
  },
  {
    id: 'o-b-2004',
    siteId: 'site-b',
    order_no: 'B20261116004',
    status: '待发货',
    amount: '520.00',
    created_at: '2026-11-14 12:55',
    contact_name: '温言',
    contact_phone: '139-0000-0204',
    contact_address: '示例省乙市青岚路 88 号 2 栋 1102（虚构）',
  },
  {
    id: 'o-b-2005',
    siteId: 'site-b',
    order_no: 'B20261116005',
    status: '已取消',
    amount: '19.90',
    created_at: '2026-11-13 17:02',
    contact_name: '许星阑',
    contact_phone: '139-0000-0205',
    contact_address: '示例省乙市听雨巷 4 号（虚构）',
  },
]);

export const SITE_BY_ID = Object.fromEntries(SITES.map((site) => [site.id, site]));
export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((field) => [field.key, field]));
