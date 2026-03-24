/**
 * MCP (Model Context Protocol) Types
 */

export type McpServerConfig =
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: 'http';
      url: string;
      headers?: Record<string, string>;
      auth?: McpAuthConfig;
    };

export type McpAuthConfig =
  | { type: 'bearer'; token: string }
  | { type: 'api_key'; key: string; header?: string }
  | { type: 'oauth2'; clientId: string; clientSecret: string; tokenUrl: string; scopes?: string[] };

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
