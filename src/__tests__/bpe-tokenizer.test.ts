import { BPETokenizer } from '../bpe-tokenizer.js';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failed++;
    failures.push(`${name}: ${msg}`);
    console.log(`  FAIL: ${name} — ${msg}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

// Test vocab: a small BPE vocabulary for testing
// Byte-level BPE: space (0x20) maps to 'Ġ' (U+0120) via GPT-2 byte-to-unicode
const TEST_VOCAB: Record<string, number> = {
  'h': 0, 'e': 1, 'l': 2, 'o': 3, 'Ġ': 4, 'w': 5, 'r': 6, 'd': 7,
  'he': 8, 'll': 9, 'llo': 10, 'hello': 11,
  'Ġw': 12, 'or': 13, 'Ġwor': 14, 'ld': 15, 'Ġworld': 16,
  '<unk>': 99,
};

// Merges applied in priority order (index = rank, lower = higher priority)
const TEST_MERGES = [
  'h e',       // 0: h+e → he
  'l l',       // 1: l+l → ll
  'll o',      // 2: ll+o → llo
  'Ġ w',       // 3: Ġ+w → Ġw
  'o r',       // 4: o+r → or
  'he llo',    // 5: he+llo → hello
  'Ġw or',     // 6: Ġw+or → Ġwor
  'l d',       // 7: l+d → ld
  'Ġwor ld',   // 8: Ġwor+ld → Ġworld
];

console.log('BPE Tokenizer Tests\n');

await test('1. encode basic text with merges', async () => {
  const tok = BPETokenizer.fromVocabAndMerges(TEST_VOCAB, TEST_MERGES);
  const ids = tok.encode('hello');
  assertEqual(ids.length, 1, 'token count');
  assertEqual(ids[0], 11, 'hello token id');
});

await test('2. encode multi-word text', async () => {
  const tok = BPETokenizer.fromVocabAndMerges(TEST_VOCAB, TEST_MERGES);
  const ids = tok.encode('hello world');
  // "hello" -> 11, " world" -> 16
  assertEqual(ids.length, 2, 'token count');
  assertEqual(ids[0], 11, 'hello id');
  assertEqual(ids[1], 16, 'world id');
});

await test('3. decode reverses encode', async () => {
  const tok = BPETokenizer.fromVocabAndMerges(TEST_VOCAB, TEST_MERGES);
  const text = 'hello world';
  const ids = tok.encode(text);
  const decoded = tok.decode(ids);
  assertEqual(decoded, text, 'roundtrip');
});

await test('4. empty string encodes to empty array', async () => {
  const tok = BPETokenizer.fromVocabAndMerges(TEST_VOCAB, TEST_MERGES);
  const ids = tok.encode('');
  assertEqual(ids.length, 0, 'empty');
});

await test('5. unknown tokens use <unk> id', async () => {
  const tok = BPETokenizer.fromVocabAndMerges(TEST_VOCAB, TEST_MERGES, 99);
  // 'z' byte maps to a unicode char not in vocab, should use <unk>
  const ids = tok.encode('z');
  assert(ids.length > 0, 'should produce tokens');
  assertEqual(ids[0], 99, 'unknown mapped to unk id');
});

await test('6. vocabSize returns correct count', async () => {
  const tok = BPETokenizer.fromVocabAndMerges(TEST_VOCAB, TEST_MERGES);
  assertEqual(tok.vocabSize, Object.keys(TEST_VOCAB).length, 'vocab size');
});

await test('7. fromFile loads tokenizer.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpe-test-'));
  const tokPath = join(dir, 'tokenizer.json');
  writeFileSync(tokPath, JSON.stringify({
    model: { type: 'BPE', vocab: TEST_VOCAB, merges: TEST_MERGES },
    added_tokens: [{ id: 99, content: '<unk>', special: true }],
  }));
  const tok = await BPETokenizer.fromFile(tokPath);
  const ids = tok.encode('hello');
  assertEqual(ids[0], 11, 'loaded tokenizer works');
  unlinkSync(tokPath);
});

await test('8. fromFile rejects non-BPE type', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpe-test-'));
  const tokPath = join(dir, 'tokenizer.json');
  writeFileSync(tokPath, JSON.stringify({
    model: { type: 'Unigram', vocab: {}, merges: [] },
  }));
  let threw = false;
  try {
    await BPETokenizer.fromFile(tokPath);
  } catch (e) {
    threw = true;
    assert(e instanceof Error && e.message.includes('Unsupported'), 'error message');
  }
  assert(threw, 'should throw for non-BPE');
  unlinkSync(tokPath);
});

await test('9. token IDs are numbers suitable for wire protocol', async () => {
  const tok = BPETokenizer.fromVocabAndMerges(TEST_VOCAB, TEST_MERGES);
  const ids = tok.encode('hello world');
  for (const id of ids) {
    assertEqual(typeof id, 'number', 'id is number');
    assert(Number.isFinite(id), 'id is finite');
    assert(Number.isInteger(id), 'id is integer');
  }
});

await test('10. decode empty array returns empty string', async () => {
  const tok = BPETokenizer.fromVocabAndMerges(TEST_VOCAB, TEST_MERGES);
  assertEqual(tok.decode([]), '', 'empty decode');
});

// Print summary
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
