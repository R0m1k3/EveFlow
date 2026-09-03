/**
 * Encodes wake phrases into the BPE token sequences expected by the sherpa-onnx keyword
 * spotter (gigaspeech BPE-500 model). Common phrases use sequences produced by the real
 * SentencePiece model; anything else falls back to a greedy longest-match over the vocabulary,
 * which is a close approximation for short words.
 */

const KNOWN: Record<string, string> = {
  'JARVIS': '▁JA R VI S',
  'HEY JARVIS': '▁HE Y ▁JA R VI S',
  'OK JARVIS': '▁O K ▁JA R VI S',
  'EVE': '▁E VE',
  'HEY EVE': '▁HE Y ▁E VE',
  'COMPUTER': '▁COMP U TER',
  'HEY COMPUTER': '▁HE Y ▁COMP U TER',
  'FRIDAY': '▁F RI DAY',
  'HEY FRIDAY': '▁HE Y ▁F RI DAY',
  'ALFRED': '▁A L F RE D',
  'HERMES': '▁HER ME S',
  'HEY HERMES': '▁HE Y ▁HER ME S',
  'ASSISTANT': '▁AS S IST ANT',
  'OK GOOGLE': '▁O K ▁GO O G LE',
  'ALEXA': '▁A LE X A',
  'SIRI': '▁S I RI',
  'HEY SIRI': '▁HE Y ▁S I RI',
  'NOVA': '▁NO V A',
  'ATLAS': '▁AT LA S',
  'HAL': '▁HA L'
};

export function normalizeKeyword(phrase: string): string {
  return phrase
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse a sherpa tokens.txt ("piece id" per line) into the set of pieces. */
export function parseTokens(tokensFile: string): Set<string> {
  const pieces = new Set<string>();
  for (const line of tokensFile.split(/\r?\n/)) {
    const piece = line.trim().split(/\s+/)[0];
    if (piece && !piece.startsWith('<')) pieces.add(piece);
  }
  return pieces;
}

function greedyWord(word: string, vocab: Set<string>): string[] | null {
  const out: string[] = [];
  let i = 0;
  let first = true;
  while (i < word.length) {
    let matched = '';
    for (let len = word.length - i; len >= 1; len--) {
      const candidate = (first ? '▁' : '') + word.slice(i, i + len);
      if (vocab.has(candidate)) {
        matched = candidate;
        break;
      }
    }
    if (!matched && first) {
      // No word-initial piece: use a bare "▁" if available, then continue without the prefix.
      if (vocab.has('▁')) out.push('▁');
      first = false;
      continue;
    }
    if (!matched) return null;
    out.push(matched);
    i += matched.length - (first ? 1 : 0);
    first = false;
  }
  return out;
}

/** Encode a phrase into space-separated BPE pieces, or null when it cannot be represented. */
export function encodeKeyword(phrase: string, vocab: Set<string>): string | null {
  const normalized = normalizeKeyword(phrase);
  if (!normalized) return null;
  if (KNOWN[normalized]) return KNOWN[normalized];
  const pieces: string[] = [];
  for (const word of normalized.split(' ')) {
    const encoded = greedyWord(word, vocab);
    if (!encoded) return null;
    pieces.push(...encoded);
  }
  return pieces.join(' ');
}

/** Build the keywords file content: one line per phrase, with the readable label. */
export function buildKeywordsFile(phrases: string[], vocab: Set<string>): { content: string; accepted: string[]; rejected: string[] } {
  const lines: string[] = [];
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const phrase of phrases) {
    const encoded = encodeKeyword(phrase, vocab);
    const label = normalizeKeyword(phrase).toLowerCase().replace(/ /g, '_');
    if (!encoded || !label) {
      rejected.push(phrase);
      continue;
    }
    lines.push(`${encoded} @${label}`);
    accepted.push(label);
  }
  return { content: lines.join('\n') + '\n', accepted, rejected };
}
