'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const { once } = require('node:events');
const { terminateProcess } = require('../lib/process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build/test-results/e2e');
fs.mkdirSync(output, { recursive: true });
const raw = fs.mkdtempSync(path.join(output, 'run-'));
const env = { ...process.env, APPIUM_HOME: path.join(raw, 'appium-home'),
  NPM_CONFIG_PREFIX: path.join(raw, 'npm-prefix'),
  NPM_CONFIG_IGNORE_SCRIPTS: 'true', APPIUM_SKIP_CHROMEDRIVER_INSTALL: '1' };
fs.mkdirSync(path.join(env.NPM_CONFIG_PREFIX, 'lib/node_modules'), { recursive: true });
const appium = require.resolve('appium/index.js');
fs.writeFileSync(path.join(raw, 'versions.json'), JSON.stringify({
  node: process.version, appium: require('appium/package.json').version,
  driver: require('../package.json').version,
}, null, 2));
let server;
let base;

async function command(executable, args, name) {
  const proc = cp.spawn(executable, args, { cwd: root, env });
  const fd = fs.openSync(path.join(raw, name + '.log'), 'w');
  const log = chunk => fs.writeSync(fd, chunk);
  proc.stdout.on('data', log); proc.stderr.on('data', log);
  try {
    const [code] = await once(proc, 'close');
    if (code !== 0) console.error(fs.readFileSync(path.join(raw, name + '.log'), 'utf8'));
    assert.equal(code, 0, `${name} failed; see ${raw}`);
  } finally { fs.closeSync(fd); }
}

async function waitFor(probe, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function request(route, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.value?.message || JSON.stringify(result));
    error.code = result.value?.error;
    throw error;
  }
  return result.value;
}

