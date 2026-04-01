import { readFile } from 'node:fs/promises';

interface NormalizerConfig {
  type: string;
  normalizers?: NormalizerConfig[];
}

interface PostProcessorConfig {
  type: string;
  single?: Array<{ SpecialToken?: { id: string; type_id: number }; Sequence?: { id: string; type_id: number } }>;
  pair?: Array<{ SpecialToken?: { id: string; type_id: number }; Sequence?: { id: string; type_id: number } }>;
  special_tokens?: Record<string, { id: string; ids: number[]; tokens: string[] }>;
}

interface TokenizerJson {
  version?: string;
  model: {
    type: string;
    vocab: Record<string, number>;
    merges: string[];
  };
  added_tokens?: Array<{ id: number; content: string; special: boolean }>;
  normalizer?: NormalizerConfig | null;
  pre_tokenizer?: unknown;
  post_processor?: PostProcessorConfig | null;
  decoder?: unknown;
  truncation?: unknown;
  padding?: unknown;
}

// GPT-2 style byte-to-unicode mapping
function bytesToUnicode(): Map<number, string> {
  const bs: number[] = [];
  for (let i = 0x21; i <= 0x7E; i++) bs.push(i); // printable ASCII
  for (let i = 0xA1; i <= 0xAC; i++) bs.push(i);
  for (let i = 0xAE; i <= 0xFF; i++) bs.push(i);

  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }

  const map = new Map<number, string>();
  for (let i = 0; i < bs.length; i++) {
    map.set(bs[i]!, String.fromCodePoint(cs[i]!));
  }
  return map;
}

export class BPETokenizer {
  private vocab: Map<string, number>;
  private reverseVocab: Map<number, string>;
  private merges: Map<string, number>; // "tokenA tokenB" → priority (lower = higher priority)
  private byteEncoder: Map<number, string>;
  private byteDecoder: Map<string, number>;
  private unkId: number | undefined;
  private normalizer: NormalizerConfig | null;
  private specialTokens: Map<string, number>;
  private specialTokenPatterns: string[];
  private postProcessor: PostProcessorConfig | null;

  private constructor(
    vocab: Map<string, number>,
    merges: Map<string, number>,
    unkId: number | undefined,
    normalizer: NormalizerConfig | null = null,
    specialTokens: Map<string, number> = new Map(),
    postProcessor: PostProcessorConfig | null = null,
  ) {
    this.vocab = vocab;
    this.reverseVocab = new Map();
    for (const [token, id] of vocab) this.reverseVocab.set(id, token);
    this.merges = merges;
    this.unkId = unkId;
    this.normalizer = normalizer;
    this.specialTokens = specialTokens;
    this.specialTokenPatterns = [...specialTokens.keys()].sort((a, b) => b.length - a.length);
    this.postProcessor = postProcessor;

    this.byteEncoder = bytesToUnicode();
    this.byteDecoder = new Map();
    for (const [b, u] of this.byteEncoder) this.byteDecoder.set(u, b);
  }

  static async fromFile(path: string): Promise<BPETokenizer> {
    const raw = await readFile(path, 'utf-8');
    const json = JSON.parse(raw) as TokenizerJson;

    if (json.model.type !== 'BPE') {
      throw new Error(`Unsupported tokenizer type: ${json.model.type}`);
    }

    const vocab = new Map(Object.entries(json.model.vocab));
    const merges = new Map<string, number>();
    for (let i = 0; i < json.model.merges.length; i++) {
      merges.set(json.model.merges[i]!, i);
    }

    const specialTokens = new Map<string, number>();
    if (json.added_tokens) {
      for (const t of json.added_tokens) {
        vocab.set(t.content, t.id);
        if (t.special) {
          specialTokens.set(t.content, t.id);
        }
      }
    }

    const unkId = vocab.get('<unk>');
    return new BPETokenizer(
      vocab,
      merges,
      unkId,
      json.normalizer ?? null,
      specialTokens,
      json.post_processor ?? null,
    );
  }

  static fromVocabAndMerges(
    vocab: Record<string, number>,
    merges: string[],
    unkId?: number,
    config?: {
      normalizer?: NormalizerConfig | null;
      specialTokens?: Map<string, number>;
      postProcessor?: PostProcessorConfig | null;
    },
  ): BPETokenizer {
    const vocabMap = new Map(Object.entries(vocab));
    const mergesMap = new Map<string, number>();
    for (let i = 0; i < merges.length; i++) {
      mergesMap.set(merges[i]!, i);
    }
    return new BPETokenizer(
      vocabMap,
      mergesMap,
      unkId,
      config?.normalizer ?? null,
      config?.specialTokens,
      config?.postProcessor ?? null,
    );
  }

