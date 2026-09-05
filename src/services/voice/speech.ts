/**
 * Singleton facade over the TTS engine bound to the settings store, exposing speaking state
 * to the voice and chat stores. Long replies are spoken as a digest (first sentences plus the
 * closing question) so listening stays short while the full text remains on screen.
 */
import { useChat } from '../../state/chat';
import { useSettings } from '../../state/settings';
import { useVoice } from '../../state/voice';
import { chunkForSpeech, closingQuestion, extractSentences, spokenDigest } from '../../lib/text';
import { TtsEngine } from './tts';

export const DIGEST_NOTICE = 'Le détail complet est affiché à l’écran.';

class SpeechFacade {
  private engine: TtsEngine | null = null;
  private streaming = false;
  private streamEnabled = true;
  private streamBuffer = '';
  private spokenCount = 0;
  private truncated = false;

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

  /** Number of spoken chunks allowed for one reply; unbounded when the digest is off. */
  private replyLimit(): number {
    const { summarizeReplies, replySentences } = useSettings.getState().settings.speech;
    return summarizeReplies ? Math.max(1, Math.floor(replySentences || 1)) : Number.POSITIVE_INFINITY;
  }

  say(text: string, options: { interrupt?: boolean } = {}): void {
    if (useSettings.getState().settings.speech.provider === 'off') return;
    // While an answer streams, spoken notices are inserted without discarding the rest.
    this.tts.speak(text, { interrupt: options.interrupt ?? !this.streaming });
  }

  /** Speak a finished (non-streamed) assistant reply, digested when it is long. */
  sayReply(text: string): void {
    const limit = this.replyLimit();
    if (!Number.isFinite(limit)) return this.say(text);
    const digest = spokenDigest(text, limit);
    this.say(digest.truncated ? `${digest.text} ${DIGEST_NOTICE}` : digest.text);
  }

  pushStream(delta: string): void {
    if (!useSettings.getState().settings.speech.autoSpeak) return;
    this.streaming = true;
    if (!this.streamEnabled) return;
    this.streamBuffer += delta;
    const { sentences, rest } = extractSentences(this.streamBuffer);
    this.streamBuffer = rest;
    for (const sentence of sentences) this.enqueueWithinLimit(sentence);
  }

  private enqueueWithinLimit(text: string): void {
    if (this.truncated) return;
    if (this.spokenCount >= this.replyLimit()) {
      this.truncated = true;
      return;
    }
    if (this.tts.enqueue(text)) this.spokenCount++;
  }

  /** Flush a streamed reply; `fullText` lets a digested reply end with its closing question. */
  endStream(fullText = ''): void {
    if (!this.streaming) return;
    const rest = this.streamBuffer.trim();
    if (rest) for (const chunk of chunkForSpeech(rest)) this.enqueueWithinLimit(chunk);
    if (this.truncated) {
      const question = closingQuestion(fullText);
      if (question) this.tts.enqueue(question);
      this.tts.enqueue(DIGEST_NOTICE);
    }
    this.resetStream();
  }

  discardStream(): void {
    this.resetStream();
    this.tts.stop();
  }

  stop(): void {
    this.resetStream();
    this.engine?.stop();
  }

  private resetStream(): void {
    this.streaming = false;
    this.streamBuffer = '';
    this.spokenCount = 0;
    this.truncated = false;
  }
}

export const speech = new SpeechFacade();
