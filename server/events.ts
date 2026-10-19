/** In-process pub/sub used to push live updates to browsers over server-sent events. */
type Listener = (event: string, data: unknown) => void;

const channels = new Map<string, Set<Listener>>();

export function subscribe(channel: string, fn: Listener): () => void {
  let set = channels.get(channel);
  if (!set) channels.set(channel, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) channels.delete(channel);
  };
}

export function publish(channel: string, event: string, data: unknown): void {
  const set = channels.get(channel);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(event, data);
    } catch {
      /* a broken listener must not affect others */
    }
  }
}

export const projectChannel = (projectId: string) => `project:${projectId}`;
export const runChannel = (runId: string) => `run:${runId}`;
