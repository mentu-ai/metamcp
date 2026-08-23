import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { scrubValue } from '../secret-scrubber.js';
import { clearVaultCache, resolveSecrets, setSecretProviders } from '../vault-resolver.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${message}`);
    console.log(`  FAIL: ${name} - ${message}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

console.log('Configuration Security Tests\n');

test('custom SecretProvider resolves inline references', () => {
  setSecretProviders([{ name: 'fixture', resolve: key => key === 'TOKEN' ? 'scoped-value' : undefined }]);
  try {
    const resolved = resolveSecrets({ authorization: 'Bearer ${TOKEN}' });
    assert(resolved.authorization === 'Bearer scoped-value', 'provider value');
  } finally {
    clearVaultCache();
  }
});

test('unresolved secret references fail closed', () => {
  setSecretProviders([{ name: 'empty', resolve: () => undefined }]);
  try {
    let rejected = false;
    try {
      resolveSecrets({ API_KEY: '${MISSING_KEY}' });
    } catch (err) {
      rejected = err instanceof Error && err.message.includes('Unresolved secret reference');
    }
    assert(rejected, 'unresolved reference accepted');
  } finally {
    clearVaultCache();
  }
});

test('malformed secret references fail closed', () => {
  let rejected = false;
  try {
    resolveSecrets({ API_KEY: '${INVALID-NAME}' });
  } catch (err) {
    rejected = err instanceof Error && err.message.includes('Invalid secret reference');
  }
  assert(rejected, 'malformed secret reference accepted');
});

test('resolved config credentials are scrubbed from structured output', () => {
  const root = mkdtempSync(join(tmpdir(), 'metamcp-config-security-'));
  try {
    const path = join(root, 'mcp.json');
    setSecretProviders([{ name: 'fixture', resolve: key => key === 'TOKEN' ? 'custom-secret-12345' : undefined }]);
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        fixture: {
          command: 'fixture',
          env: { API_KEY: '${TOKEN}' },
          headers: { Authorization: 'Bearer ${TOKEN}', 'X-Context': 'prefix-${TOKEN}-suffix' },
        },
      },
    }));
    loadConfig(path);
    const scrubbed = scrubValue({ content: [{ text: 'custom-secret-12345' }] }) as {
      content?: Array<{ text?: string }>;
    };
    assert(scrubbed.content?.[0]?.text === '[REDACTED:CONFIG]', 'exact secret leaked');
    const embedded = scrubValue({ text: 'custom-secret-12345' }) as { text?: string };
    assert(embedded.text === '[REDACTED:CONFIG]', 'embedded resolved secret leaked');
  } finally {
    clearVaultCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid JSON config is rejected instead of becoming an empty gateway', () => {
  const root = mkdtempSync(join(tmpdir(), 'metamcp-config-invalid-'));
  try {
    const path = join(root, 'mcp.json');
    writeFileSync(path, '{invalid');
    let rejected = false;
    try {
      loadConfig(path);
    } catch (err) {
      rejected = err instanceof Error && err.message.includes('Invalid JSON');
    }
    assert(rejected, 'invalid config accepted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('path-like server names and non-string environment values are rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'metamcp-config-path-'));
  try {
    const path = join(root, 'mcp.json');
    writeFileSync(path, JSON.stringify({
      mcpServers: { '../../escape': { command: 'fixture' } },
    }));
    let pathRejected = false;
    try {
      loadConfig(path);
    } catch (err) {
      pathRejected = err instanceof Error && err.message.includes('Invalid server name');
    }
    assert(pathRejected, 'path-like server name accepted');

    writeFileSync(path, JSON.stringify({
      mcpServers: { fixture: { command: 'fixture', env: { TOKEN: 42 } } },
    }));
    let envRejected = false;
    try {
      loadConfig(path);
    } catch (err) {
      envRejected = err instanceof Error && err.message.includes('env must contain string values');
    }
    assert(envRejected, 'non-string environment value accepted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous transports and invalid lifecycle values are rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'metamcp-config-transport-'));
  try {
    const path = join(root, 'mcp.json');
    writeFileSync(path, JSON.stringify({
      mcpServers: { fixture: { command: 'fixture', url: 'https://example.com/mcp' } },
    }));
    let ambiguous = false;
    try { loadConfig(path); } catch (err) {
      ambiguous = err instanceof Error && err.message.includes('mutually exclusive');
    }
    assert(ambiguous, 'ambiguous transport accepted');

    writeFileSync(path, JSON.stringify({
      mcpServers: { fixture: { command: 'fixture', lifecycle: { mode: 'keep-alive', idleTimeoutMs: 'forever' } } },
    }));
    let lifecycle = false;
    try { loadConfig(path); } catch (err) {
      lifecycle = err instanceof Error && err.message.includes('idleTimeoutMs');
    }
    assert(lifecycle, 'invalid lifecycle timeout accepted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
