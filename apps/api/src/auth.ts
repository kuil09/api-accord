// Authentication endpoints for API Accord (issue #53).
// Provides login, logout, and session validation endpoints.

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Logger } from '@api-accord/config';
import { IdentityService, verifySecret } from '@api-accord/domain';
import type { SessionStore } from '@api-accord/persistence';

export interface AuthConfig {
  readonly logger: Logger;
  readonly sessionStore: SessionStore;
  readonly identityService: IdentityService;
  readonly sessionTtlMs: number;
}

export interface LoginRequest {
  readonly credentialId: string;
  readonly secret: string;
}

export interface LoginResponse {
  readonly sessionId: string;
  readonly principalId: string;
  readonly principalKind: string;
  readonly organizationId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly expiresAt: string;
}

export interface MeResponse {
  readonly principalId: string;
  readonly principalKind: string;
  readonly organizationId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly sessionExpiresAt: string;
}

const SESSION_COOKIE_NAME = 'api_accord_session';

function parseJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => { data += chunk; });
    request.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    request.on('error', reject);
  });
}

function setSessionCookie(response: ServerResponse, sessionId: string, expiresAt: Date): void {
  const cookie = [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    `Expires=${expiresAt.toUTCString()}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=86400'
  ].join('; ');
  response.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(response: ServerResponse): void {
  const cookie = [
    `${SESSION_COOKIE_NAME}=`,
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0'
  ].join('; ');
  response.setHeader('Set-Cookie', cookie);
}

function getSessionIdFromCookie(request: IncomingMessage): string | undefined {
  const cookieHeader = request.headers['cookie'];
  if (!cookieHeader) return undefined;
  const cookieHeaderStr = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  const cookies = cookieHeaderStr.split(';').map((c: string) => c.trim());
  for (const cookie of cookies) {
    if (cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      return cookie.substring(SESSION_COOKIE_NAME.length + 1);
    }
  }
  return undefined;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload)}\n`);
}

export interface AuthConfig {
  readonly logger: Logger;
  readonly sessionStore: SessionStore;
  readonly identityService: IdentityService;
  readonly sessionTtlMs: number;
}

export interface LoginRequest {
  readonly credentialId: string;
  readonly secret: string;
}

export interface LoginResponse {
  readonly sessionId: string;
  readonly principalId: string;
  readonly principalKind: string;
  readonly organizationId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly expiresAt: string;
}

export interface MeResponse {
  readonly principalId: string;
  readonly principalKind: string;
  readonly organizationId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly sessionExpiresAt: string;
}

