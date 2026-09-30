/** Isolated OAuth regressions: synthetic metadata, temporary state, no browser or shell. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess, { type ExecFileOptions } from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { FileOAuthProvider } from '../oauth-provider.js';
import { LoopbackCallbackServer } from '../oauth-hardening.js';
import { McpClient } from '../mcp-client.js';
import { probeChildEra } from '../modern-client.js';

interface Launch { file: string; args: string[]; options: ExecFileOptions }

async function isolated(
  platform: NodeJS.Platform,
  run: (ctx: { launches: Launch[]; shells: string[]; stderr: () => string;
    onLaunch: (fn: (url: URL) => Promise<void>) => void;
    failLauncher: () => void }) => Promise<void>,
  headless = false,
): Promise<void> {
  const dir = await mkdtemp(join(os.tmpdir(), 'metamcp-oauth-review-'));
  const saved = { homedir: os.homedir, execSync: childProcess.execSync,
    execFile: childProcess.execFile, stderr: process.stderr.write,
    platform: Object.getOwnPropertyDescriptor(process, 'platform')! };
  const keys = ['DISPLAY', 'WAYLAND_DISPLAY', 'SSH_CONNECTION', 'SSH_TTY', 'SystemRoot'];
  const env = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const launches: Launch[] = [];
  const shells: string[] = [];
  const callbacks: Promise<void>[] = [];
  let output = '';
  let fail = false;
  let onLaunch: ((url: URL) => Promise<void>) | undefined;
  const recordCallback = (url: URL) => {
    if (!onLaunch) return;
    const pending = onLaunch(url);
    pending.catch(() => {});
    callbacks.push(pending);
  };
  try {
    os.homedir = () => dir;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    for (const key of keys) delete process.env[key];
    if (!headless) process.env.DISPLAY = ':synthetic';
    process.env.SystemRoot = 'C:\\Windows';
    // The old implementation is intercepted too: never execute URL-derived commands.
    childProcess.execSync = ((command: string) => {
      shells.push(command);
      if (fail) throw new Error('synthetic launcher failure');
      const match = command.match(/^open "(.*)"$/s);
      if (match) recordCallback(new URL(match[1]));
      return Buffer.alloc(0);
    }) as typeof childProcess.execSync;
    childProcess.execFile = ((file: string, args: string[], options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      launches.push({ file, args, options });
      const value = options.env?.METAMCP_AUTHORIZATION_URL ?? args[args.length - 1];
      if (!fail) recordCallback(new URL(value));
      queueMicrotask(() => callback(fail ? new Error('synthetic launcher failure') : null, '', ''));
      return {};
    }) as typeof childProcess.execFile;
    process.stderr.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stderr.write;
    syncBuiltinESMExports();
    await run({ launches, shells, stderr: () => output,
      onLaunch: fn => { onLaunch = fn; }, failLauncher: () => { fail = true; } });
    await Promise.all(callbacks);
  } finally {
    await Promise.allSettled(callbacks);
    os.homedir = saved.homedir;
    childProcess.execSync = saved.execSync;
    childProcess.execFile = saved.execFile;
    process.stderr.write = saved.stderr;
    Object.defineProperty(process, 'platform', saved.platform);
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
}

const legitimate = new URL('https://login.example.test/$fixture/authorize?scope=read+write&literal=%24%26%22%25&redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Fcallback');

await test('era probing preserves an authorization error delivered through onerror and send', async () => {
  const error = new UnauthorizedError();
  const transport: Transport = {
    async start() {}, async close() {},
    async send() { this.onerror?.(error); throw error; },
  };
  await assert.rejects(probeChildEra(transport), err => err === error);
});

for (const platform of ['darwin', 'linux', 'win32'] as const) {
  await test(`${platform}: URL is data, launcher is controlled and bounded`, async () => {
    await isolated(platform, async ({ launches, shells }) => {
      const provider = new FileOAuthProvider('synthetic');
      await provider.redirectToAuthorization(legitimate);
      assert.equal(shells.length, 0, 'must never build a shell command from the URL');
      assert.equal(launches.length, 1);
      const { file, args, options } = launches[0];
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 10_000);
      assert.equal(options.killSignal, 'SIGKILL');
      if (platform === 'win32') {
        assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        assert.equal(options.env?.METAMCP_AUTHORIZATION_URL, legitimate.href);
        assert(!args.some(a => a.includes(legitimate.href)), 'URL must not enter PowerShell source');
        assert(args.includes('-NoProfile'));
        assert(args.includes('-NonInteractive'));
      } else {
        assert.equal(file, platform === 'darwin' ? '/usr/bin/open' : 'xdg-open');
        assert.deepEqual(args, [legitimate.href]);
      }
    });
  });
  await test(`${platform}: missing or failing launcher gives the exact manual URL`, async () => {
    await isolated(platform, async ({ failLauncher, stderr }) => {
      failLauncher();
      await new FileOAuthProvider('synthetic').redirectToAuthorization(legitimate);
      assert(stderr().includes(legitimate.href));
      assert(!stderr().includes('synthetic launcher failure'), 'do not expose subprocess diagnostics');
    });
  });
}

for (const platform of ['linux', 'freebsd'] as const) {
  await test(`${platform}: headless or unsupported platform permits manual authorization`, async () => {
    await isolated(platform, async ({ launches, shells, stderr }) => {
      await new FileOAuthProvider('synthetic').redirectToAuthorization(legitimate);
      assert.equal(launches.length + shells.length, 0);
      assert(stderr().includes(legitimate.href));
    }, true);
  });
}

await test('Wayland desktop can launch without DISPLAY', async () => {
  await isolated('linux', async ({ launches }) => {
    delete process.env.DISPLAY;
    process.env.WAYLAND_DISPLAY = 'synthetic-wayland';
    await new FileOAuthProvider('synthetic').redirectToAuthorization(legitimate);
    assert.equal(launches.length, 1);
  });
});

await test('remote shell falls back to manual authorization', async () => {
  await isolated('darwin', async ({ launches, shells, stderr }) => {
    process.env.SSH_CONNECTION = 'synthetic';
    await new FileOAuthProvider('synthetic').redirectToAuthorization(legitimate);
    assert.equal(launches.length + shells.length, 0);
    assert(stderr().includes(legitimate.href));
  });
});

for (const value of ['file:///synthetic', 'mailto:synthetic@example.test', 'custom:synthetic',
  'javascript:void(0)', 'data:text/plain,synthetic', 'http://example.test/authorize',
  'https://synthetic:secret@example.test/authorize', 'https://example.test/authorize#fragment']) {
  await test(`rejects authorization URL policy violation: ${new URL(value).protocol}${new URL(value).hash ? 'fragment' : ''}${new URL(value).username ? 'userinfo' : ''}`, async () => {
    await isolated('darwin', async ({ launches, shells, stderr }) => {
      const provider = new FileOAuthProvider('synthetic');
      await provider.prepare();
      const redirect = provider.redirectUrl;
      try {
        await assert.rejects(provider.redirectToAuthorization(new URL(value)), /authorization URL/i);
        assert.equal(launches.length + shells.length, 0);
        assert.equal(stderr(), '');
        await assert.rejects(fetch(redirect, { signal: AbortSignal.timeout(500) }));
      } finally { provider.dispose(); }
    });
  });
}

for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
  await test(`loopback HTTP remains usable: ${host}`, async () => {
    await isolated('darwin', async ({ launches }) => {
      const url = new URL(`http://${host}:1234/authorize`);
      await new FileOAuthProvider('synthetic').redirectToAuthorization(url);
      assert.deepEqual(launches[0]?.args, [url.href]);
    });
  });
}

/** Real loopback discovery, registration, token endpoint, and MCP transport. */
async function fixture(modern = false, authAtInitialize = false): Promise<{
  base: string; seen: string[]; setAuthorization: (url: URL) => void; stop: () => Promise<void>;
}> {
  let base = '';
  let authorization: URL | undefined;
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, base).pathname;
    seen.push(path);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
    };
    if (path.includes('oauth-protected-resource')) {
      json({ resource: `${base}/mcp`, authorization_servers: [`${base}/auth`] });
    } else if (path.includes('oauth-authorization-server')) {
      json({ issuer: `${base}/auth`, authorization_endpoint: 'https://login.example.test/$fixture/authorize',
        token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
    } else if (path === '/register') {
      let body = ''; for await (const chunk of req) body += chunk;
      json({ ...JSON.parse(body), client_id: 'synthetic+client &?=', client_secret: 'synthetic-secret' }, 201);
    } else if (path === '/token') {
      let body = ''; for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (!authorization || form.get('code') !== 'synthetic-code' ||
        challenge !== authorization.searchParams.get('code_challenge') ||
        form.get('redirect_uri') !== authorization.searchParams.get('redirect_uri') ||
        form.get('resource') !== `${base}/mcp`) {
        json({ error: 'invalid_grant' }, 400); return;
      }
      json({ access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 3600 });
    } else if (path === '/mcp') {
      let body = ''; for await (const chunk of req) body += chunk;
      const msg = body ? JSON.parse(body) : undefined;
      if (req.headers.authorization !== 'Bearer synthetic-token' &&
        !(authAtInitialize && msg?.method === 'server/discover')) {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
        res.end(); return;
      }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
      if (msg.method === 'server/discover') {
        if (modern) json({ jsonrpc: '2.0', id: msg.id, result: { supportedVersions: ['2026-07-28'], capabilities: {} } });
        else json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      } else if (msg.method === 'initialize') {
        json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } } });
      } else json({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  return { base, seen, setAuthorization: url => { authorization = url; },
    stop: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

await test('SDK discovery and registration preserve OAuth fields through browser launch and token exchange', async () => {
  await isolated('darwin', async ({ launches, shells, onLaunch }) => {
    const f = await fixture();
    const provider = new FileOAuthProvider('sdk-flow', { scope: 'read write offline_access' });
    let observed: URL | undefined;
    try {
      await provider.prepare();
      onLaunch(async url => {
        observed = url; f.setAuthorization(url);
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', 'synthetic-code');
        callback.searchParams.set('state', url.searchParams.get('state')!);
        await fetch(callback).then(r => r.text());
      });
      assert.equal(await auth(provider, { serverUrl: `${f.base}/mcp` }), 'REDIRECT');
      const code = await provider.waitForCallback();
      assert.equal(await auth(provider, { serverUrl: `${f.base}/mcp`, authorizationCode: code }), 'AUTHORIZED');
      assert.equal(shells.length, 0);
      assert.equal(launches.length, 1);
      assert(observed);
      assert.equal(observed.pathname, '/$fixture/authorize');
      assert.equal(observed.searchParams.get('client_id'), 'synthetic+client &?=');
      assert.equal(observed.searchParams.get('scope'), 'read write offline_access');
      assert.equal(observed.searchParams.get('prompt'), 'consent');
      assert.equal(observed.searchParams.get('response_type'), 'code');
      assert.equal(observed.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(observed.searchParams.get('resource'), `${f.base}/mcp`);
      assert(observed.searchParams.get('state')!.length >= 43);
      assert.equal((await provider.tokens())?.access_token, 'synthetic-token');
      await assert.rejects(fetch(observed.searchParams.get('redirect_uri')!, { signal: AbortSignal.timeout(500) }));
    } finally { provider.dispose(); await f.stop(); }
  });
});

for (const [modern, authAtInitialize] of [[false, false], [true, false], [false, true]]) {
  const name = authAtInitialize ? 'McpClient completes OAuth requested during the legacy handshake' :
    `McpClient completes OAuth before selecting ${modern ? 'modern' : 'legacy'} protocol era`;
  await test(name, async () => {
    await isolated('darwin', async ({ onLaunch, launches }) => {
      const f = await fixture(modern, authAtInitialize);
      const client = new McpClient({ name: 'mcp-flow', command: '', criticality: 'optional', transport: 'http', url: `${f.base}/mcp`, oauth: true });
      let redirect: string | undefined;
      try {
        onLaunch(async url => {
          f.setAuthorization(url); redirect = url.searchParams.get('redirect_uri')!;
          const callback = new URL(redirect);
          callback.searchParams.set('code', 'synthetic-code');
          callback.searchParams.set('state', url.searchParams.get('state')!);
          await fetch(callback).then(r => r.text());
        });
        await client.connect();
        assert.equal(client.protocolEra, modern ? 'modern' : 'legacy');
        assert.equal(client.isConnected, true);
        assert.deepEqual(await client.listTools(), []);
        assert(f.seen.includes('/token'));
        assert.equal(launches.length, 1, 'authorize exactly once');
        assert(redirect);
        await assert.rejects(fetch(redirect, { signal: AbortSignal.timeout(500) }));
      } finally { await client.disconnect(); await f.stop(); }
    });
  });
}

await test('callback errors are displayed without interpreting network data as HTML', async () => {
  const callback = await LoopbackCallbackServer.start();
  const pending = callback.waitForCode();
  const rejected = assert.rejects(pending, /callback error/i);
  try {
    const url = new URL(callback.redirectUrl);
    url.searchParams.set('error', '<b>synthetic</b>');
    const response = await fetch(url);
    assert.equal(response.status, 400);
    assert(!(await response.text()).includes('<b>synthetic</b>'));
    await rejected;
  } finally { callback.close(); await rejected; }
});

await test('unrelated requests cannot consume an authorization callback', async () => {
  const callback = await LoopbackCallbackServer.start();
  const pending = callback.waitForCode({ expectedState: 'synthetic-state', timeoutMs: 1000 });
  pending.catch(() => {});
  try {
    const unrelated = new URL(callback.redirectUrl);
    unrelated.pathname = '/unrelated';
    unrelated.searchParams.set('error', 'synthetic');
    const response = await fetch(unrelated);
    await response.text();
    assert.equal(response.status, 404);
    const valid = new URL(callback.redirectUrl);
    valid.searchParams.set('code', 'synthetic-code');
    valid.searchParams.set('state', 'synthetic-state');
    await fetch(valid).then(r => r.text());
    assert.equal((await pending).code, 'synthetic-code');
  } finally { callback.close(); await pending.catch(() => {}); }
});

await test('failure while starting the transport releases callback and reports disconnected', async () => {
  await isolated('darwin', async () => {
    const prepare = FileOAuthProvider.prototype.prepare;
    const start = StreamableHTTPClientTransport.prototype.start;
    let redirect = '';
    FileOAuthProvider.prototype.prepare = async function () {
      await prepare.call(this); redirect = this.redirectUrl;
    };
    StreamableHTTPClientTransport.prototype.start = async () => { throw new Error('synthetic startup failure'); };
    const client = new McpClient({ name: 'startup-failure', command: '', criticality: 'optional',
      transport: 'http', url: 'http://127.0.0.1:1/mcp', oauth: true });
    try {
      await assert.rejects(client.connect(), /synthetic startup failure/);
      assert.equal(client.isConnected, false);
      await assert.rejects(fetch(redirect, { signal: AbortSignal.timeout(500) }));
    } finally {
      await client.disconnect();
      FileOAuthProvider.prototype.prepare = prepare;
      StreamableHTTPClientTransport.prototype.start = start;
    }
  });
});

await test('disposing an in-progress callback settles its waiter promptly', async () => {
  const callback = await LoopbackCallbackServer.start();
  const pending = callback.waitForCode({ timeoutMs: 2000 });
  const rejected = assert.rejects(pending, /closed/i);
  callback.close();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([rejected, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('disposed waiter remained pending')), 300);
    })]);
  } finally { if (timer) clearTimeout(timer); await rejected.catch(() => {}); }
});
