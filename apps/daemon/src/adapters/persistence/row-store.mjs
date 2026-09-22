/**
 * Compatibility boundary for the control plane's mutable state. Each keyed
 * collection member is committed independently inside one database transaction.
 * The next migration step can replace these rows with domain-specific queries
 * without changing the already durable database and import contract.
 */
const identity = (bucket, key) => JSON.stringify([bucket, key]);

function flatten(data) {
  const rows = new Map();
  for (const [name, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      rows.set(identity('$meta', name), { bucket: '$meta', key: name, position: 0, payload: JSON.stringify({ kind: 'array' }) });
      const seen = new Set();
      for (let position = 0; position < value.length; position++) {
        const item = value[position];
        const key = name === 'workflows' && item?.version !== undefined
          ? `${item.id}@${item.version}`
          : item?.id;
        if ((typeof key !== 'string' && typeof key !== 'number') || seen.has(String(key)))
          throw new Error(`Persisted collection ${name} needs unique item IDs.`);
        seen.add(String(key));
        rows.set(identity(name, String(key)), { bucket: name, key: String(key), position, payload: JSON.stringify(item) });
      }
    } else if (name === 'sessions' && value && typeof value === 'object') {
      rows.set(identity('$meta', name), { bucket: '$meta', key: name, position: 0, payload: JSON.stringify({ kind: 'map' }) });
      for (const [key, item] of Object.entries(value))
        rows.set(identity(name, key), { bucket: name, key, position: 0, payload: JSON.stringify(item) });
    } else {
      rows.set(identity('$meta', name), { bucket: '$meta', key: name, position: 0, payload: JSON.stringify({ kind: 'value', value }) });
    }
  }
  return rows;
}

function inflate(rows, fallback) {
  if (!rows.length) return structuredClone(fallback);
  const data = {};
  const collections = new Map();
  for (const row of rows) {
    if (row.bucket !== '$meta') {
      const items = collections.get(row.bucket) ?? [];
      items.push(row);
      collections.set(row.bucket, items);
      continue;
    }
    const marker = JSON.parse(row.payload);
    if (marker.kind === 'array') data[row.key] = [];
    else if (marker.kind === 'map') data[row.key] = {};
    else if (marker.kind === 'value') data[row.key] = marker.value;
    else throw new Error(`Unknown persisted state shape: ${row.key}`);
  }
  for (const [name, items] of collections) {
    if (!Object.hasOwn(data, name)) throw new Error(`Persisted collection ${name} has no shape marker.`);
    if (Array.isArray(data[name])) {
      items.sort((a, b) => a.position - b.position);
      data[name] = items.map((item) => JSON.parse(item.payload));
    } else {
      for (const item of items) data[name][item.key] = JSON.parse(item.payload);
    }
  }
  return data;
}

export async function createRowStore(driver, fallback, legacyState, onFatal = () => {}) {
  const stored = await driver.load();
  const data = stored.length ? inflate(stored, fallback) : legacyState ?? structuredClone(fallback);
  let previous = new Map(stored.map((row) => [identity(row.bucket, row.key), row]));
  let queue = Promise.resolve();
  let failure;
  const fail = (error) => {
    if (!failure) {
      failure = error;
      void Promise.resolve().then(() => onFatal(error)).catch(() => {});
    }
  };
  async function commit(rows) {
    const changed = [];
    const removed = [];
    for (const [key, row] of rows)
      if (previous.get(key)?.payload !== row.payload || previous.get(key)?.position !== row.position)
        changed.push(row);
    for (const [key, row] of previous)
      if (!rows.has(key)) removed.push(row);
    if (changed.length || removed.length) await driver.commit(changed, removed);
    previous = rows;
  }
  if (!stored.length) await commit(flatten(data));
  return {
    data,
    save() {
      if (failure) return Promise.reject(failure);
      let rows;
      try { rows = flatten(data); }
      catch (error) { fail(error); return Promise.reject(error); }
      const next = queue.then(() => commit(rows)).catch((error) => { fail(error); throw error; });
      queue = next;
      return next;
    },
    async close() {
      await queue;
      await driver.close();
    },
  };
}
