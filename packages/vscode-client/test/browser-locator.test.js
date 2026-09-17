/**
 * Ticket 10 (.scratch/runtime-remote-env/issues/10-launch-trinh-duyet-phia-ui.md): the pure
 * decisions behind Launch — where to look for a browser on the user's side, how to start it, and
 * which app to open. The registry, WSL interop and spawning themselves are checked by hand.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  BROWSER_ORDER,
  launchRouteFor,
  windowsRegistryKeys,
  parseRegQueryDefaultValue,
  windowsFixedPaths,
  parseWindowsFolders,
  windowsPathToWsl,
  windowsProfileDir,
  macAppPaths,
  linuxCommands,
  browserLaunchArgs,
  chooseAppPort,
  parseAppAddress,
} = require('../out/browser-locator');

test('BROWSER_ORDER: Chrome, then Edge, then Brave', () => {
  assert.deepStrictEqual(BROWSER_ORDER, ['chrome', 'edge', 'brave']);
});

test('launchRouteFor: local spawns here, Remote-WSL goes through interop, other remotes cannot reach the user yet', () => {
  assert.strictEqual(launchRouteFor(undefined), 'local');
  assert.strictEqual(launchRouteFor('wsl'), 'wsl-interop');
  assert.strictEqual(launchRouteFor('ssh-remote'), 'unsupported');
  assert.strictEqual(launchRouteFor('dev-container'), 'unsupported');
});

test('windowsRegistryKeys: App Paths per user, then machine-wide', () => {
  assert.deepStrictEqual(windowsRegistryKeys('edge'), [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
  ]);
});

test('parseRegQueryDefaultValue: reads the default value whatever its localized name', () => {
  const english = [
    '',
    'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    '    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '',
  ].join('\r\n');
  assert.strictEqual(parseRegQueryDefaultValue(english), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  const japanese = '    (既定)    REG_EXPAND_SZ    "C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"\r\n';
  assert.strictEqual(parseRegQueryDefaultValue(japanese), 'C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe');
  assert.strictEqual(parseRegQueryDefaultValue('ERROR: The system was unable to find the specified registry key or value.'), null);
});

test('windowsFixedPaths: Program Files, Program Files (x86), then LocalAppData — defaults when a folder is unknown', () => {
  assert.deepStrictEqual(windowsFixedPaths('chrome', { localAppData: 'C:\\Users\\me\\AppData\\Local' }), [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ]);
});

test('parseWindowsFolders: cmd echo output, with an unexpanded variable treated as missing', () => {
  assert.deepStrictEqual(parseWindowsFolders('C:\\Program Files;C:\\Program Files (x86);C:\\Users\\me\\AppData\\Local\r\n'), {
    programFiles: 'C:\\Program Files',
    programFilesX86: 'C:\\Program Files (x86)',
    localAppData: 'C:\\Users\\me\\AppData\\Local',
  });
  assert.deepStrictEqual(parseWindowsFolders('D:\\Apps;%ProgramFiles(x86)%;%LOCALAPPDATA%'), {
    programFiles: 'D:\\Apps',
    programFilesX86: undefined,
    localAppData: undefined,
  });
});

test('windowsPathToWsl: drive letter to /mnt/<drive>, backslashes to slashes; non-Windows paths refused', () => {
  assert.strictEqual(
    windowsPathToWsl('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  );
  assert.strictEqual(windowsPathToWsl('D:\\x', '/win'), '/win/d/x');
  assert.strictEqual(windowsPathToWsl('/usr/bin/google-chrome'), null);
});

test('windowsProfileDir: a dedicated, persistent profile under %LOCALAPPDATA% — a Windows path for chrome.exe', () => {
  assert.strictEqual(windowsProfileDir('C:\\Users\\me\\AppData\\Local\\'), 'C:\\Users\\me\\AppData\\Local\\ejsng\\browser-profile');
});

test('macAppPaths / linuxCommands: system-wide before per-user; Chromium counts as Chrome', () => {
  assert.deepStrictEqual(macAppPaths('brave', '/Users/me/'), [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Users/me/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ]);
  assert.ok(linuxCommands('chrome').includes('chromium'));
});

test('browserLaunchArgs: debug port, its own profile, no first-run noise, and the app URL last', () => {
  assert.deepStrictEqual(browserLaunchArgs({ debugPort: 9222, userDataDir: 'C:\\p', url: 'http://localhost:5000/' }), [
    '--remote-debugging-port=9222',
    '--user-data-dir=C:\\p',
    '--no-first-run',
    '--no-default-browser-check',
    'http://localhost:5000/',
  ]);
});

test('chooseAppPort: the remembered port wins while a container still publishes it', () => {
  const containers = [
    { name: 'cityos-web', appPorts: [5000] },
    { name: 'cityos-app', appPorts: [5001] },
  ];
  assert.deepStrictEqual(chooseAppPort(containers, 5001), { kind: 'use', port: 5001 });
});

test('chooseAppPort: a single app port is used without asking', () => {
  assert.deepStrictEqual(chooseAppPort([{ name: 'cityos-web', appPorts: [5000] }, { name: 'worker', appPorts: [] }], 7000), {
    kind: 'use',
    port: 5000,
  });
});

test('chooseAppPort: several ports and nothing remembered asks, labelled by container; none at all asks for input', () => {
  assert.deepStrictEqual(chooseAppPort([{ name: 'cityos-web', appPorts: [5000, 5443] }, { name: 'dup', appPorts: [5000] }], undefined), {
    kind: 'ask',
    options: [
      { port: 5000, label: 'cityos-web: 5000' },
      { port: 5443, label: 'cityos-web: 5443' },
    ],
  });
  assert.deepStrictEqual(chooseAppPort([], 5000), { kind: 'none' });
});

test('parseAppAddress: a bare port or an http(s) URL; anything else is refused', () => {
  assert.deepStrictEqual(parseAppAddress(' 5000 '), { url: 'http://localhost:5000/', port: 5000 });
  assert.deepStrictEqual(parseAppAddress('http://localhost:3100/app'), { url: 'http://localhost:3100/app', port: 3100 });
  assert.deepStrictEqual(parseAppAddress('https://dev.local/'), { url: 'https://dev.local/', port: null });
  assert.strictEqual(parseAppAddress('70000'), null);
  assert.strictEqual(parseAppAddress('file:///etc/passwd'), null);
  assert.strictEqual(parseAppAddress('localhost:5000'), null);
});
