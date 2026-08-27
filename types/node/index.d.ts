declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }

  interface ErrnoException extends Error {
    code?: string;
  }
}

declare const process: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  execPath: string;
  exitCode: number | undefined;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  loadEnvFile(path?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

declare module 'node:crypto' {
  export function randomUUID(): string;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
}

declare module 'node:fs/promises' {
  export function readFile(path: string | URL, encoding?: 'utf8'): Promise<string | Uint8Array>;
  export function readdir(path: string | URL, options?: unknown): Promise<string[]>;
}

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | readonly string[] | undefined>;
  }

  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(chunk?: unknown): void;
  }

  export interface Server {
    listening: boolean;
    listen(port: number, callback?: () => void): this;
    listen(port: number, host: string, callback?: () => void): this;
    close(callback: (error?: Error) => void): void;
    address(): unknown;
  }

  export function createServer(
    listener: (request: IncomingMessage, response: ServerResponse) => void
  ): Server;
}

declare module 'node:net' {
  export interface AddressInfo {
    address: string;
    family: string;
    port: number;
  }
}

declare module 'node:path' {
  export function extname(path: string): string;
}

declare module 'node:perf_hooks' {
  export const performance: {
    now(): number;
  };
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:test' {
  export interface TestContext {
    after(callback: () => void | Promise<void>): void;
  }

  export function describe(name: string, callback: () => void): void;
  export function it(name: string, callback: (context: TestContext) => void | Promise<void>): void;
  export const test: typeof it;
}

declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    rejects(block: () => Promise<unknown>, error?: RegExp): Promise<void>;
    throws(block: () => unknown, error?: RegExp): void;
  }
  const assert: Assert;
  export default assert;
}
