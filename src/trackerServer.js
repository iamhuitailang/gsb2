import http from 'node:http';
import { send } from './util.js';

/**
 * 第二个本地站点。它只做一件事：统计自己收到了多少次请求。
 * 样例报告里有一张指向这里的图片；如果隔离预览生效，这里的计数必须保持为 0。
 */
export function createTrackerServer({ config, events }) {
  const handler = (req, res) => {
    const url = new URL(req.url, config.origins.tracker);
    const entry = {
      at: new Date().toISOString(),
      host: req.headers.host ?? '',
      path: url.pathname + url.search,
      referer: req.headers.referer ?? '',
      secFetchSite: req.headers['sec-fetch-site'] ?? '',
    };
    events.trackerRequests.push(entry);
    if (events.trackerRequests.length > 500) events.trackerRequests.shift();

    if (url.pathname === '/count') {
      return send(res, 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      }, JSON.stringify({ count: events.trackerRequests.filter((r) => r.path !== '/count').length }));
    }

    if (url.pathname === '/pixel.png') {
      // 1×1 透明 GIF；请求到达这里就说明“外部资源被自动加载了”。
      const gif = Buffer.from(
        'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        'base64',
      );
      return send(res, 200, {
        'Content-Type': 'image/gif',
        'Cache-Control': 'no-store',
      }, gif);
    }

    return send(res, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    }, '<!DOCTYPE html><html><body><h1>第二个本地站点</h1><p>仅用于验证隔离预览没有自动加载外部资源。</p></body></html>');
  };

  return { handler };
}
