/* sample-data.js — 内置虚构台账。浏览器挂 window.SampleData，Node 下可 require。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SampleData = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 深拷贝，避免演示操作互相污染
  function clone(x) {
    return JSON.parse(JSON.stringify(x));
  }

  /**
   * 标准场景：
   *   原料 R1 经生产 PRD-H1 / PRD-H2 拆成半成品 H1、H2；
   *   H1、H2 合并进同一成品批次 P1（两条路径都指向 P1）；
   *   原料 R2 单独产出成品 P2（与 R1 无关）；
   *   P1 分两单出库 6 件、4 件；P2 出库 3 件。
   */
  function fullLedger() {
    return {
      materials: [
        { batchId: 'R1', name: '高筋面粉', supplier: '江北粮贸', inboundDate: '2026-11-02', qty: 1000 },
        { batchId: 'R2', name: '白砂糖', supplier: '南方糖业', inboundDate: '2026-11-03', qty: 400 },
      ],
      production: [
        { id: 'PRD-H1', outputBatch: 'H1', stage: '半成品', inputs: ['R1'], outputDate: '2026-11-04', note: '和面分拆批次 1' },
        { id: 'PRD-H2', outputBatch: 'H2', stage: '半成品', inputs: ['R1'], outputDate: '2026-11-04', note: '和面分拆批次 2' },
        { id: 'PRD-P1', outputBatch: 'P1', stage: '成品', inputs: ['H1', 'H2'], outputDate: '2026-11-05', note: '两批半成品合并烘烤' },
        { id: 'PRD-P2', outputBatch: 'P2', stage: '成品', inputs: ['R2'], outputDate: '2026-11-06', note: '糖浆批次' },
      ],
      outbound: [
        { id: 'OUT-1', orderNo: 'SO-1001', productBatch: 'P1', qty: 6, shipDate: '2026-11-07', customer: '联华超市' },
        { id: 'OUT-2', orderNo: 'SO-1002', productBatch: 'P1', qty: 4, shipDate: '2026-11-08', customer: '大润发门店' },
        { id: 'OUT-3', orderNo: 'SO-1003', productBatch: 'P2', qty: 3, shipDate: '2026-11-09', customer: '便利店联盟' },
      ],
      corrections: [],
    };
  }

  /** 演示"台账后到"：移除 H2 的生产记录（R1 的第二条路径暂时断掉）。 */
  function withLateLedger() {
    const data = fullLedger();
    data.production = data.production.filter((p) => p.id !== 'PRD-H2');
    return data;
  }

  return { fullLedger, withLateLedger, clone };
});
