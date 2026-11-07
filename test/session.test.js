'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { LinuxDriver } = require('../lib/driver');

const caps = (extra = {}) => ({ alwaysMatch: { platformName: 'linux', 'appium:automationName': 'linux',
  'appium:app': 'fixture', ...extra }, firstMatch: [{}] });

function fixture(t, result = { ok: true }) {
  const driver = new LinuxDriver();
  driver._assertDisplay = () => {};
  driver._enableAccessibility = () => {};
  driver._atspi = async () => result;
  const proc = new EventEmitter();
  Object.assign(proc, { pid: 42, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
  proc.kill = signal => { proc.signalCode = signal; queueMicrotask(() => proc.emit('exit', null, signal)); return true; };
  t.mock.method(cp, 'spawn', () => { queueMicrotask(() => proc.emit('spawn')); return proc; });
  t.after(() => driver.deleteSession());
  return { driver, proc };
}

test('session passes argument arrays, working directory and environment to the app', async t => {
  const { driver } = fixture(t);
  const [id] = await driver.createSession(caps({ 'appium:appArguments': ['hello world', '第二个'],
    'appium:appWorkingDir': '/fixture', 'appium:appEnv': { FIXTURE_VALUE: 'set' } }));
  const [command, args, options] = cp.spawn.mock.calls[0].arguments;
  assert.equal(command, 'fixture');
  assert.deepEqual(args, ['hello world', '第二个']);
  assert.equal(options.cwd, '/fixture');
  assert.equal(options.env.FIXTURE_VALUE, 'set');
  assert.equal(driver.sessionId, id);
  assert.equal(driver.appPid, 42);
});

test('deleting a session reaps the app and clears element and session state', async t => {
  const { driver, proc } = fixture(t);
  await driver.createSession(caps());
  driver.elements.set('old', {});
  await driver.deleteSession();
  assert.equal(proc.signalCode, 'SIGTERM');
  assert.equal(driver.sessionId, null);
  assert.equal(driver.appProcess, null);
  assert.equal(driver.appPid, null);
  assert.equal(driver.elements.size, 0);
  await driver.deleteSession();
});

test('missing executable capability fails before launching and clears the session', async t => {
  const { driver } = fixture(t);
  const request = caps(); delete request.alwaysMatch['appium:app'];
  await assert.rejects(driver.createSession(request), /Capability "app"/);
  assert.equal(cp.spawn.mock.callCount(), 0);
  assert.equal(driver.sessionId, null);
});

test('display failure fails before launching and clears the session', async t => {
  const { driver } = fixture(t);
  driver._assertDisplay = () => { throw new Error('display unavailable'); };
  await assert.rejects(driver.createSession(caps()), /display unavailable/);
  assert.equal(cp.spawn.mock.callCount(), 0);
  assert.equal(driver.sessionId, null);
});

test('accessibility startup failure does not leave a session', async t => {
  const { driver } = fixture(t);
  driver._enableAccessibility = () => { throw new Error('bus unavailable'); };
  await assert.rejects(driver.createSession(caps()), /bus unavailable/);
  assert.equal(cp.spawn.mock.callCount(), 0);
  assert.equal(driver.sessionId, null);
});

test('missing application executable rejects and cleans session state', async t => {
  const { driver, proc } = fixture(t);
  t.mock.method(cp, 'spawn', () => { queueMicrotask(() => {
    proc.exitCode = -2; proc.emit('error', Object.assign(new Error('missing app'), { code: 'ENOENT' }));
  }); return proc; });
  await assert.rejects(driver.createSession(caps()), { code: 'ENOENT' });
  assert.equal(driver.sessionId, null);
  assert.equal(driver.appProcess, null);
});

test('accessibility timeout terminates the launched app before rejecting', async t => {
  const { driver, proc } = fixture(t, { ok: false });
  await assert.rejects(driver.createSession(caps()), /did not appear/);
  assert.equal(proc.signalCode, 'SIGTERM');
  assert.equal(driver.sessionId, null);
});

test('helper failure preserves the original error and terminates the app', async t => {
  const { driver, proc } = fixture(t);
  const failure = new Error('helper failed');
  driver._atspi = async () => { throw failure; };
  await assert.rejects(driver.createSession(caps()), error => error === failure);
  assert.equal(proc.signalCode, 'SIGTERM');
  assert.equal(driver.sessionId, null);
});

test('early app exit cancels the pending startup helper', async t => {
  const { driver, proc } = fixture(t);
  driver._atspi = (_cmd, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    queueMicrotask(() => { proc.exitCode = 2; proc.emit('exit', 2, null); });
  });
  await assert.rejects(driver.createSession(caps()), /exited during startup: 2/);
  assert.equal(driver.sessionId, null);
});
