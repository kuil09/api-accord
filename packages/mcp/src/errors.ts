// Typed MCP errors with stable machine-readable codes (issue #14).

export type McpErrorCode =
  | 'denied-scope'
  | 'invalid-input'
  | 'not-found'
  | 'domain-rule-violated'
  | 'not-implemented'
  | 'internal';

export class McpError extends Error {
  constructor(readonly code: McpErrorCode, message: string) {
    super(message);
    this.name = 'McpError';
  }
}
