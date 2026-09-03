/** Text utilities shared by the chat renderer and the speech pipeline. */

const PHONETIC: Record<string, string> = {
  api: 'a-pé-i',
  cors: 'korss',
  svg: 'ess-vé-gé',
  cpu: 'cé-pé-u',
  gpu: 'gé-pé-u',
  fps: 'eff-pé-ess',
  tts: 'té-té-ess',
  stt: 'ess-té-té',
  ui: 'u-i',
  json: 'djé-zone',
  url: 'u-err-el',
  html: 'ach-té-em-el',
  css: 'cé-ess-ess',
  js: 'ji-ess',
  github: 'guite-heub',
  git: 'guite',
  npm: 'enne-pé-em',
  cli: 'cé-el-i',
  ipc: 'i-pé-cé',
  hermes: 'hermès',
  ok: 'oké'
};

/** Convert `MEDIA:/path` tokens (Hermes gateway shorthand) to markdown images. */
export function preprocessMedia(content: string): string {
  if (!content) return content;
  return content.replace(/MEDIA:\s*(\S+)/g, (_m, p: string) => `\n\n![image](${p})\n\n`);
}

/** Strip markdown, code, links, URLs and emojis so the text can be spoken naturally. */
export function cleanForSpeech(raw: string): string {
  if (!raw) return '';
  let text = raw.replace(/MEDIA:\s*\S+/g, '');
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]+)\]\((?:[^)(]+|\([^)(]*\))*\)/g, '$1');
  text = text.replace(/(?:https?|ftp|file):\/\/\S+/gi, '');
  text = text.replace(/www\.\S+/gi, '');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, ', ');
  text = text.replace(/^\s*\d+[.)]\s+/gm, ', ');
  text = text.replace(/^\s*>\s?/gm, '');
  text = text.replace(/\|/g, ' ');
  text = text.replace(/:\s*(?:\r?\n)/g, '. ');
  text = text.replace(/(?:\r?\n){2,}/g, '. ');
  text = text.replace(/\r?\n/g, ' ');
  text = text
    .split(/\s+/)
    .filter((word) => !(word.includes('/') && word.length > 3) && !/^[\d.]+:\d+$/.test(word) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(word))
    .join(' ');
  text = text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{200D}]/gu, '')
    .replace(/(\*\*|__|~~|[*_#`~])/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/(-{2,}|={2,}|~{2,})/g, ' ')
    .replace(/\.{3,}/g, '...')
    .replace(/[<>{}\\^]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return applyPhonetics(text);
}

function applyPhonetics(text: string): string {
  let out = text;
  for (const [key, value] of Object.entries(PHONETIC)) {
    const escaped = key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    out = out.replace(new RegExp(`(?<=^|\\s|\\p{P})${escaped}(?=$|\\s|\\p{P})`, 'giu'), value);
  }
  return out;
}

/**
 * Pull complete sentences out of a streaming buffer.
 * Returns the sentences ready to be spoken and the remainder to keep buffering.
 */
export function extractSentences(buffer: string, minLength = 12): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  // Never split inside an unfinished code block.
  const fences = (buffer.match(/```/g) ?? []).length;
  if (fences % 2 === 1) return { sentences, rest };
  const regex = /[^.!?\n\r]+(?:[.!?]+(?=\s|$)|[\n\r]+)/g;
  let consumed = 0;
  let match: RegExpExecArray | null;
  let pending = '';
  while ((match = regex.exec(buffer)) !== null) {
    if (match.index !== consumed) break; // gap: stop at first non-contiguous match
    const candidate = (pending + match[0]).trim();
    consumed = match.index + match[0].length;
    if (candidate.length < minLength || /\b(?:\d+|[A-Z]|M|Mme|Dr|etc|ex)\.$/.test(candidate)) {
      pending = pending + match[0];
      continue;
    }
    sentences.push(candidate);
    pending = '';
  }
  rest = pending + buffer.slice(consumed);
  return { sentences, rest };
}

/** Split a finished text into speakable chunks of bounded size. */
export function chunkForSpeech(text: string, maxLength = 220): string[] {
  const { sentences, rest } = extractSentences(text + '\n', 1);
  const all = [...sentences, rest.trim()].filter(Boolean);
  const out: string[] = [];
  for (const sentence of all) {
    if (sentence.length <= maxLength) {
      out.push(sentence);
      continue;
    }
    let current = '';
    for (const word of sentence.split(/\s+/)) {
      if ((current + ' ' + word).trim().length > maxLength) {
        if (current) out.push(current.trim());
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) out.push(current.trim());
  }
  return out;
}

export function previewText(value: string, max = 96): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatTime(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatDateTime(date: Date | string | number | undefined): string {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? String(date) : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}j ${h}h`;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  return `${m}m ${(s % 60).toString().padStart(2, '0')}s`;
}
