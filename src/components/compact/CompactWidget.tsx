import { Maximize2, X, Minus } from 'lucide-react';
import { bridge } from '../../lib/bridge';
import { useSettings } from '../../state/settings';
import { CoreStage } from '../hud/CoreStage';
import { ChatPanel } from '../chat/ChatPanel';

export function CompactWidget() {
  const assistantName = useSettings((s) => s.settings.assistantName);
  const compactOpacity = useSettings((s) => s.settings.ui.compactOpacity);
  const api = bridge();
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
      <div className="compact-body">
        <ChatPanel compact />
      </div>
    </div>
  );
}
