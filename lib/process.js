'use strict';

const childProcess = require('node:child_process');

/** Run one JSON request and wait for the helper to release its process handles. */
function runJsonProcess(command, args, input, { timeoutMs = 45000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const proc = childProcess.spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let failure;
    const stop = error => {
      failure ??= error;
      proc.kill('SIGKILL');
    };
    const abort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new Error(`JSON helper timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    proc.stdout.on('data', data => { stdout += data; });
    proc.stderr.on('data', data => { stderr += data; });
    proc.on('error', error => { failure ??= error; });
    proc.stdin.on('error', stop);
    proc.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) {
        reject(new Error(`JSON helper exited ${code ?? exitSignal}: ${stderr.trim()}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (cause) { reject(new Error(`JSON helper returned invalid JSON: ${stdout || stderr}`, { cause })); }
    });
    proc.stdin.end(JSON.stringify(input));
  });
}

/** Wait for termination before allowing a later session to reuse the desktop. */
async function terminateProcess(proc, { graceMs = 3000 } = {}) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const done = error => {
      clearTimeout(timer);
      proc.removeListener('exit', exited);
      proc.removeListener('error', failed);
      error ? reject(error) : resolve();
    };
    const exited = () => done();
    const failed = error => done(error);
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (error) { done(error); }
    }, graceMs);
    proc.once('exit', exited);
    proc.once('error', failed);
    try { proc.kill('SIGTERM'); } catch (error) { done(error); }
  });
}

module.exports = { runJsonProcess, terminateProcess };