export async function handleAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: AuthConfig
): Promise<boolean> {
  const correlationId = request.headers['x-correlation-id'] as string | undefined;
  const url = new URL(request.url ?? '/', 'http://api-accord.local');

  if (request.method !== 'POST' && request.method !== 'GET') {
    writeJson(response, 405, { error: 'method_not_allowed', correlationId });
    return true;
  }

  // POST /api/auth/login
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    try {
      const body = await parseJsonBody(request) as { credentialId?: string; secret?: string };
      const { credentialId, secret } = body;

      if (!credentialId || !secret) {
        writeJson(response, 400, { error: 'invalid_input', message: 'credentialId and secret required', correlationId });
        return true;
      }

      // Get all events and find the credential
      const events = await config.identityService.getAllEvents() as readonly unknown[];
      let credentialEvent: { credentialId: string; principalId: string; secretHash: string; scopes: string[]; principalKind: string; organizationId: string } | undefined;

      for (const envelope of events) {
        if ((envelope as any).event?.type === 'CredentialIssued' && (envelope as any).event?.credentialId === credentialId) {
          const revokedEvent = events.find(e => (e as any).event?.type === 'CredentialRevoked' && (e as any).event?.credentialId === credentialId);
          if (revokedEvent) continue;

          const rotatedEvent = events.find(e => (e as any).event?.type === 'CredentialRotated' && (e as any).event?.credentialId === credentialId);
          if (rotatedEvent) continue;

          credentialEvent = {
            credentialId: (envelope as any).event.credentialId,
            principalId: (envelope as any).event.principalId,
            secretHash: (envelope as any).event.secretHash,
            scopes: (envelope as any).event.scopes,
            principalKind: 'service',
            organizationId: ''
          };
          break;
        }
      }

      if (!credentialEvent) {
        writeJson(response, 401, { error: 'invalid_credential', correlationId });
        return true;
      }

      // Verify the secret
      const isValid = await verifySecret(credentialEvent.secretHash, secret);
      if (!isValid) {
        writeJson(response, 401, { error: 'invalid_credential', correlationId });
        return true;
      }

      // Get principal info from event store
      let principalOrgId = '';
      let principalKind = 'service';
      for (const envelope of events) {
        if ((envelope as any).event?.type === 'PrincipalRegistered' && (envelope as any).event?.principalId === credentialEvent.principalId) {
          principalOrgId = (envelope as any).event.organizationId;
          principalKind = (envelope as any).event.kind;
          break;
        }
      }

      // Create session
      const session = await config.sessionStore.create({
        principalId: credentialEvent.principalId,
        principalKind: principalKind as 'human' | 'agent' | 'service' | 'ci' | 'integration',
        organizationId: principalOrgId,
        scopes: credentialEvent.scopes
      }, config.sessionTtlMs);

      const responsePayload: LoginResponse = {
        sessionId: session.sessionId,
        principalId: session.principalId,
        principalKind: session.principalKind,
        organizationId: session.organizationId,
        scopes: session.scopes,
        expiresAt: session.expiresAt.toISOString()
      };

      setSessionCookie(response, session.sessionId, session.expiresAt);
      writeJson(response, 200, { ...responsePayload, correlationId });
      return true;
    } catch (error) {
      const err = error as Record<string, unknown>;
      config.logger.error('auth.login.failed', { correlationId, ...err });
      writeJson(response, 500, { error: 'internal', correlationId });
      return true;
    }
  }

  // POST /api/auth/logout
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    const sessionId = getSessionIdFromCookie(request);
    if (sessionId) {
      await config.sessionStore.delete(sessionId);
    }
    clearSessionCookie(response);
    writeJson(response, 200, { message: 'logged_out', correlationId });
    return true;
  }

  // GET /api/auth/me
  if (request.method === 'GET' && url.pathname === '/api/auth/me') {
    const sessionId = getSessionIdFromCookie(request);
    if (!sessionId) {
      writeJson(response, 401, { error: 'unauthenticated', correlationId });
      return true;
    }

    const session = await config.sessionStore.get(sessionId);
    if (!session) {
      clearSessionCookie(response);
      writeJson(response, 401, { error: 'session_expired', correlationId });
      return true;
    }

    // Touch session to extend expiry
    await config.sessionStore.touch(sessionId, 24 * 60 * 60 * 1000);

    const responsePayload: MeResponse = {
      principalId: session.principalId,
      principalKind: session.principalKind,
      organizationId: session.organizationId,
      scopes: session.scopes,
      sessionExpiresAt: session.expiresAt.toISOString()
    };

    writeJson(response, 200, { ...responsePayload, correlationId });
    return true;
  }

  return false;
}

// Session validation middleware
export async function requireAuth(
  request: IncomingMessage,
  sessionStore: SessionStore
): Promise<any | null> {
  const cookieHeader = request.headers['cookie'];
  if (!cookieHeader) return null;

  const cookieHeaderStr = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  const cookies = cookieHeaderStr.split(';').map((c: string) => c.trim());
  let sessionId: string | undefined;
  for (const cookie of cookies) {
    if (cookie.startsWith('api_accord_session=')) {
      sessionId = cookie.substring('api_accord_session='.length);
      break;
    }
  }

  if (!sessionId) return null;

  const session = await sessionStore.get(sessionId);
  if (!session) return null;

  // Touch session to extend expiry
  await sessionStore.touch(sessionId, 24 * 60 * 60 * 1000);

  return session;
}