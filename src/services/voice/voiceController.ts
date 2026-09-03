/**
 * Voice controller: microphone → VAD → STT → conversation, plus hands-free loop and barge-in.
 */
import { Log } from '../../lib/log';
import { useChat } from '../../state/chat';
import { useSettings } from '../../state/settings';
import { useVoice } from '../../state/voice';
import { sendMessage } from '../conversation';
import { audioBus } from './audioBus';
import { listMicrophones, MicCapture } from './capture';
import { speech } from './speech';
import { BrowserRecognizer, transcribeWav } from './stt';
import type { WavResult } from './wav';

const SENSITIVITY_RATIO: Record<number, number> = { 1: 4.5, 2: 3.4, 3: 2.6, 4: 2.0, 5: 1.6 };
const SENSITIVITY_MIN_RMS: Record<number, number> = { 1: 0.03, 2: 0.02, 3: 0.012, 4: 0.008, 5: 0.005 };

/** Levenshtein distance, used to tolerate transcription slips in the wake word ("javis" for "jarvis"). */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** Compare the start of an utterance with the wake word, tolerant to accents, case, punctuation and small slips. */
export function matchWakeWord(text: string, wakeWord: string): { matched: boolean; rest: string } {
  const norm = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const target = norm(wakeWord).split(/[\s\p{P}]+/u).filter(Boolean);
  if (target.length === 0) return { matched: true, rest: text.trim() };
  const original = text.trim().replace(/^[\s\p{P}]+/u, '');
  const words = original.split(/\s+/);
  const head = words.slice(0, target.length).map((w) => norm(w).replace(/[\p{P}]+/gu, ''));
  if (head.length < target.length) return { matched: false, rest: '' };
  const joinedHead = head.join(' ');
  const joinedTarget = target.join(' ');
  const tolerance = joinedTarget.length >= 6 ? 2 : joinedTarget.length >= 4 ? 1 : 0;
  if (editDistance(joinedHead, joinedTarget) > tolerance) return { matched: false, rest: '' };
  const rest = words.slice(target.length).join(' ').replace(/^[\s\p{P}]+/u, '');
  return { matched: true, rest };
}

class VoiceController {
  private capture = new MicCapture();
  /** After a bare wake word, the next utterance is accepted without the wake word. */
  private attentionUntil = 0;
  private browser = new BrowserRecognizer();
  private handsFreeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private startSeq = 0;
  private unsubscribeVoice: (() => void) | null = null;

  init(): void {
    void listMicrophones().then((devices) => useVoice.getState().setMicDevices(devices));
    // Hands-free: re-arm the microphone once the assistant stops speaking.
    this.unsubscribeVoice = useVoice.subscribe((state, prev) => {
      if (prev.tts !== 'idle' && state.tts === 'idle' && state.handsFree && state.phase === 'off') {
        this.scheduleHandsFree(350);
      }
    });
    // Hands-free also re-arms when a reply ends without speech (voice off, empty answer, error).
    useChat.subscribe((state, prev) => {
      if (prev.isSending && !state.isSending) {
        const v = useVoice.getState();
        if (v.handsFree && v.phase === 'off' && !speech.isSpeaking()) this.scheduleHandsFree(400);
      }
    });
  }

  dispose(): void {
    this.unsubscribeVoice?.();
    this.stop();
  }

  get isListening(): boolean {
    return useVoice.getState().phase !== 'off';
  }

  toggle(): void {
    if (this.isListening) this.stop();
    else void this.start();
  }

  setHandsFree(on: boolean): void {
    useVoice.getState().setHandsFree(on);
    useSettings.getState().update({ voice: { handsFree: on } });
    if (on && !this.isListening && !speech.isSpeaking()) void this.start();
    if (!on) {
      this.clearHandsFreeTimer();
      if (this.isListening) this.cancel();
    }
  }

  private scheduleHandsFree(delay: number): void {
    this.clearHandsFreeTimer();
    this.handsFreeTimer = setTimeout(() => {
      const v = useVoice.getState();
      const bargeIn = useSettings.getState().settings.voice.bargeIn;
      if (v.handsFree && v.phase === 'off' && !useChat.getState().isSending && (bargeIn || !speech.isSpeaking())) void this.start(true);
    }, delay);
  }

  private clearHandsFreeTimer(): void {
    if (this.handsFreeTimer) clearTimeout(this.handsFreeTimer);
    this.handsFreeTimer = null;
  }

