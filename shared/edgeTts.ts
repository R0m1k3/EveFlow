/**
 * Pure helpers for the Microsoft Edge "Read aloud" speech service (the endpoint used by the
 * Edge browser, no API key): request signing input, SSML building, frame parsing and the
 * default French voices. No Node or DOM dependency so it is shared by main and tests.
 */

export const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
export const EDGE_CHROMIUM_VERSION = '143.0.3650.75';
export const EDGE_WSS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}`;
export const EDGE_VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${EDGE_TRUSTED_CLIENT_TOKEN}`;
export const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const WIN_EPOCH_SEC = 11644473600;

/**
 * String whose SHA-256 (upper-case hex) is the `Sec-MS-GEC` value: Windows file time (100 ns
 * ticks since 1601) rounded down to 5 minutes, followed by the trusted client token.
 * `nowMs` is the client clock, `skewSec` the correction learned from the server's Date header.
 */
export function edgeTokenInput(nowMs: number, skewSec = 0): string {
  let seconds = Math.floor(nowMs / 1000 + skewSec) + WIN_EPOCH_SEC;
  seconds -= seconds % 300;
  // 10 million ticks per second; BigInt keeps the 18-digit value exact.
  const ticks = BigInt(seconds) * 10_000_000n;
  return `${ticks}${EDGE_TRUSTED_CLIENT_TOKEN}`;
}

export function edgeHeaders(): Record<string, string> {
  const major = EDGE_CHROMIUM_VERSION.split('.')[0];
  return {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
    'Accept-Language': 'en-US,en;q=0.9',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
  };
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Prosody rate attribute for a playback speed multiplier (1 = "+0%", 1.25 = "+25%"). */
export function edgeRate(speed: number): string {
  const pct = Math.round((Math.max(0.5, Math.min(2, speed || 1)) - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

export function edgeSsml(text: string, voice: string, speed: number): string {
  const lang = voice.split('-').slice(0, 2).join('-') || 'fr-FR';
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${escapeXml(voice)}'><prosody pitch='+0Hz' rate='${edgeRate(speed)}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`
  );
}

/** Timestamp header the service expects ("JavaScript date string"). */
export function edgeTimestamp(date = new Date()): string {
  return date.toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}

export function edgeConfigMessage(date = new Date()): string {
  return (
    `X-Timestamp:${edgeTimestamp(date)}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${EDGE_OUTPUT_FORMAT}"}}}}`
  );
}

export function edgeSsmlMessage(requestId: string, ssml: string, date = new Date()): string {
  return `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${edgeTimestamp(date)}Z\r\nPath:ssml\r\n\r\n${ssml}`;
}

/** Split a binary frame into its text headers and payload (2-byte big-endian header length). */
export function parseEdgeBinaryFrame(frame: Uint8Array): { path: string; payload: Uint8Array } {
  if (frame.byteLength < 2) return { path: '', payload: new Uint8Array(0) };
  const headerLength = (frame[0] << 8) | frame[1];
  const end = Math.min(frame.byteLength, 2 + headerLength);
  let header = '';
  for (let i = 2; i < end; i++) header += String.fromCharCode(frame[i]);
  const path = /Path:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim() ?? '';
  return { path, payload: frame.subarray(end) };
}

/** Path of a text frame ("turn.start", "response", "audio.metadata", "turn.end"). */
export function edgeTextFramePath(message: string): string {
  return /Path:\s*([^\r\n]+)/i.exec(message)?.[1]?.trim() ?? '';
}

export function edgeConnectionId(hex32: string): string {
  return hex32.replace(/-/g, '').toLowerCase();
}

/** Well-known voices per language so the choice works before the voice list is fetched. */
export const EDGE_DEFAULT_VOICES: Record<string, { male: string; female: string }> = {
  fr: { male: 'fr-FR-HenriNeural', female: 'fr-FR-DeniseNeural' },
  en: { male: 'en-US-AndrewMultilingualNeural', female: 'en-US-AvaMultilingualNeural' },
  de: { male: 'de-DE-ConradNeural', female: 'de-DE-KatjaNeural' },
  es: { male: 'es-ES-AlvaroNeural', female: 'es-ES-ElviraNeural' },
  it: { male: 'it-IT-DiegoNeural', female: 'it-IT-ElsaNeural' },
  pt: { male: 'pt-BR-AntonioNeural', female: 'pt-BR-FranciscaNeural' }
};

/** Default Edge voice for a language ("fr-FR", "fr", "en-GB") and gender; French when unknown. */
export function defaultEdgeVoice(language: string, gender: 'male' | 'female'): string {
  const lang = (language || 'fr').toLowerCase().split(/[-_]/)[0];
  return (EDGE_DEFAULT_VOICES[lang] ?? EDGE_DEFAULT_VOICES.fr)[gender];
}

/** Gender of an Edge voice from its short name, using the built-in table then common first names. */
export function edgeVoiceGender(shortName: string): 'male' | 'female' | undefined {
  for (const pair of Object.values(EDGE_DEFAULT_VOICES)) {
    if (pair.male === shortName) return 'male';
    if (pair.female === shortName) return 'female';
  }
  const name = shortName.split('-')[2]?.replace(/(Multilingual)?Neural$/i, '') ?? '';
  if (/^(Henri|Remy|Rémy|Gerard|Antoine|Jean|Thierry|Fabrice|Claude|Andrew|Brian|Guy|Christopher|Eric|Roger|Steffan|Ryan|Thomas|Conrad|Alvaro|Diego|Antonio)$/i.test(name)) return 'male';
  if (/^(Denise|Eloise|Vivienne|Charline|Sylvie|Ariane|Ava|Emma|Jenny|Aria|Michelle|Ana|Sonia|Libby|Katja|Elvira|Elsa|Francisca)$/i.test(name)) return 'female';
  return undefined;
}
