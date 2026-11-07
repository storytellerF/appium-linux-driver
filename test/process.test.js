'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const { runJsonProcess, terminateProcess } = require('../lib/process');

const run = (script, input = {}, options) => runJsonProcess(process.execPath, ['-e', script], input, options);

test('JSON helper exchanges Unicode and whitespace without a shell', async () => {
  const input = { text: 'hello 世界\n"quoted"', path: 'space in path' };
  assert.deepEqual(await run('process.stdin.pipe(process.stdout)', input), input);
});

test('valid JSON does not hide a nonzero helper exit', async () => {
  await assert.rejects(run('process.stdout.write("{}"); process.stderr.write("diagnostic"); process.exitCode=7'), /exited 7: diagnostic/);
});

test('helper malformed output preserves the parse cause', async () => {
  await assert.rejects(run('process.stdout.write("not JSON")'), error =>
    error.cause instanceof SyntaxError && error.message.includes('not JSON'));
});

test('missing helper executable rejects instead of emitting an uncaught error', async () => {
  await assert.rejects(runJsonProcess('nonexistent-appium-helper-executable', [], {}), { code: 'ENOENT' });
});

test('helper deadline kills and reaps the hung process', async () => {
  await assert.rejects(run('setInterval(()=>{}, 1000)', {}, { timeoutMs: 150 }), /timed out/);
});

test('helper cancellation preserves the caller reason', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel requested');
  const result = run('setInterval(()=>{}, 1000)', {}, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(result, error => error === reason);
});

test('already cancelled helper does not launch a process', async () => {
  const reason = new Error('already cancelled');
  await assert.rejects(runJsonProcess('nonexistent-executable', [], {}, { signal: AbortSignal.abort(reason) }),
    error => error === reason);
});

test('termination waits until the child has actually exited', async () => {
  const proc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  await once(proc, 'spawn');
  try { await terminateProcess(proc); assert.ok(proc.exitCode !== null || proc.signalCode !== null); }
  finally { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }
});

test('termination escalates when the application ignores SIGTERM', async () => {
  const proc = new EventEmitter();
  Object.assign(proc, { exitCode: null, signalCode: null });
  const signals = [];
  proc.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') proc.emit('exit', null, signal); };
  await terminateProcess(proc, { graceMs: 5 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(proc.listenerCount('exit'), 0);
});