  /** @param auto true when re-armed by the hands-free loop (no chime, patient timeout). */
  async start(auto = false): Promise<void> {
    const voice = useVoice.getState();
    if (voice.phase !== 'off') return;
    const settings = useSettings.getState().settings.voice;
    const seq = ++this.startSeq;
    voice.setError(null);
    voice.setInterim('');
    // Barge-in keeps the assistant talking while the mic opens (echo cancellation handles the overlap).
    if (!(auto && settings.bargeIn)) speech.stop();
    useChat.getState().setHud('listening');
    voice.setPhase('arming');

    if (settings.provider === 'browser') {
      this.startBrowser(settings.language);
      return;
    }

    const sensitivity = Math.min(5, Math.max(1, Math.round(settings.sensitivity))) as 1 | 2 | 3 | 4 | 5;
    try {
      await audioBus.resume();
      await this.capture.start({
        deviceId: settings.micDeviceId || undefined,
        mode: settings.captureMode,
        vad: {
          silenceMs: settings.silenceMs,
          speechRatio: SENSITIVITY_RATIO[sensitivity],
          minRms: SENSITIVITY_MIN_RMS[sensitivity],
          noSpeechTimeoutMs: useVoice.getState().handsFree ? Number.POSITIVE_INFINITY : 9_000
        },
        callbacks: {
          onLevel: (level) => {
            const q = Math.round(level * 20) / 20;
            if (q !== useVoice.getState().inputLevel) useVoice.getState().setInputLevel(q);
          },
          onSpeechStart: () => {
            useVoice.getState().setPhase('speech');
            useChat.getState().ping();
          },
          onUtterance: (wav) => void this.transcribe(wav),
          onEnd: (reason) => this.onCaptureEnd(reason),
          onError: (message) => useVoice.getState().setError(message)
        }
      });
      if (seq !== this.startSeq || useVoice.getState().phase !== 'arming') {
        // stop() was called while the microphone was opening.
        this.capture.cancel();
        return;
      }
      useVoice.getState().setPhase('listening');
      if (!auto) this.playChime(true);
    } catch (err) {
      const message = (err as Error).message;
      useVoice.getState().setError(message);
      useVoice.getState().setPhase('off');
      useChat.getState().setHud('error');
      useChat.getState().setError(message);
      Log.error('voice', message);
      setTimeout(() => useChat.getState().setHud('idle'), 2500);
    }
  }

  private startBrowser(lang: string): void {
    useVoice.getState().setPhase('listening');
    this.browser.start(
      lang,
      (text) => {
        useVoice.getState().setTranscript(text);
        if (text.trim()) void sendMessage(text, [], 'voice');
      },
      (message) => {
        useVoice.getState().setError(message);
        useChat.getState().setError(message);
      },
      () => this.onCaptureEnd('stopped')
    );
  }

  stop(): void {
    this.stopping = true;
    this.startSeq++;
    this.clearHandsFreeTimer();
    if (useSettings.getState().settings.voice.provider === 'browser') this.browser.stop();
    else if (this.capture.isActive) this.capture.stop('stopped');
    else this.onCaptureEnd('stopped');
    this.stopping = false;
  }

  cancel(): void {
    this.startSeq++;
    this.clearHandsFreeTimer();
    this.browser.stop();
    this.capture.cancel();
  }

  private onCaptureEnd(reason: string): void {
    const voice = useVoice.getState();
    voice.setInputLevel(0);
    if (voice.phase !== 'transcribing') voice.setPhase('off');
    const chat = useChat.getState();
    if (chat.hud === 'listening') chat.setHud(chat.isSending ? 'thinking' : 'idle');
    if (reason === 'no-speech') {
      if (voice.handsFree && !this.stopping) this.scheduleHandsFree(400);
      else voice.setError("Aucune parole détectée.");
    } else if (reason === 'too-short') {
      if (voice.handsFree && !this.stopping) this.scheduleHandsFree(200);
    }
  }

  private async transcribe(wav: WavResult): Promise<void> {
    const voice = useVoice.getState();
    voice.setPhase('transcribing');
    useChat.getState().setHud('thinking');
    this.playChime(false);
    const settings = useSettings.getState().settings.voice;
    try {
      let text = await transcribeWav(wav.bytes, settings);
      voice.setTranscript(text);
      voice.setPhase('off');
      Log.info('voice', `transcript (${wav.durationSec.toFixed(1)}s): ${text}`);
      if (voice.handsFree && settings.wakeWordEnabled && Date.now() > this.attentionUntil) {
        const { matched, rest } = matchWakeWord(text, settings.wakeWord || 'jarvis');
        if (!matched) {
          Log.debug('voice', 'utterance ignored: no wake word');
          voice.setTranscript('');
          useChat.getState().setHud('idle');
          this.scheduleHandsFree(200);
          return;
        }
        if (!rest.trim()) {
          this.attentionUntil = Date.now() + 10_000;
          useChat.getState().setHud('listening');
          speech.say('Oui ?');
          return;
        }
        text = rest;
      }
      this.attentionUntil = 0;
      if (text.trim()) {
        await sendMessage(text, [], 'voice');
        if (useVoice.getState().handsFree && !speech.isSpeaking()) this.scheduleHandsFree(350);
      } else {
        voice.setError('Transcription vide.');
        useChat.getState().setHud('idle');
        if (voice.handsFree) this.scheduleHandsFree(300);
      }
    } catch (err) {
      const message = (err as Error).message;
      voice.setError(message);
      voice.setPhase('off');
      useChat.getState().setError(message);
      useChat.getState().setHud('error');
      Log.error('voice', `transcription failed: ${message}`);
      setTimeout(() => useChat.getState().setHud('idle'), 3000);
      if (useVoice.getState().handsFree) this.scheduleHandsFree(3000);
    }
  }

  private playChime(up: boolean): void {
    if (!useSettings.getState().settings.voice.wakeChime) return;
    try {
      const ctx = audioBus.context;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const now = ctx.currentTime;
      osc.frequency.setValueAtTime(up ? 660 : 880, now);
      osc.frequency.exponentialRampToValueAtTime(up ? 990 : 550, now + 0.12);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
      osc.connect(gain);
      gain.connect(audioBus.output);
      osc.start(now);
      osc.stop(now + 0.18);
    } catch {
      /* audio unavailable */
    }
  }
}

export const voiceController = new VoiceController();
