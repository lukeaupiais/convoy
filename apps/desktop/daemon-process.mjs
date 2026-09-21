/** Supervises the daemon utility process without exposing it to the renderer. */
export function launchDaemon(fork, { entry, env, cwd, onExit, timeoutMs = 20_000 }) {
  const child = fork(entry, [], {
    cwd,
    env,
    serviceName: 'Convoy daemon',
    stdio: 'pipe',
  });
  child.stdout?.on('data', (bytes) => process.stdout.write(bytes));
  child.stderr?.on('data', (bytes) => process.stderr.write(bytes));
  return new Promise((resolve, reject) => {
    let settled = false;
    let started = false;
    const timer = setTimeout(() => fail(new Error(`Convoy daemon did not start within ${timeoutMs / 1000} seconds.`)), timeoutMs);
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    }
    child.on('message', (message) => {
      if (message?.type === 'startup-error')
        fail(new Error(message.message || 'Convoy daemon failed to start.'));
      if (message?.type === 'ready' && !settled) {
        settled = true;
        started = true;
        clearTimeout(timer);
        resolve({ child, url: message.url });
      }
    });
    child.on('exit', (code) => {
      if (!settled) fail(new Error(`Convoy daemon exited during startup (code ${code}).`));
      else if (started) onExit?.(code);
    });
    child.on('error', () => fail(new Error('Convoy daemon process failed to start.')));
  });
}

export function stopDaemon(child, timeoutMs = 5_000) {
  if (!child?.pid) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, timeoutMs);
    child.once('exit', finish);
    try {
      child.postMessage({ type: 'shutdown' });
    } catch {
      child.kill();
      finish();
    }
  });
}
