import { Minus, X, Settings, PictureInPicture2, RefreshCw, Webhook } from 'lucide-react';
import { bridge } from '../../lib/bridge';
import { useClock } from '../../hooks/useMetrics';
import { useHermes } from '../../state/hermes';
import { useSettings } from '../../state/settings';

interface Props {
  onOpenSettings: () => void;
}

export function TopBar({ onOpenSettings }: Props) {
  const now = useClock();
  const link = useHermes((s) => s.link);
  const linkDetail = useHermes((s) => s.linkDetail);
  const transport = useHermes((s) => s.transport);
  const capabilities = useHermes((s) => s.capabilities);
  const webhook = useHermes((s) => s.webhook);
  const connect = useHermes((s) => s.connect);
  const hermesUrl = useSettings((s) => s.settings.hermes.url);
  const model = useSettings((s) => s.settings.hermes.model);
  const api = bridge();

  const host = (() => {
    try {
      return new URL(hermesUrl).host;
    } catch {
      return hermesUrl || '—';
    }
  })();
  const linkLabel = link === 'online' ? 'HERMES LINK' : link === 'checking' ? 'CONNEXION' : link === 'degraded' ? 'DÉGRADÉ' : link === 'offline' ? 'HORS LIGNE' : 'HERMES';

  return (
    <header className="topbar">
      <div className="brand">
        <span className="core-dot" />
        EVEFLOW
        <small>v2</small>
      </div>
      <div className="status-strip">
        <span className={`chip ${link}`} title={linkDetail || host}>
          <span className="dot" /> {linkLabel} · {host}
        </span>
        {link === 'online' && (
          <span className="chip accent" title="Transport de conversation">
            {transport}
          </span>
        )}
        {(model || capabilities?.model) && <span className="chip" title="Modèle">{model || String(capabilities?.model)}</span>}
        {webhook && (
          <span className={`chip ${webhook.listening ? 'online' : 'offline'}`} title={webhook.error ?? `POST ${webhook.path}`}>
            <Webhook size={11} /> :{webhook.port}
          </span>
        )}
        <button className="icon-btn" title="Reconnecter Hermes" onClick={() => void connect()}>
          <RefreshCw size={14} className={link === 'checking' ? 'spin' : undefined} />
        </button>
      </div>
      <span className="clock">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
      <div className="controls">
        <button className="icon-btn" title="Paramètres" onClick={onOpenSettings}><Settings size={16} /></button>
        {api && (
          <>
            <button className="icon-btn" title="Mode compact flottant" onClick={() => api.window.setMode('compact')}><PictureInPicture2 size={16} /></button>
            <button className="icon-btn" title="Réduire" onClick={() => api.window.control('minimize')}><Minus size={16} /></button>
            <button className="icon-btn close" title="Fermer" onClick={() => api.window.control('close')}><X size={16} /></button>
          </>
        )}
      </div>
    </header>
  );
}
