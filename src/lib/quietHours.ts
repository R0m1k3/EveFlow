/** Quiet-hours and spoken-summary helpers (pure, unit tested). */

function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** True when `now` falls inside [start, end), with ranges crossing midnight ("22:30" → "07:30"). */
export function isQuietTime(start: string, end: string, now: Date = new Date()): boolean {
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === null || e === null || s === e) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** True when the text or job name contains one of the comma-separated priority words. */
export function isPriority(text: string, keywords: string, jobName = ''): boolean {
  const words = keywords
    .split(/[,;\n]/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  if (!words.length) return false;
  const hay = `${jobName} ${text}`.toLowerCase();
  return words.some((w) => hay.includes(w));
}

/** First `count` sentences of a text, for a short spoken summary of a long push. */
export function summarize(text: string, count: number): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const sentences = clean.match(/[^.!?…]+[.!?…]+["»)]?\s*|[^.!?…]+$/g) ?? [clean];
  const picked = sentences.slice(0, Math.max(1, count)).join('').trim();
  return picked.length < clean.length ? picked : clean;
}
