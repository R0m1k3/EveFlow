import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Trash2, X } from 'lucide-react';
import { useChat } from '../../state/chat';
import { useSettings } from '../../state/settings';
import { MessageBubble } from './MessageBubble';
import { CommandBar } from './CommandBar';

interface Props {
  compact?: boolean;
}

export function ChatPanel({ compact }: Props) {
  const messages = useChat((s) => s.messages);
  const clear = useChat((s) => s.clear);
  const assistantName = useSettings((s) => s.settings.assistantName);
  const userName = useSettings((s) => s.settings.userName);
  const showReasoning = useSettings((s) => s.settings.ui.showReasoning);
  const listRef = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    if (!stick) return;
    const el = listRef.current;
    if (!el) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
  }, [messages, stick]);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  const onScroll = () => {
    if (programmatic.current) {
      programmatic.current = false;
      return;
    }
    const el = listRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const visible = compact ? messages.slice(-6) : messages;

  return (
    <section className={`panel bracket chat-panel${compact ? ' compact' : ''}`}>
      {!compact && (
        <header className="panel-head">
          <MessageSquare size={14} />
          <span>Transmission</span>
          <span className="spacer" />
          <span className="chip">{messages.length} msg</span>
          <button className="icon-btn" title="Effacer la conversation" onClick={clear} disabled={messages.length === 0}>
            <Trash2 size={14} />
          </button>
        </header>
      )}
      <div ref={listRef} className={`chat-list${compact ? ' compact' : ''}`} onScroll={onScroll}>
        {visible.length === 0 && (
          <div className="empty">
            {compact ? 'En attente…' : `Canal ouvert. Parlez ou écrivez à ${assistantName}.`}
            {!compact && (
              <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                <span className="kbd">Ctrl</span> + <span className="kbd">Shift</span> + <span className="kbd">Espace</span> active le micro depuis n’importe où.
              </div>
            )}
          </div>
        )}
        {visible.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            assistantName={assistantName}
            userName={userName}
            showReasoning={showReasoning}
            compact={compact}
            onOpenImage={setZoom}
          />
        ))}
      </div>
      <CommandBar compact={compact} />
      {zoom && (
        <div className="overlay" onClick={() => setZoom(null)}>
          <img src={zoom} alt="aperçu" style={{ maxWidth: '92%', maxHeight: '90%', borderRadius: 10, border: '1px solid var(--line-strong)' }} />
          <button className="icon-btn" style={{ position: 'absolute', top: 12, right: 12 }} onClick={() => setZoom(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </section>
  );
}
