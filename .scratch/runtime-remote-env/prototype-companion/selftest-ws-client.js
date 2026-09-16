#!/usr/bin/env node
'use strict';
// Throwaway sanity check for ui-ext/ws-client.js: spins up a minimal WS server
// (no Chrome, no VS Code needed) that sends fake Runtime.consoleAPICalled
// events, and checks the client parses all of them with correct payloads.
// Run: node selftest-ws-client.js
const http = require('http');
const crypto = require('crypto');
const { connectCdp } = require('./ui-ext/ws-client');

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, payload]);
}

function acceptKey(clientKey) {
  return crypto
    .createHash('sha1')
    .update(clientKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

const server = http.createServer();
server.on('upgrade', (req, socket) => {
  const accept = acceptKey(req.headers['sec-websocket-key']);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const total = 25;
  let sent = 0;
  const timer = setInterval(() => {
    if (sent >= total) {
      clearInterval(timer);
      socket.end();
      return;
    }
    const evt = {
      method: 'Runtime.consoleAPICalled',
      params: {
        args: [
          { type: 'string', value: 'PROTO_LOG' },
          { type: 'number', value: sent },
          { type: 'number', value: Date.now() },
        ],
      },
    };
    socket.write(frame(1, Buffer.from(JSON.stringify(evt), 'utf8')));
    sent++;
  }, 5);
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const received = [];
  const cdp = await connectCdp(`ws://127.0.0.1:${port}/`, (msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      received.push(msg.params.args[1].value);
    }
  });
  cdp.send('Runtime.enable');

  setTimeout(() => {
    const expected = Array.from({ length: 25 }, (_, i) => i);
    const ok = received.length === 25 && expected.every((v, i) => received[i] === v);
    console.log(`received ${received.length}/25 events in order: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) console.log('got:', received);
    server.close();
    process.exit(ok ? 0 : 1);
  }, 500);
});
