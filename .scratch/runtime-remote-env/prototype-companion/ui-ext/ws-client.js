'use strict';
// Throwaway: thin wrapper around the repo's already-hoisted `ws` dependency
// (see packages/server/src/runtime-log.ts, which uses the same package for
// its own CDP connection) — resolves via node_modules walk-up from the repo
// root, no local install needed.
const WebSocket = require('ws');

function connectCdp(wsUrl, onMessage) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    ws.once('open', () => {
      resolve({
        send(methodOrObj, params) {
          const obj =
            typeof methodOrObj === 'object'
              ? methodOrObj
              : { id: nextId++, method: methodOrObj, params: params || {} };
          ws.send(JSON.stringify(obj));
        },
        close() {
          ws.close();
        },
      });
    });
    ws.once('error', reject);
    ws.on('message', (data) => {
      try {
        onMessage(JSON.parse(data.toString('utf8')));
      } catch {
        // ignore malformed/partial message for this throwaway client
      }
    });
  });
}

module.exports = { connectCdp };
