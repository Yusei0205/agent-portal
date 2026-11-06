import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CodexRuntimeError, resolveCodexCommand } from './codex-command.ts';
import { validChatgptTokens, type ChatgptAuthTokens } from './codex-device-protocol.ts';

export type RpcParams = Record<string, any>;
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Newline-delimited JSON-RPC. Never log wire messages: authentication carries secrets. */
export class CodexClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stopped = false;
  private closed: Promise<void>;
  private listeners = new Set<(method: string, params: RpcParams) => void>();
  onRequest: (method: string, params: RpcParams) => Promise<unknown> = async () => {
    throw new Error('Unsupported Codex server request');
  };
  onClose: (error: Error) => void = () => {};

  constructor(private child: ChildProcessWithoutNullStreams) {
    this.closed = new Promise(resolve => child.once('close', () => resolve()));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let msg: RpcParams;
      try { msg = JSON.parse(line); } catch { this.fail(new Error('Invalid Codex app-server response')); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        this.fail(new Error('Invalid Codex app-server message')); return;
      }
      if (msg.method && msg.id != null) {
        void this.onRequest(msg.method, msg.params ?? {}).then(
          result => this.write({ id: msg.id, result }),
          () => this.write({ id: msg.id, error: { code: -32601, message: 'Request not supported by Agent Portal' } }),
        );
      } else if (msg.method) {
        try { for (const listener of this.listeners) listener(msg.method, msg.params ?? {}); }
        catch { this.fail(new Error('Invalid Codex notification')); }
      } else if (msg.id != null) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(String(msg.error.message ?? 'Codex request failed')));
        else entry.resolve(msg.result);
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => this.fail(new Error('Codex app-server input closed')));
    child.on('error', (error: NodeJS.ErrnoException) => this.fail(new CodexRuntimeError(
      error.code === 'ENOENT' ? 'codex_not_installed' : 'codex_launch_failed',
      error.code === 'ENOENT' ? 'The Codex executable could not be found. Check PORTAL_CODEX_BIN on the portal host.'
        : 'The portal could not launch Codex (' + (error.code ?? 'unknown error') + '). Check executable permissions and PORTAL_CODEX_BIN.',
    )));
    child.on('close', (code, signal) => { lines.close(); this.fail(new CodexRuntimeError('codex_process_exited',
      'Codex app-server exited' + (code != null ? ' (exit code ' + code + ')' : signal ? ' (' + signal + ')' : '') + '. Check the installed Codex version and runtime configuration.', 502)); });
  }

  static async start(home: string, env: NodeJS.ProcessEnv, cwd?: string, options: { accessToken?: string; chatgptAuthTokens?: ChatgptAuthTokens; extraEnv?: Record<string, string> } = {}): Promise<CodexClient> {
    if (options.chatgptAuthTokens && (!validChatgptTokens(options.chatgptAuthTokens) || options.accessToken)) throw new Error('Invalid Codex external authentication');
    const launch = resolveCodexCommand(env);
    const provider = options.accessToken ? [
      '-c', 'model_provider="openai_chatgpt_plan"',
      '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
      '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
      '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
      '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"',
      '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
      '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false',
    ] : [];
    const child = spawn(launch.command, [...launch.args,
      'app-server', '-c', 'cli_auth_credentials_store="file"', ...provider,
      '-c', 'shell_environment_policy.inherit="core"',
      '-c', 'shell_environment_policy.exclude=["ACCESS_TOKEN","PORTAL_MCP_CONNECTIONS_JSON","AWS_*","*SECRET*","*TOKEN*"]',
    ], { env: { ...env, ...options.extraEnv, CODEX_HOME: home, ...(options.accessToken ? { ACCESS_TOKEN: options.accessToken } : {}) }, cwd, stdio: 'pipe', windowsHide: true, shell: false });
    const client = new CodexClient(child);
    try {
      await client.request('initialize', { clientInfo: { name: 'agent_portal', title: 'Agent Portal', version: '0.1.0' },
        ...(options.chatgptAuthTokens ? { capabilities: { experimentalApi: true } } : {}) });
      client.write({ method: 'initialized', params: {} });
      if (options.chatgptAuthTokens) await client.request('account/login/start', { type: 'chatgptAuthTokens', ...options.chatgptAuthTokens });
      return client;
    } catch (e) { client.close(); throw e; }
  }

  subscribe(listener: (method: string, params: RpcParams) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(method: string, params: RpcParams = {}, timeoutMs = 30_000): Promise<any> {
    if (this.stopped) return Promise.reject(new Error('Codex app-server is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRuntimeError('codex_timeout', 'Codex ' + method + ' timed out. Check the runtime and outbound network connection.', 504));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ method, id, params });
    });
  }

  private write(message: object): void {
    if (!this.stopped && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.onClose(error);
    this.child.kill();
  }

  close(): void { this.fail(new Error('Codex connection closed')); }
  async waitClosed(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.closed, new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          this.child.kill('SIGKILL');
          // Do not pack SQLite state until the process has actually closed its files.
          timer = setTimeout(() => reject(new Error('Codex did not stop before saving conversation state')), 5000);
        }, 5000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
