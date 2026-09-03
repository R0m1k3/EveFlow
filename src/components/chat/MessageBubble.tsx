import { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Volume2, Check } from 'lucide-react';
import { bridge } from '../../lib/bridge';
import { formatTime, preprocessMedia } from '../../lib/text';
import { speech } from '../../services/voice/speech';
import type { ChatMessage } from '../../state/chat';
import { ResilientImage } from './ResilientImage';

interface Props {
  message: ChatMessage;
  assistantName: string;
  userName: string;
  showReasoning: boolean;
  compact?: boolean;
  onOpenImage?: (src: string) => void;
}

function openLink(href: string): void {
  const api = bridge();
  if (/^(file:\/\/|[a-zA-Z]:[\\/])/.test(href) && api) {
    api.files.openPath(href).catch(() => undefined);
    return;
  }
  window.open(href, '_blank', 'noopener');
}

export const MessageBubble = memo(function MessageBubble({ message, assistantName, userName, showReasoning, compact, onOpenImage }: Props) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
  }, []);
  const isUser = message.role === 'user';
  const who = isUser ? userName || 'VOUS' : message.role === 'system' ? 'SYSTÈME' : assistantName;
  const status = message.status ?? 'done';

  const copy = () => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => undefined);
  };

  return (
    <div className={`msg ${message.role}`}>
      {!compact && (
        <div className="msg-meta">
          <span className="who">{who}</span>
          <span>{formatTime(message.timestamp)}</span>
          {message.source && message.source !== 'eveflow' && <span className={`src ${message.source}`}>{message.jobName ? `cron · ${message.jobName}` : message.source}</span>}
          {message.transport && message.role === 'assistant' && <span className="src">{message.transport}</span>}
          {message.usage?.total_tokens ? <span>{message.usage.total_tokens} tok</span> : null}
          {message.role === 'assistant' && status === 'done' && (
            <span className="msg-actions">
              <button className="icon-btn" title="Copier" aria-label="Copier le message" onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
              <button className="icon-btn" title="Lire à voix haute" aria-label="Lire à voix haute" onClick={() => speech.say(message.content)}><Volume2 size={13} /></button>
            </span>
          )}
        </div>
      )}
      <div className={`bubble ${status}`}>
        {message.images && message.images.length > 0 && (
          <div className="msg-images">
            {message.images.map((img, i) => (
              <ResilientImage key={i} src={img} alt={`image ${i + 1}`} onOpen={onOpenImage} />
            ))}
          </div>
        )}
        {showReasoning && message.reasoning && (
          <details className="reasoning">
            <summary>raisonnement</summary>
            {message.reasoning}
          </details>
        )}
        {message.role === 'user' ? (
          <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>
        ) : (
          <div className="md">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: ({ src, alt }) => <ResilientImage src={typeof src === 'string' ? src : ''} alt={alt} onOpen={onOpenImage} />,
                a: ({ href, children }) => (
                  <a
                    href={href}
                    onClick={(e) => {
                      e.preventDefault();
                      if (href) openLink(href);
                    }}
                  >
                    {children}
                  </a>
                )
              }}
            >
              {preprocessMedia(message.content) || (status === 'streaming' ? '' : '…')}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
});
