export const API_ACCORD_MCP_RESOURCE_SCHEME = 'api';

export interface McpBoundaryDescriptor {
  readonly resourceScheme: typeof API_ACCORD_MCP_RESOURCE_SCHEME;
  readonly authority: 'shared-domain-services';
  readonly status: 'active';
}

export function describeMcpBoundary(): McpBoundaryDescriptor {
  return {
    resourceScheme: API_ACCORD_MCP_RESOURCE_SCHEME,
    authority: 'shared-domain-services',
    status: 'active'
  };
}

export { ApiAccordMcpServer, MCP_TOOL_DESCRIPTORS, type ApiAccordMcpServerOptions, type McpCaller, type McpToolDescriptor, type McpResult } from './server.js';
export { McpError, type McpErrorCode } from './errors.js';
export { formatResourceUri, parseResourceUri, listResourceDescriptors, readResource, type McpResourceDescriptor, type ResourceType } from './resources.js';
