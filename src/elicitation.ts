import { log } from './log.js';

/**
 * MCP Elicitation Protocol types.
 *
 * When an MCP server needs structured input from the user, it sends an
 * elicitation request with a schema describing the fields it needs.
 * MetaMCP can auto-respond based on intent config or forward to the client.
 */

export interface ElicitationField {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  enum?: string[];
}

export interface ElicitationRequest {
  requestId: string;
  message: string;
  schema?: Record<string, ElicitationField>;
  url?: string;
}

export interface ElicitationResponse {
  requestId: string;
  action: 'submit' | 'cancel' | 'dismiss';
  data?: Record<string, unknown>;
}

export type ElicitationMode = 'auto' | 'interactive' | 'deny';

export interface ElicitationConfig {
  mode: ElicitationMode;
  autoResponses?: Record<string, Record<string, unknown>>;
}

const DEFAULT_CONFIG: ElicitationConfig = {
  mode: 'auto',
};

/**
 * Handles MCP elicitation requests from child servers.
 *
 * - auto mode: respond using defaults from schema or autoResponses config
 * - interactive mode: forward to the MetaMCP client (not yet wired — logs and denies)
 * - deny mode: always cancel
 */
export class ElicitationHandler {
  private config: ElicitationConfig;
  private pending = new Map<string, ElicitationRequest>();

  constructor(config?: ElicitationConfig) {
    this.config = config ?? DEFAULT_CONFIG;
  }

  async handle(server: string, request: ElicitationRequest): Promise<ElicitationResponse> {
    log('info', 'elicitation request', {
      server,
      requestId: request.requestId,
      message: request.message,
      mode: this.config.mode,
      hasSchema: !!request.schema,
      hasUrl: !!request.url,
    });

    switch (this.config.mode) {
      case 'auto':
        return this.autoRespond(server, request);
      case 'interactive':
        return this.interactiveRespond(server, request);
      case 'deny':
        return { requestId: request.requestId, action: 'cancel' };
    }
  }

  private autoRespond(server: string, request: ElicitationRequest): ElicitationResponse {
    const data: Record<string, unknown> = {};

    // Check for configured auto-responses keyed by server name
    const serverResponses = this.config.autoResponses?.[server];
    if (serverResponses) {
      Object.assign(data, serverResponses);
    }

    // Fill remaining fields from schema defaults
    if (request.schema) {
      for (const [field, def] of Object.entries(request.schema)) {
        if (data[field] !== undefined) continue;
        if (def.default !== undefined) {
          data[field] = def.default;
        } else if (def.enum && def.enum.length > 0) {
          data[field] = def.enum[0];
        } else if (!def.required) {
          // Skip optional fields with no default
        } else {
          // Required field with no default — can't auto-respond
          log('warn', 'elicitation auto-respond missing required field', {
            server,
            field,
            requestId: request.requestId,
          });
          return { requestId: request.requestId, action: 'cancel' };
        }
      }
    }

    log('info', 'elicitation auto-responded', {
      server,
      requestId: request.requestId,
      fieldCount: Object.keys(data).length,
    });

    return { requestId: request.requestId, action: 'submit', data };
  }

  private interactiveRespond(_server: string, request: ElicitationRequest): ElicitationResponse {
    // Store for potential future interactive forwarding
    this.pending.set(request.requestId, request);

    // For now, log the request and dismiss — interactive forwarding
    // requires a bidirectional channel to the MetaMCP client, which
    // stdio transport doesn't support for server-initiated requests.
    log('warn', 'elicitation interactive mode not yet forwarded — dismissing', {
      requestId: request.requestId,
      message: request.message,
    });

    this.pending.delete(request.requestId);
    // Dismiss with a visible log — not silent. The warn log above ensures
    // the operator knows interactive mode is non-functional.
    return { requestId: request.requestId, action: 'dismiss' };
  }

  getPending(): ElicitationRequest[] {
    return [...this.pending.values()];
  }

  updateConfig(config: Partial<ElicitationConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
