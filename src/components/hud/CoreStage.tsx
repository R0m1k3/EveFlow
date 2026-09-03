import { useEffect, useState } from 'react';
import { useChat } from '../../state/chat';
import { useHermes } from '../../state/hermes';
import { useSettings } from '../../state/settings';
import { useVoice } from '../../state/voice';
import { previewText } from '../../lib/text';
import { JarvisCore } from './JarvisCore';

const STATE_LABEL: Record<string, string> = {
  idle: 'En veille',
  listening: 'À l’écoute',
  thinking: 'Analyse',
  speaking: 'Transmission',
  alert: 'Attention',
  error: 'Anomalie',
  success: 'Terminé'
};

interface Props {
  compact?: boolean;
}

export function CoreStage({ compact }: Props) {
  const hud = useChat((s) => s.hudOverride ?? s.hud);
  const running = useChat((s) => {
    for (let i = s.activity.length - 1; i >= 0; i--) if (s.activity[i].status === 'running') return s.activity[i];
    return undefined;
  });
  const isSending = useChat((s) => s.isSending);
  const error = useChat((s) => s.error);
  const pulse = useChat((s) => s.pingCount);
  const latencyMs = useChat((s) => s.latencyMs);
  const phase = useVoice((s) => s.phase);
  const level = useVoice((s) => s.inputLevel);
  const transcript = useVoice((s) => s.lastTranscript);
  const interim = useVoice((s) => s.interim);
  const voiceError = useVoice((s) => s.error);
  const wake = useVoice((s) => s.wake);
  const wakeKeywords = useVoice((s) => s.wakeKeywords);
  const assistantName = useSettings((s) => s.settings.assistantName);
  const reduceMotion = useSettings((s) => s.settings.ui.reduceMotion);
  const transport = useHermes((s) => s.transport);
  const link = useHermes((s) => s.link);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isSending) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 250);
    return () => clearInterval(timer);
  }, [isSending]);

  let sub = '';
  if (hud === 'listening') sub = phase === 'speech' ? 'parole détectée…' : phase === 'transcribing' ? 'transcription…' : 'parlez maintenant';
  else if (hud === 'thinking') sub = running ? `${running.name}${running.detail ? ` · ${previewText(running.detail, 60)}` : ''}` : isSending ? `Hermes · ${transport} · ${(elapsed / 1000).toFixed(1)} s` : '';
  else if (hud === 'error') sub = previewText(error ?? voiceError ?? 'erreur', 90);
  else if (hud === 'speaking') sub = 'synthèse vocale';
  else if (transcript) sub = `« ${previewText(transcript, 80)} »`;
  else if (wake === 'spotting') sub = `dites « ${wakeKeywords[0] ?? 'jarvis'} »${link === 'online' ? ` · ${transport}` : link === 'offline' ? ' · Hermes hors ligne' : ''}`;
  else sub = link === 'online' ? `liaison Hermes · ${transport}` : link === 'offline' ? 'Hermes hors ligne' : '';

  return (
    <div className={compact ? 'compact-core' : 'core-stage'}>
      {!compact && (
        <div className="core-name">
          {assistantName}
          <small>EVEFLOW · HERMES INTERFACE</small>
        </div>
      )}
      <div className={compact ? undefined : 'core-canvas-wrap'} style={compact ? { position: 'absolute', inset: '0 0 36px 0' } : undefined}>
        <JarvisCore state={hud} inputLevel={level} reduceMotion={reduceMotion} pulse={pulse} />
      </div>
      <div className="core-caption" aria-live="polite">
        {!compact && (phase === 'speech' || phase === 'transcribing') && <div className="core-interim">{interim || (phase === 'transcribing' ? '…' : '')}</div>}
        <div className={`core-state ${hud}`}>{STATE_LABEL[hud] ?? hud}</div>
        {sub && <div className="core-sub">{sub}</div>}
        {!compact && latencyMs !== null && <div className="core-latency">premier mot · {latencyMs} ms</div>}
      </div>
    </div>
  );
}
