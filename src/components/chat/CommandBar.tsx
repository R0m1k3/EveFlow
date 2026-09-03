import { useEffect, useRef, useState } from 'react';
import { Mic, Paperclip, Send, Square, X, Radio, Loader2, Volume2, VolumeX, Navigation } from 'lucide-react';
import { sendMessage, steer, stopGeneration } from '../../services/conversation';
import { speech } from '../../services/voice/speech';
import { voiceController } from '../../services/voice/voiceController';
import { useChat } from '../../state/chat';
import { useSettings } from '../../state/settings';
import { useVoice } from '../../state/voice';

interface Props {
  compact?: boolean;
}

const MAX_IMAGE_EDGE = 1280;

async function fileToDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml' || file.type === 'image/gif') return raw;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
      if (scale === 1 && file.size < 900_000) return resolve(raw);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve(raw);
    img.src = raw;
  });
}

export function CommandBar({ compact }: Props) {
  const draft = useChat((s) => s.draft);
  const setDraft = useChat((s) => s.setDraft);
  const isSending = useChat((s) => s.isSending);
  const currentRunId = useChat((s) => s.currentRunId);
  const phase = useVoice((s) => s.phase);
  const level = useVoice((s) => s.inputLevel);
  const handsFree = useVoice((s) => s.handsFree);
  const ttsState = useVoice((s) => s.tts);
  const speechProvider = useSettings((s) => s.settings.speech.provider);
  const autoSpeak = useSettings((s) => s.settings.speech.autoSpeak);
  const update = useSettings((s) => s.update);
  const [images, setImages] = useState<string[]>([]);
  const [steerMode, setSteerMode] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [draft]);

  useEffect(() => {
    if (!isSending) setSteerMode(false);
  }, [isSending]);

  const submit = async () => {
    const text = draft.trim();
    if (steerMode && currentRunId) {
      if (await steer(text)) setDraft('');
      return;
    }
    if (!text && images.length === 0) return;
    const attached = images;
    setDraft('');
    setImages([]);
    await sendMessage(text, attached);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
    if (e.key === 'Escape' && isSending) stopGeneration();
  };

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const next: string[] = [];
    for (const file of Array.from(files).slice(0, 4)) {
      if (!file.type.startsWith('image/')) continue;
      if (file.size > 12 * 1024 * 1024) continue;
      next.push(await fileToDataUrl(file));
    }
    setImages((prev) => [...prev, ...next].slice(0, 4));
    if (fileRef.current) fileRef.current.value = '';
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith('image/'));
    if (items.length === 0) return;
    const list = new DataTransfer();
    for (const item of items) {
      const f = item.getAsFile();
      if (f) list.items.add(f);
    }
    void onFiles(list.files);
  };

  const listening = phase !== 'off';
  const micClass = phase === 'speech' ? 'speech' : phase === 'transcribing' ? 'transcribing' : listening ? 'listening' : '';
  const micTitle = phase === 'transcribing' ? 'Transcription…' : listening ? 'Arrêter l’écoute' : 'Parler (Ctrl+Shift+Espace)';
  const placeholder = steerMode ? 'Consigne à injecter dans le run en cours…' : compact ? 'Message…' : 'Commande, question ou mission pour Hermes…';

  return (
    <div className="command-bar">
      {images.length > 0 && (
        <div className="attachments">
          {images.map((img, i) => (
            <div key={i} className="attachment">
              <img src={img} alt="" />
              <button onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} title="Retirer"><X size={11} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="command-row">
        <button
          className={`mic-btn ${micClass}`}
          style={{ ['--level' as string]: level }}
          title={micTitle}
          onClick={() => voiceController.toggle()}
          disabled={phase === 'transcribing'}
        >
          {phase === 'transcribing' ? <Loader2 size={20} className="spin" /> : listening ? <Square size={18} /> : <Mic size={20} />}
        </button>
        <textarea
          ref={inputRef}
          className={`command-input${steerMode ? ' steer' : ''}`}
          rows={1}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          spellCheck={false}
        />
        {!compact && (
          <button className="icon-btn" title="Joindre une image" onClick={() => fileRef.current?.click()} style={{ height: 46, width: 40 }}>
            <Paperclip size={18} />
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
        {isSending && !steerMode ? (
          <button className="send-btn stop" title="Interrompre (Échap)" onClick={stopGeneration}>
            <Square size={18} />
          </button>
        ) : (
          <button className="send-btn primary" title={steerMode ? 'Envoyer la consigne' : 'Envoyer (Entrée)'} onClick={() => void submit()} disabled={!draft.trim() && images.length === 0}>
            {steerMode ? <Navigation size={18} /> : <Send size={18} />}
          </button>
        )}
      </div>
      {!compact && (
        <div className="command-foot">
          <button className={`toggle-btn${handsFree ? ' on' : ''}`} onClick={() => voiceController.setHandsFree(!handsFree)} title="Écoute continue : le micro se réactive après chaque réponse">
            <Radio size={12} /> mains libres
          </button>
          <button className={`toggle-btn${autoSpeak && speechProvider !== 'off' ? ' on' : ''}`} onClick={() => update({ speech: { autoSpeak: !autoSpeak } })} title="Lire les réponses à voix haute">
            {autoSpeak && speechProvider !== 'off' ? <Volume2 size={12} /> : <VolumeX size={12} />} voix
          </button>
          {ttsState !== 'idle' && (
            <button className="toggle-btn on" onClick={() => speech.stop()} title="Couper la voix">
              <Square size={10} /> {ttsState === 'loading' ? 'synthèse…' : 'parle'}
            </button>
          )}
          {isSending && currentRunId && (
            <button className={`toggle-btn${steerMode ? ' on' : ''}`} onClick={() => setSteerMode((v) => !v)} title="Injecter une consigne dans le run en cours">
              <Navigation size={12} /> steer
            </button>
          )}
          <span className="spacer" />
          <span>{isSending ? 'Hermes travaille…' : listening ? (phase === 'speech' ? 'parole détectée' : 'écoute…') : 'Entrée ↵ envoyer · Shift+Entrée ligne'}</span>
        </div>
      )}
    </div>
  );
}
