import { schedule, DEFAULT_CONFIG } from '../src/scheduler.js';
import { SAMPLES } from '../src/examples.js';

const lines = [];
for (const s of SAMPLES) {
  const p = schedule(DEFAULT_CONFIG, s.events);
  lines.push(`\n== ${s.id} ${JSON.stringify(p.summary)}`);
  for (const d of p.decisions) {
    lines.push(
      `  ${d.eventId.padEnd(4)} ${d.status.padEnd(9)} ${d.reasonCode.padEnd(19)} ` +
        `${String(d.plannedMs).padStart(5)} -> ${String(d.startMs ?? '-').padStart(6)} ` +
        `CH${d.channel ?? '-'}${d.victims.length ? ' cut:' + d.victims.join(',') : ''}`
    );
  }
}
console.log(lines.join('\n'));