  encode(text: string): number[] {
    if (text.length === 0) return [];

    const segments = this.splitOnSpecialTokens(text);
    const ids: number[] = [];

    for (const seg of segments) {
      const specialId = this.specialTokens.get(seg);
      if (specialId !== undefined) {
        ids.push(specialId);
        continue;
      }

      const normalized = this.normalize(seg);
      const words = this.preTokenize(normalized);
      for (const word of words) {
        const bpeTokens = this.bpe(word);
        for (const token of bpeTokens) {
          const id = this.vocab.get(token);
          if (id !== undefined) {
            ids.push(id);
          } else if (this.unkId !== undefined) {
            ids.push(this.unkId);
          }
        }
      }
    }

    return this.applyPostProcessor(ids);
  }

  decode(ids: number[]): string {
    const tokens: string[] = [];
    for (const id of ids) {
      const token = this.reverseVocab.get(id);
      if (token !== undefined) tokens.push(token);
    }

    const text = tokens.join('');
    const bytes: number[] = [];
    for (const ch of text) {
      const b = this.byteDecoder.get(ch);
      if (b !== undefined) {
        bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString('utf-8');
  }

  get vocabSize(): number {
    return this.vocab.size;
  }

  private normalize(text: string): string {
    if (!this.normalizer) return text;
    return this.applyNormalizer(text, this.normalizer);
  }

  private applyNormalizer(text: string, config: NormalizerConfig): string {
    switch (config.type) {
      case 'NFC': return text.normalize('NFC');
      case 'NFD': return text.normalize('NFD');
      case 'NFKC': return text.normalize('NFKC');
      case 'NFKD': return text.normalize('NFKD');
      case 'Lowercase': return text.toLowerCase();
      case 'StripAccents': return text.normalize('NFD').replace(/\p{M}/gu, '');
      case 'Sequence':
        if (config.normalizers) {
          for (const n of config.normalizers) text = this.applyNormalizer(text, n);
        }
        return text;
      default: return text;
    }
  }

  private splitOnSpecialTokens(text: string): string[] {
    if (this.specialTokenPatterns.length === 0) return [text];

    const segments: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      let earliest = -1;
      let matchedToken = '';

      for (const token of this.specialTokenPatterns) {
        const idx = remaining.indexOf(token);
        if (idx !== -1 && (earliest === -1 || idx < earliest)) {
          earliest = idx;
          matchedToken = token;
        }
      }

      if (earliest === -1) {
        segments.push(remaining);
        break;
      }

      if (earliest > 0) {
        segments.push(remaining.slice(0, earliest));
      }
      segments.push(matchedToken);
      remaining = remaining.slice(earliest + matchedToken.length);
    }

    return segments;
  }

  private applyPostProcessor(ids: number[]): number[] {
    if (!this.postProcessor) return ids;

    const { type, single, special_tokens } = this.postProcessor;
    if ((type === 'TemplateProcessing' || type === 'BertProcessing') && single) {
      const result: number[] = [];
      for (const entry of single) {
        if (entry.SpecialToken && special_tokens) {
          const st = special_tokens[entry.SpecialToken.id];
          if (st) result.push(...st.ids);
        } else if (entry.Sequence) {
          result.push(...ids);
        }
      }
      return result;
    }

    return ids;
  }

  private preTokenize(text: string): string[][] {
    // GPT-2 style: split on whitespace boundaries and punctuation
    // Each "word" becomes a list of byte-encoded characters
    const pattern = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+/gu;
    const matches = text.match(pattern) ?? [text];

    const words: string[][] = [];
    for (const m of matches) {
      const encoded = Buffer.from(m, 'utf-8');
      const chars: string[] = [];
      for (const byte of encoded) {
        chars.push(this.byteEncoder.get(byte) ?? String.fromCodePoint(byte));
      }
      words.push(chars);
    }
    return words;
  }

  private bpe(word: string[]): string[] {
    if (word.length <= 1) return [...word];

    let pairs = this.getPairs(word);

    while (true) {
      // Find the pair with the lowest merge rank
      let bestPair: [string, string] | null = null;
      let bestRank = Infinity;

      for (const [a, b] of pairs) {
        const rank = this.merges.get(`${a} ${b}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestPair = [a, b];
        }
      }

      if (!bestPair) break;

      // Merge the best pair throughout the word
      const [first, second] = bestPair;
      const merged = first + second;
      const newWord: string[] = [];
      let i = 0;

      while (i < word.length) {
        if (i < word.length - 1 && word[i] === first && word[i + 1] === second) {
          newWord.push(merged);
          i += 2;
        } else {
          newWord.push(word[i]!);
          i++;
        }
      }

      word = newWord;
      if (word.length === 1) break;
      pairs = this.getPairs(word);
    }

    return word;
  }

  private getPairs(word: string[]): [string, string][] {
    const pairs: [string, string][] = [];
    for (let i = 0; i < word.length - 1; i++) {
      pairs.push([word[i]!, word[i + 1]!]);
    }
    return pairs;
  }
}
