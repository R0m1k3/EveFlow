import { describe, expect, it } from 'vitest';
import {
  defaultEdgeVoice,
  edgeConfigMessage,
  edgeRate,
  edgeSsml,
  edgeSsmlMessage,
  edgeTextFramePath,
  edgeTokenInput,
  edgeVoiceGender,
  escapeXml,
  parseEdgeBinaryFrame
} from '../shared/edgeTts';

describe('edge token input', () => {
  it('uses Windows file time rounded down to 5 minutes followed by the client token', () => {
    // 2026-09-04T15:23:47Z → 15:20:00Z = 1788535200 s since 1970 → +11644473600 = 13433008800 s → ×1e7 ticks.
    const nowMs = Date.UTC(2026, 8, 4, 15, 23, 47);
    expect(edgeTokenInput(nowMs)).toBe('1343300880000000006A5AA1D4EAFF4E9FB37E23D68491D6F4');
  });
  it('is stable inside a 5-minute window and applies the clock skew', () => {
    const a = edgeTokenInput(Date.UTC(2026, 8, 4, 15, 20, 1));
    const b = edgeTokenInput(Date.UTC(2026, 8, 4, 15, 24, 59));
    expect(a).toBe(b);
    expect(edgeTokenInput(Date.UTC(2026, 8, 4, 15, 20, 1), 300)).not.toBe(a);
  });
});

describe('edge ssml', () => {
  it('escapes text and derives the language from the voice', () => {
    const ssml = edgeSsml('Tom & Jerry <3 "ok"', 'fr-FR-HenriNeural', 1.25);
    expect(ssml).toContain("xml:lang='fr-FR'");
    expect(ssml).toContain("<voice name='fr-FR-HenriNeural'>");
    expect(ssml).toContain("rate='+25%'");
    expect(ssml).toContain('Tom &amp; Jerry &lt;3 &quot;ok&quot;');
    expect(escapeXml("l'été")).toBe('l&apos;été');
  });
  it('formats rates with a sign', () => {
    expect(edgeRate(1)).toBe('+0%');
    expect(edgeRate(0.8)).toBe('-20%');
    expect(edgeRate(3)).toBe('+100%');
  });
  it('builds the config and ssml messages with the expected headers', () => {
    const date = new Date(Date.UTC(2026, 8, 4, 15, 23, 47));
    const config = edgeConfigMessage(date);
    expect(config.startsWith('X-Timestamp:Fri, 04 Sep 2026 15:23:47 GMT+0000 (Coordinated Universal Time)\r\n')).toBe(true);
    expect(config).toContain('Path:speech.config\r\n\r\n{');
    expect(config).toContain('audio-24khz-48kbitrate-mono-mp3');
    const ssml = edgeSsmlMessage('abc123', '<speak/>', date);
    expect(ssml).toContain('X-RequestId:abc123\r\n');
    expect(ssml).toContain('Content-Type:application/ssml+xml\r\n');
    expect(ssml.endsWith('Path:ssml\r\n\r\n<speak/>')).toBe(true);
    expect(edgeTextFramePath('X-RequestId:1\r\nContent-Type:application/json\r\nPath:turn.end\r\n\r\n{}')).toBe('turn.end');
  });
});

describe('edge binary frames', () => {
  it('splits the header (2-byte big-endian length) from the audio payload', () => {
    const header = 'X-RequestId:1\r\nContent-Type:audio/mpeg\r\nX-StreamId:2\r\nPath:audio\r\n';
    const payload = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    const frame = new Uint8Array(2 + header.length + payload.length);
    frame[0] = header.length >> 8;
    frame[1] = header.length & 0xff;
    for (let i = 0; i < header.length; i++) frame[2 + i] = header.charCodeAt(i);
    frame.set(payload, 2 + header.length);
    const parsed = parseEdgeBinaryFrame(frame);
    expect(parsed.path).toBe('audio');
    expect([...parsed.payload]).toEqual([...payload]);
  });
  it('tolerates truncated frames', () => {
    expect(parseEdgeBinaryFrame(new Uint8Array([0x00])).payload.byteLength).toBe(0);
    expect(parseEdgeBinaryFrame(new Uint8Array([0x10, 0x00, 0x41])).path).toBe('');
  });
});

describe('edge voices', () => {
  it('picks Henri / Denise for French and falls back to French for unknown languages', () => {
    expect(defaultEdgeVoice('fr-FR', 'male')).toBe('fr-FR-HenriNeural');
    expect(defaultEdgeVoice('fr', 'female')).toBe('fr-FR-DeniseNeural');
    expect(defaultEdgeVoice('en-GB', 'male')).toBe('en-US-AndrewMultilingualNeural');
    expect(defaultEdgeVoice('xx', 'female')).toBe('fr-FR-DeniseNeural');
  });
  it('knows the gender of the common French voices', () => {
    expect(edgeVoiceGender('fr-FR-HenriNeural')).toBe('male');
    expect(edgeVoiceGender('fr-FR-RemyMultilingualNeural')).toBe('male');
    expect(edgeVoiceGender('fr-FR-VivienneMultilingualNeural')).toBe('female');
    expect(edgeVoiceGender('fr-CA-SylvieNeural')).toBe('female');
    expect(edgeVoiceGender('zz-ZZ-NobodyNeural')).toBeUndefined();
  });
});
