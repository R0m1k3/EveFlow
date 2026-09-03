/**
 * Singleton facade over the TTS engine bound to the settings store, exposing speaking state
 * to the voice and chat stores.
 */
import { useChat } from '../../state/chat';
import { useSettings } from '../../state/settings';
import { useVoice } from '../../state/voice';
import { TtsEngine } from './tts';

class SpeechFacade {
  private engine: TtsEngine | null = null;
  private streaming = false;
  private streamEnabled = true;

  private get tts(): TtsEngine {
    if (!this.engine) {
      const settings = useSettings.getState().settings;
      this.engine = new TtsEngine(settings.speech);
      this.engine.onState((state) => {
        useVoice.getState().setTts(state);
        const chat = useChat.getState();
        if (state === 'speaking') chat.setHud('speaking');
        else if (state === 'idle' && chat.hud === 'speaking') chat.setHud(chat.isSending ? 'thinking' : 'idle');
      });
      useSettings.subscribe((s) => this.engine?.updateConfig(s.settings.speech));
    }
    return this.engine;
  }

  init(): void {
    this.tts;
  }

  isSpeaking(): boolean {
    return this.engine?.isActive ?? false;
  }

  say(text: string, options: { interrupt?: boolean } = {}): void {
    if (useSettings.getState().settings.speech.provider === 'off') return;
    // While an answer streams, spoken notices are inserted without discarding the rest.
    this.tts.speak(text, { interrupt: options.interrupt ?? !this.streaming });
  }

  pushStream(delta: string): void {
    if (!useSettings.getState().settings.speech.autoSpeak) return;
    this.streaming = true;
    if (this.streamEnabled) this.tts.pushStream(delta);
  }

  endStream(): void {
    if (this.streaming) this.tts.endStream();
    this.streaming = false;
  }

  discardStream(): void {
    this.streaming = false;
    this.tts.stop();
  }

  stop(): void {
    this.streaming = false;
    this.engine?.stop();
  }
}

export const speech = new SpeechFacade();
