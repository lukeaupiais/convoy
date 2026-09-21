// Bounded, bidirectional NDJSON over an authenticated stdio transport.
export function createRpc(input, output, handlers = {}, onClose = () => {}) {
  const pending = new Map(); let serial = 0; let buffer = ''; let closed = false;
  const limit = 8 * 1024 * 1024;
  const outgoing = []; let queuedBytes = 0; let blocked = false;
  function close(error = new Error('Worker disconnected. Inspect before retrying.')) {
    if (closed) return; closed = true;
    for (const { reject } of pending.values()) reject(error);
    pending.clear(); outgoing.length = 0; queuedBytes = 0; onClose(error);
  }
  function flush() {
    while (!closed && !blocked && outgoing.length) {
      const line = outgoing.shift(); queuedBytes -= Buffer.byteLength(line);
      blocked = !output.write(line);
    }
  }
  output.on('drain', () => { blocked = false; flush(); });
  function send(value) {
    if (closed) throw new Error('Worker disconnected.');
    const line = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(line) > limit) throw new Error('Worker message exceeds 8 MB.');
    if (queuedBytes + Buffer.byteLength(line) > limit * 2) { close(new Error('Worker transport backpressure limit reached.')); throw new Error('Worker transport backpressure limit reached.'); }
    outgoing.push(line); queuedBytes += Buffer.byteLength(line); flush();
  }
  async function receive(message) {
    if (message.reply !== undefined) {
      const item = pending.get(message.reply); if (!item) return;
      pending.delete(message.reply);
      if (message.error) item.reject(new Error(message.error)); else item.resolve(message.value);
      return;
    }
    try {
      if (!Object.hasOwn(handlers, message.method)) throw new Error('Unknown worker operation.');
      const value = await handlers[message.method](message.args);
      send({ reply: message.id, value: value ?? null });
    } catch (error) { try { send({ reply: message.id, error: error.publicMessage ?? error.message }); } catch {} }
  }
  input.setEncoding('utf8');
  input.on('data', chunk => {
    if (closed) return;
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > limit) { close(new Error('Worker frame too large.')); return; }
      try { const message = JSON.parse(line); if (!message || typeof message !== 'object') throw new Error(); void receive(message); }
      catch { close(new Error('Invalid worker protocol.')); return; }
    }
    if (Buffer.byteLength(buffer) > limit) close(new Error('Worker frame too large.'));
  });
  input.on('end', () => close()); input.on('error', close); output.on('error', close);
  // Node does not consistently keep a piped stdin readable merely because a
  // data listener exists. Explicitly resume so source and compiled workers stay
  // alive while the coordinator owns the pipe.
  input.resume?.();
  return {
    call(method, args) {
      return new Promise((resolve, reject) => {
        if (pending.size >= 128) { reject(new Error('Too many pending worker requests.')); return; }
        const id = ++serial; pending.set(id, { resolve, reject });
        try { send({ id, method, args }); } catch (error) { pending.delete(id); reject(error); }
      });
    }, close,
  };
}