before(async () => {
  assert.equal(process.platform, 'linux', 'Desktop E2E requires Linux');
  // Exercise the package allowlist and the actual Appium extension installer.
  await command(process.execPath, [process.env.npm_execpath || require.resolve('npm/bin/npm-cli.js'),
    'pack', '--pack-destination', raw], 'pack');
  const archive = fs.readdirSync(raw).find(name => name.endsWith('.tgz'));
  await command('tar', ['-xzf', path.join(raw, archive), '-C', raw], 'extract');
  await command(process.execPath, [appium, 'driver', 'install', '--source=local', path.join(raw, 'package')], 'install');
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const fd = fs.openSync(path.join(raw, 'appium.log'), 'w');
  server = cp.spawn(process.execPath, [appium, '--address', '127.0.0.1', '--port', String(port), '--log-no-colors'],
    { cwd: root, env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  await once(server, 'spawn');
  await waitFor(async () => {
    if (server.exitCode !== null) throw new Error(`Appium exited; see ${raw}`);
    try { return (await request('/status')).ready; } catch (error) { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; }
  });
}, { timeout: 120000 });

after(async () => { if (server) await terminateProcess(server); });

async function session(t) {
  const fixture = path.join(__dirname, 'fixture.py');
  const value = await request('/session', 'POST', { capabilities: { alwaysMatch: {
    platformName: 'linux', 'appium:automationName': 'linux', 'appium:app': '/usr/bin/python3',
    'appium:appArguments': [fixture, 'argument with spaces'], 'appium:appWorkingDir': __dirname,
    'appium:appEnv': { FIXTURE_VALUE: 'present' },
  }, firstMatch: [{}] } });
  const route = '/session/' + value.sessionId;
  const send = (suffix, method, body) => request(route + suffix, method, body);
  let closed = false;
  const close = async () => { if (!closed) { await send('', 'DELETE'); closed = true; } };
  t.after(async () => {
    if (!closed) {
      // Collect diagnostics before deletion; collection must not replace the primary assertion failure.
      const prefix = path.join(raw, t.name.replace(/[^a-z0-9]+/gi, '-'));
      for (const [suffix, extension] of [['/source', '.xml'], ['/screenshot', '.png']]) {
        try { const value = await send(suffix); fs.writeFileSync(prefix + extension,
          extension === '.png' ? Buffer.from(value, 'base64') : value); }
        catch (error) { fs.appendFileSync(prefix + '.diagnostics.log', error.message + '\n'); }
      }
      await close();
    }
  });
  await send('/timeouts', 'POST', { implicit: 3000 });
  const find = async (selector, using = 'name') =>
    (await send('/element', 'POST', { using, value: selector }))['element-6066-11e4-a52e-4f735466cecf'];
  const click = async name => send('/element/' + await find(name) + '/click', 'POST', {});
  return { send, find, click, close };
}

test('installed driver launches fixture and applies Unicode input through native accessibility', { timeout: 60000 }, async t => {
  const { send, find, click } = await session(t);
  const input = await find('Message');
  await send('/element/' + input + '/value', 'POST', { text: 'hello 世界' });
  assert.equal(await send('/element/' + input + '/text'), 'hello 世界');
  assert.equal(await send('/element/' + input + '/attribute/value'), 'hello 世界');
  await click('Apply');
  assert.ok(await find('Result: hello 世界'));
  assert.ok((await send('/source')).includes('hello 世界'));
});

test('owned window resizing returns actual geometry through WebDriver', { timeout: 60000 }, async t => {
  const { send, find } = await session(t);
  const resized = await send('/window/rect', 'POST', { width: 700, height: 500 });
  assert.equal(resized.width, 700); assert.equal(resized.height, 500);
  const element = await find('Message');
  const rect = await send('/element/' + element + '/rect');
  assert.ok(rect.width > 0 && rect.height > 0);
});

test('desktop screenshots contain a PNG matching the isolated display', { timeout: 60000 }, async t => {
  const { send } = await session(t);
  const png = Buffer.from(await send('/screenshot'), 'base64');
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(16), 1280); assert.equal(png.readUInt32BE(20), 900);
});

test('XPath locators find actual editable controls', { timeout: 60000 }, async t => {
  const { send, find } = await session(t);
  const input = await find('//text-field', 'xpath');
  await send('/element/' + input + '/value', 'POST', { text: 'xpath input' });
  const apply = await find("//*[@name='Apply']", 'xpath');
  await send('/element/' + apply + '/click', 'POST', {});
  assert.ok(await find('Result: xpath input'));
});

test('removed accessible controls become stale without targeting their replacements', { timeout: 60000 }, async t => {
  const { send, find, click } = await session(t);
  const target = await find('Transient target');
  await click('Remove target');
  await assert.rejects(send('/element/' + target + '/rect'), error => error.code === 'stale element reference');
});

test('Escape dismisses an actual modal while leaving its parent session usable', { timeout: 60000 }, async t => {
  const { send, find, click } = await session(t);
  await click('Show dialog');
  assert.ok(await find('Fixture dialog'));
  await send('/execute/sync', 'POST', { script: 'linux: dismissDialog', args: [] });
  await waitFor(async () => (await send('/elements', 'POST', { using: 'name', value: 'Fixture dialog' })).length === 0);
  assert.ok(await find('Message'));
});

test('session deletion waits for the fixture process to disappear', { timeout: 60000 }, async t => {
  const { send, close } = await session(t);
  const source = await send('/source');
  const pid = Number(/name="PID (\d+)"/.exec(source)?.[1]);
  assert.ok(pid > 0, 'Fixture must expose its process ID');
  await close();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('failed executable launch leaves the server able to create a fresh native session', { timeout: 60000 }, async t => {
  await assert.rejects(request('/session', 'POST', { capabilities: { alwaysMatch: {
    platformName: 'linux', 'appium:automationName': 'linux', 'appium:app': '/nonexistent-appium-e2e-fixture',
  }, firstMatch: [{}] } }), /ENOENT/);
  const { find } = await session(t);
  assert.ok(await find('Message'));
});
