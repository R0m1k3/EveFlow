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
  const activity = useChat((s) => s.activity);
  const isSending = useChat((s) => s.isSending);
  const error = useChat((s) => s.error);
  const phase = useVoice((s) => s.phase);
  const level = useVoice((s) => s.inputLevel);
  const transcript = useVoice((s) => s.lastTranscript);
  const voiceError = useVoice((s) => s.error);
  const settings = useSettings((s) => s.settings);
  const transport = useHermes((s) => s.transport);
  const link = useHermes((s) => s.link);

  const running = activity.filter((a) => a.status === 'running').slice(-1)[0];
  let sub = '';
  if (hud === 'listening') sub = phase === 'speech' ? 'parole détectée…' : phase === 'transcribing' ? 'transcription…' : 'parlez maintenant';
  else if (hud === 'thinking') sub = running ? `${running.name}${running.detail ? ` · ${previewText(running.detail, 60)}` : ''}` : isSending ? `Hermes · ${transport}` : '';
  else if (hud === 'error') sub = previewText(error ?? voiceError ?? 'erreur', 90);
  else if (hud === 'speaking') sub = 'synthèse vocale';
  else if (transcript) sub = `« ${previewText(transcript, 80)} »`;
  else sub = link === 'online' ? `liaison Hermes · ${transport}` : link === 'offline' ? 'Hermes hors ligne' : '';

  return (
    <div className={compact ? 'compact-core' : 'core-stage'}>
      {!compact && (
        <div className="core-name">
          {settings.assistantName}
          <small>EVEFLOW · HERMES INTERFACE</small>
        </div>
      )}
      <div className={compact ? undefined : 'core-canvas-wrap'} style={compact ? { position: 'absolute', inset: '0 0 36px 0' } : undefined}>
        <JarvisCore state={hud} inputLevel={level} reduceMotion={settings.ui.reduceMotion} />
      </div>
      <div className="core-caption">
        <div className={`core-state ${hud}`}>{STATE_LABEL[hud] ?? hud}</div>
        {sub && <div className="core-sub">{sub}</div>}
      </div>
    </div>
  );
}
