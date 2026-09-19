/**
 * Pure half of inline logpoints (.scratch/inline-logpoints/issues/01-core-logpoint.md). The end-to-end
 * behaviour against a real `node --inspect` is in packages/server/test/runtime-log-logpoints.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const {
  parseLogMessage,
  buildLogpointCondition,
  logpointIdFromUrl,
  runtimePathCandidates,
  logpointUrlRegex,
  parseConsoleApiCalled,
} = require('../dist');

test('parseLogMessage: splits text and {expressions}', () => {
  assert.deepStrictEqual(parseLogMessage('user = {user.name}, n = {items.length}'), [
    { kind: 'text', text: 'user = ' },
    { kind: 'expr', expr: 'user.name' },
    { kind: 'text', text: ', n = ' },
    { kind: 'expr', expr: 'items.length' },
  ]);
});

test('parseLogMessage: nested braces and braces inside strings stay in one expression', () => {
  assert.deepStrictEqual(parseLogMessage('{ {a: 1}.a } {"}"}'), [
    { kind: 'expr', expr: '{a: 1}.a' },
    { kind: 'text', text: ' ' },
    { kind: 'expr', expr: '"}"' },
  ]);
});

test('parseLogMessage: an unclosed brace leaves the rest as text; empty braces are dropped', () => {
  assert.deepStrictEqual(parseLogMessage('a {} b {x'), [{ kind: 'text', text: 'a  b {x' }]);
  assert.deepStrictEqual(parseLogMessage('plain'), [{ kind: 'text', text: 'plain' }]);
});

/**
 * Run a generated condition the way V8 would at the breakpoint: in a scope holding the locals,
 * with a console that records calls instead of printing.
 */
function evaluateCondition(condition, locals) {
  const calls = [];
  const context = vm.createContext({ console: { log: (...args) => calls.push(args) }, ...locals });
  const result = vm.runInContext(condition, context);
  return { result, calls };
}

test('buildLogpointCondition: logs text and values as separate arguments, and never pauses', () => {
  const condition = buildLogpointCondition({ id: 7, logMessage: 'n = {n}, obj = {obj}' });
  const { result, calls } = evaluateCondition(condition, { n: 3, obj: { a: 1 } });
  assert.strictEqual(result, false);
  assert.deepStrictEqual(calls, [['n = ', 3, ', obj = ', { a: 1 }]]);
  assert.match(condition, /\n\/\/# sourceURL=ejsng-logpoint-7$/);
});

test('buildLogpointCondition: a throwing expression becomes <message> instead of losing the line', () => {
  const condition = buildLogpointCondition({ id: 1, logMessage: 'bad = {nope.x}, ok = {n}' });
  const { result, calls } = evaluateCondition(condition, { n: 2 });
  assert.strictEqual(result, false);
  assert.deepStrictEqual(calls, [['bad = ', '<nope is not defined>', ', ok = ', 2]]);
});

test('buildLogpointCondition: logs only when the condition holds, and still never pauses', () => {
  const condition = buildLogpointCondition({ id: 1, logMessage: 'n = {n}', condition: 'n > 2 // big only' });
  assert.deepStrictEqual(evaluateCondition(condition, { n: 1 }), { result: false, calls: [] });
  assert.deepStrictEqual(evaluateCondition(condition, { n: 3 }), { result: false, calls: [['n = ', 3]] });
});

test('buildLogpointCondition: a message whose text carries quotes stays valid JS', () => {
  const condition = buildLogpointCondition({ id: 1, logMessage: 'say "hi" \\ {n}' });
  assert.deepStrictEqual(evaluateCondition(condition, { n: 1 }).calls, [['say "hi" \\ ', 1]]);
});

test('logpointIdFromUrl: recognises only the logpoint sourceURL', () => {
  assert.strictEqual(logpointIdFromUrl('ejsng-logpoint-12'), 12);
  assert.strictEqual(logpointIdFromUrl('ejsng-logpoint-x'), null);
  assert.strictEqual(logpointIdFromUrl('file:///app/ejsng-logpoint-1'), null);
});

test('parseConsoleApiCalled: a logpoint call anchors to the line under its condition frame, joined without spaces', () => {
  const log = parseConsoleApiCalled({
    type: 'log',
    args: [
      { type: 'string', value: 'n = ' },
      { type: 'number', value: 3 },
    ],
    stackTrace: {
      callFrames: [
        { url: 'ejsng-logpoint-4', lineNumber: 0, columnNumber: 80 },
        { url: 'file:///app/index.js', lineNumber: 5, columnNumber: 2, scriptId: '81' },
      ],
    },
  });
  assert.deepStrictEqual(log, {
    callFrames: [{ url: 'file:///app/index.js', lineNumber: 5, columnNumber: 2, scriptId: '81' }],
    value: 'n = 3',
    severity: 'log',
    logpointId: 4,
  });
});

test('parseConsoleApiCalled: an ordinary console call is unchanged (space-joined, no logpointId)', () => {
  const log = parseConsoleApiCalled({
    type: 'log',
    args: [
      { type: 'string', value: 'a' },
      { type: 'number', value: 1 },
    ],
    stackTrace: { callFrames: [{ url: '/app/index.js', lineNumber: 1, columnNumber: 0 }] },
  });
  assert.strictEqual(log.value, 'a 1');
  assert.strictEqual('logpointId' in log, false);
});

test('runtimePathCandidates: the path itself plus the reverse of every mapping that covers it', () => {
  const mappings = [
    { remote: '/app', local: '/home/me/proj' },
    { remote: '/srv/code', local: '/home/me/proj' },
    { remote: 'http://localhost:5000/js', local: '/home/me/proj/public/js' },
    { remote: '/other', local: '/home/me/other' },
  ];
  assert.deepStrictEqual(runtimePathCandidates('/home/me/proj/public/js/a.js', mappings), [
    '/home/me/proj/public/js/a.js',
    '/app/public/js/a.js',
    '/srv/code/public/js/a.js',
    'http://localhost:5000/js/a.js',
  ]);
  // Whole segments only, exactly like mapContainerPath.
  assert.deepStrictEqual(runtimePathCandidates('/home/me/proj-old/a.js', mappings), ['/home/me/proj-old/a.js']);
});

test('logpointUrlRegex: matches a bare path and its percent-encoded file:// URL, nothing else', () => {
  const re = new RegExp(logpointUrlRegex('/app/my dir/a.js'));
  assert.ok(re.test('/app/my dir/a.js'));
  assert.ok(re.test('file:///app/my%20dir/a.js'));
  assert.ok(!re.test('/app/my dir/a.jsx'));
  assert.ok(!re.test('/x/app/my dir/a.js'));
});

test('logpointUrlRegex: a browser URL also matches with a cache-busting query string', () => {
  const re = new RegExp(logpointUrlRegex('http://localhost:5000/js/a.js'));
  assert.ok(re.test('http://localhost:5000/js/a.js'));
  assert.ok(re.test('http://localhost:5000/js/a.js?v=3'));
  assert.ok(!re.test('http://localhost:5000/js/a.json'));
});
