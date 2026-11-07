/**
 * Lists that come from an eventually consistent index (the cloud portal's DynamoDB secondary indexes) can leave out
 * something created a moment ago. A page that just created, or was just told about, an item keeps it here and merges it
 * into the list it loads until the server's list includes it (or a minute has passed), so it shows at once and stays.
 */
export function createFreshList(ttlMs = 60_000, now = () => Date.now()) {
  const entries = new Map();
  return {
    add(item) { if (item?.id) entries.set(item.id, { item, at: now() }); },
    remove(id) { entries.delete(id); },
    /** The server's list with the not-yet-listed fresh items on top. */
    merge(list) {
      const have = new Set(list.map((i) => i.id));
      const missing = [];
      for (const [id, e] of [...entries]) {
        if (have.has(id) || now() - e.at > ttlMs) entries.delete(id);
        else missing.push(e.item);
      }
      return missing.length ? [...missing, ...list] : list;
    },
  };
}

/**
 * Run `load` after each delay (ms); calling again restarts the sequence. The first read can miss a new item, the later
 * ones catch it. Returns a function that cancels what is still waiting.
 */
export function createSettledReload(load, delays = [400, 2500, 6000]) {
  let timers = [];
  const cancel = () => { timers.forEach(clearTimeout); timers = []; };
  const run = () => {
    cancel();
    timers = delays.map((d) => setTimeout(load, d));
  };
  run.cancel = cancel;
  return run;
}
