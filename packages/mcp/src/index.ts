export const API_ACCORD_MCP_RESOURCE_SCHEME = 'api';

export interface McpBoundaryDescriptor {
  readonly resourceScheme: typeof API_ACCORD_MCP_RESOURCE_SCHEME;
  readonly authority: 'shared-domain-services';
  readonly status: 'reserved-for-issue-14';
}

export function describeMcpBoundary(): McpBoundaryDescriptor {
  return {
    resourceScheme: API_ACCORD_MCP_RESOURCE_SCHEME,
    authority: 'shared-domain-services',
    status: 'reserved-for-issue-14'
  };
}
