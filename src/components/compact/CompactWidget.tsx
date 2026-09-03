import { Maximize2, X, Minus, Moon, Crosshair } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { bridge } from '../../lib/bridge';
import { useSettings } from '../../state/settings';
import { useChat } from '../../state/chat';
import { useVoice } from '../../state/voice';
import { CoreStage } from '../hud/CoreStage';
import { ChatPanel } from '../chat/ChatPanel';

const STATE_LABEL: Record<string, string> = {
  idle: 'veille',
  listening: 'écoute',
  thinking: 'réflexion',
  speaking: 'parle',
  alert: 'alerte',
  error: 'erreur',
  success: 'terminé'
};

/** Compact mode: a glanceable strip (state, unread, last sentence) above the mini chat. */
export function CompactWidget() {
  const assistantName = useSettings((s) => s.settings.assistantName);
  const compactOpacity = useSettings((s) => s.settings.ui.compactOpacity);
  const { hud, hudOverride, unread, missionMode, quiet, last } = useChat(
    useShallow((s) => {
      const lastAssistant = [...s.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
      return { hud: s.hud, hudOverride: s.hudOverride, unread: s.unread, missionMode: s.missionMode, quiet: s.quiet, last: lastAssistant?.content ?? '' };
    })
  );
  const wake = useVoice((s) => s.wake);
  const api = bridge();
  const state = hudOverride ?? hud;
  const label = state === 'idle' && wake === 'spotting' ? 'à l’écoute du mot-clé' : STATE_LABEL[state] ?? state;
  const sentence = last.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_>`|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return (
    <div className="compact-root" style={{ ['--compact-opacity' as string]: compactOpacity }}>
      <div className="compact-head">
        <span className="title">{assistantName}</span>
        {api && (
          <>
            <button className="icon-btn" title="Mode HUD complet" onClick={() => api.window.setMode('hud')}><Maximize2 size={14} /></button>
            <button className="icon-btn" title="Masquer (Ctrl+Shift+J)" onClick={() => api.window.control('hide')}><Minus size={14} /></button>
            <button className="icon-btn close" title="Fermer" onClick={() => api.window.control('close')}><X size={14} /></button>
          </>
        )}
      </div>
      <CoreStage compact />
      <div className="compact-glance" onClick={() => useChat.getState().markRead()} title={sentence}>
        <span className={`state${state === 'alert' || state === 'error' ? ' alert' : ''}`}>{label}</span>
        <span className="last">{sentence || 'Aucun message pour l’instant.'}</span>
        <span className="badges">
          {missionMode && <Crosshair size={12} className="mission" aria-label="mode mission" />}
          {quiet && <Moon size={12} aria-label="heures calmes" />}
          {unread > 0 && <span className="unread" aria-label={`${unread} non lus`}>{unread}</span>}
        </span>
      </div>
      <div className="compact-body">
        <ChatPanel compact />
      </div>
    </div>
  );
}
