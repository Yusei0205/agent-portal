/** The subset of Claude Agent SDK shapes the portal relies on. Unknown message types pass through untouched. */
export interface SdkMessage {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: ContentBlock[] | string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: Record<string, number>;
  num_turns?: number;
  duration_ms?: number;
  [k: string]: unknown;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal; toolUseID?: string; agentID?: string },
) => Promise<PermissionResult>;

/** Called before every tool call; return a reason string to block it. */
export type PreToolGuard = (toolName: string, input: Record<string, unknown>) => string | null;

export type PermissionMode = 'default' | 'acceptEdits' | 'plan';

export interface DemoContext {
  projectDir: string;
  runId: string;
  kind: string;
  agents: { name: string; description: string; model: string }[];
  skills: string[];
  /** Absolute folder the run may write to. */
  writeDir: string;
  /** Path relative to the project folder, as the agent sees it. */
  writeDirRel: string;
  decisions: string;
  search: (q: string, limit: number) => { file: string; heading: string; snippet: string; line: number }[];
  speed: number;
}

export interface ProviderRunOptions {
  prompt: string;
  cwd: string;
  /** Alias (sonnet, haiku, opus) or exact model ID. */
  model: string;
  /** Appended to the Claude Code system prompt. Ignored when `systemPrompt` is set. */
  systemAppend?: string;
  /** Replace the system prompt entirely (single-shot tasks). */
  systemPrompt?: string;
  permissionMode: PermissionMode;
  /** Tools that run without asking. */
  allowedTools?: string[];
  /** Restrict the tools Claude can see at all. */
  tools?: string[];
  maxTurns?: number;
  resume?: string;
  settingSources: ('user' | 'project' | 'local')[];
  additionalDirectories?: string[];
  canUseTool: CanUseTool;
  guard?: PreToolGuard;
  onHook?: (event: string, input: Record<string, unknown>) => void;
  abort: AbortController;
  env: Record<string, string>;
  demo?: DemoContext;
  /** MCP servers from the run's integrations, keyed by the name agents see. */
  mcpServers?: Record<string, import('../integrations.ts').McpServer>;
}

export type ProviderRun = (opts: ProviderRunOptions) => AsyncIterable<SdkMessage>;
