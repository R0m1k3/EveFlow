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

class VoiceController {
  private capture = new MicCapture();
  private browser = new BrowserRecognizer();
  private handsFreeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private unsubscribeVoice: (() => void) | null = null;

  init(): void {
    void listMicrophones().then((devices) => useVoice.getState().setMicDevices(devices));
    // Hands-free: re-arm the microphone once the assistant stops speaking.
    this.unsubscribeVoice = useVoice.subscribe((state, prev) => {
      if (prev.tts !== 'idle' && state.tts === 'idle' && state.handsFree && state.phase === 'off') {
        this.scheduleHandsFree(350);
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
    }
  }

  private scheduleHandsFree(delay: number): void {
    this.clearHandsFreeTimer();
    this.handsFreeTimer = setTimeout(() => {
      const v = useVoice.getState();
      if (v.handsFree && v.phase === 'off' && !useChat.getState().isSending && !speech.isSpeaking()) void this.start();
    }, delay);
  }

  private clearHandsFreeTimer(): void {
    if (this.handsFreeTimer) clearTimeout(this.handsFreeTimer);
    this.handsFreeTimer = null;
  }

  async start(): Promise<void> {
    const voice = useVoice.getState();
    if (voice.phase !== 'off') return;
    const settings = useSettings.getState().settings.voice;
    voice.setError(null);
    voice.setInterim('');
    if (!settings.bargeIn) speech.stop();
    else speech.stop();
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
          noSpeechTimeoutMs: useVoice.getState().handsFree ? 20_000 : 9_000
        },
        callbacks: {
          onLevel: (level) => useVoice.getState().setInputLevel(level),
          onSpeechStart: () => useVoice.getState().setPhase('speech'),
          onUtterance: (wav) => void this.transcribe(wav),
          onEnd: (reason) => this.onCaptureEnd(reason),
          onError: (message) => useVoice.getState().setError(message)
        }
      });
      useVoice.getState().setPhase('listening');
      this.playChime(true);
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
    this.clearHandsFreeTimer();
    if (useSettings.getState().settings.voice.provider === 'browser') this.browser.stop();
    else if (this.capture.isActive) this.capture.stop('stopped');
    else this.onCaptureEnd('stopped');
    this.stopping = false;
  }

  cancel(): void {
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
      const text = await transcribeWav(wav.bytes, settings);
      voice.setTranscript(text);
      voice.setPhase('off');
      Log.info('voice', `transcript (${wav.durationSec.toFixed(1)}s): ${text}`);
      if (text.trim()) {
        await sendMessage(text, [], 'voice');
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
