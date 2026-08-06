/**
 * Tool framework: registry, base interface, and permission model.
 *
 * Tools are pluggable units the agent loop can invoke. Each tool declares:
 *  - a stable name (mapped to OpenAI-style function schema sent to the model)
 *  - a permission category (for the security gate)
 *  - a JSON-Schema-ish parameter descriptor for the model
 *  - an executor function
 *
 * The registry is constructed at boot and frozen for the process lifetime.
 * New tools can be added by pushing to `defaultRegistry` without touching
 * the agent loop itself.
 */

export type ToolPermission =
  | 'READ'      // reads data (files, env, directories, logs)
  | 'WRITE'     // writes/mutates files or durable state
  | 'EXECUTE'   // runs shell commands or arbitrary code
  | 'NETWORK'   // performs outbound HTTP / network calls
  | 'WHATSAPP';  // sends outbound messages via Evolution API

export interface ToolParameterProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: ToolParameterProperty;
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterProperty;
}

export interface ToolCallContext {
  /** Caller-provided conversation id (may be undefined for legacy /api/agent). */
  conversationId: string | undefined;
  /** Source of the request: 'http' | 'whatsapp' | 'internal'. */
  source: 'http' | 'whatsapp' | 'internal';
  /** Soft deadline (epoch ms) for the tool execution; tool must abort after. */
  deadlineMs: number;
}

export interface ToolResult {
  ok: boolean;
  /** Human/agent-readable result text. Forwarded back to the model. */
  output: string;
  /** Optional structured payload, never sent to the model directly. */
  data?: unknown;
  /** Optional error code when ok=false. */
  error?: 'permission_denied' | 'not_found' | 'invalid_args' | 'timeout' | 'io_error' | 'tool_disabled' | 'unknown';
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolCallContext,
) => Promise<ToolResult>;

export interface ToolBase {
  definition: ToolDefinition;
  permission: ToolPermission;
  execute: ToolExecutor;
}

/**
 * Registry enforces uniqueness by tool.name and exposes the JSON schema
 * array in the format NVIDIA NIM / OpenAI-compatible chat.completions
 * expect for the `tools` field.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolBase>();
  private enabled: boolean;
  private allowedPerms: Set<ToolPermission>;

  constructor(opts: {
    enabled: boolean;
    allowedPerms: ToolPermission[];
  }) {
    this.enabled = opts.enabled;
    this.allowedPerms = new Set(opts.allowedPerms);
  }

  register(tool: ToolBase): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool already registered: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): ToolBase | undefined {
    return this.tools.get(name);
  }

  list(): ToolBase[] {
    return Array.from(this.tools.values());
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isAllowed(perm: ToolPermission): boolean {
    return this.allowedPerms.has(perm);
  }

  /**
   * Returns the `tools` array to pass to chat.completions when tool-calling
   * is active. Returns `[]` when tools are disabled globally, so the model
   * never sees tool affordances it cannot use.
   */
  toOpenAITools(): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: ToolParameterProperty;
    };
  }> {
    if (!this.enabled) return [];
    return this.list().map((t) => ({
      type: 'function' as const,
      function: {
        name: t.definition.name,
        description: t.definition.description,
        parameters: t.definition.parameters,
      },
    }));
  }

  /**
   * Runs a tool by name after checking enabled + permission gate.
   * Never throws: errors are returned as ToolResult with ok=false.
   */
  async run(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolResult> {
    if (!this.enabled) {
      return {
        ok: false,
        output: 'Tools are disabled on this server.',
        error: 'tool_disabled',
      };
    }
    const tool = this.get(name);
    if (!tool) {
      return {
        ok: false,
        output: `Unknown tool: ${name}`,
        error: 'unknown',
      };
    }
    if (!this.isAllowed(tool.permission)) {
      return {
        ok: false,
        output: `Permission denied for ${tool.permission} (${name}).`,
        error: 'permission_denied',
      };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        ok: false,
        output: `Tool ${name} crashed: ${message}`,
        error: 'unknown',
      };
    }
  }
}

/** Process-wide default registry; built once in src/tools/index.ts */
let defaultRegistry: ToolRegistry | null = null;

export function setDefaultRegistry(reg: ToolRegistry): void {
  if (defaultRegistry) {
    throw new Error('Default registry already initialized');
  }
  defaultRegistry = reg;
}

export function getDefaultRegistry(): ToolRegistry {
  if (!defaultRegistry) {
    throw new Error('Default registry not initialized');
  }
  return defaultRegistry;
}
