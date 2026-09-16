#!/usr/bin/env node
'use strict';
// Throwaway: computes drop count + latency stats from a results/run-*.ndjson
// file recorded by workspace-ext. Usage:
//   node analyze.js results/run-commands.ndjson [expectedCount=3000]
const fs = require('fs');

const file = process.argv[2];
const expected = Number(process.argv[3] || 3000);
if (!file) {
  console.error('usage: node analyze.js <results/run-commands.ndjson|run-port.ndjson> [expectedCount=3000]');
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const rows = lines.map((l) => JSON.parse(l));
const seqs = new Set(rows.map((r) => r.seq));
const dropped = expected - seqs.size;
const latencies = rows.map((r) => r.tReceiveMs - r.tSendMs).sort((a, b) => a - b);
const median = latencies.length ? latencies[Math.floor(latencies.length / 2)] : NaN;
const max = latencies.length ? latencies[latencies.length - 1] : NaN;
const duplicates = Math.max(0, rows.length - seqs.size);

console.log(`file: ${file}`);
console.log(`expected: ${expected}`);
console.log(`rows recorded: ${rows.length}`);
console.log(`unique seq received: ${seqs.size}`);
console.log(`dropped: ${dropped}`);
console.log(`duplicate/replayed rows: ${duplicates}`);
console.log(`latency median: ${Number.isFinite(median) ? median.toFixed(1) : median} ms`);
console.log(`latency max: ${Number.isFinite(max) ? max.toFixed(1) : max} ms`);
console.log(`PASS (no loss, <200ms): ${dropped === 0 && max < 200 ? 'YES' : 'NO'}`);
