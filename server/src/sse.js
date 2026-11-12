// 极简 SSE 总线：任务执行过程中的状态变化实时推给执行台
import { EventEmitter } from 'node:events';

class SseBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  emitJob(jobId, event, data) {
    this.emit(`job:${jobId}`, { event, data });
  }
}

export const sseBus = new SseBus();

export function sseHandler(req, res) {
  const jobId = req.params.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');

  const listener = ({ event, data }) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const channel = `job:${jobId}`;
  sseBus.on(channel, listener);

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseBus.off(channel, listener);
  });
}
