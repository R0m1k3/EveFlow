import { useState } from 'react';
import { ShieldAlert, HelpCircle, KeyRound } from 'lucide-react';
import { resolvePending } from '../../services/conversation';
import { useChat, type PendingRequest } from '../../state/chat';

function RequestCard({ request }: { request: PendingRequest }) {
  const [answer, setAnswer] = useState('');
  const icon = request.kind === 'approval' ? <ShieldAlert size={16} /> : request.kind === 'clarify' ? <HelpCircle size={16} /> : <KeyRound size={16} />;

  return (
    <div className="modal">
      <div className="request-card">
        <div className="title">
          {icon}
          {request.title}
          {request.tool && <span className="chip warn">{request.tool}</span>}
        </div>
        <div className="desc">{request.description}</div>
        {request.args && <pre>{request.args}</pre>}
        {request.kind === 'approval' ? (
          <div className="actions">
            <button className="btn danger" onClick={() => void resolvePending(request, 'deny')}>Refuser</button>
            <button className="btn" onClick={() => void resolvePending(request, 'once')}>Autoriser une fois</button>
            <button className="btn" onClick={() => void resolvePending(request, 'session')}>Pour la session</button>
            <button className="btn primary" onClick={() => void resolvePending(request, 'always')}>Toujours</button>
          </div>
        ) : (
          <>
            {request.options && request.options.length > 0 && (
              <div className="actions" style={{ justifyContent: 'flex-start' }}>
                {request.options.map((opt) => (
                  <button key={opt} className="btn small" onClick={() => void resolvePending(request, opt)}>{opt}</button>
                ))}
              </div>
            )}
            <input
              className="input"
              type={request.secret ? 'password' : 'text'}
              placeholder={request.secret ? 'Saisie confidentielle' : 'Votre réponse…'}
              value={answer}
              autoFocus
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && answer.trim()) void resolvePending(request, answer.trim());
              }}
            />
            <div className="actions">
              <button className="btn ghost" onClick={() => useChat.getState().removePending(request.id)}>Ignorer</button>
              <button className="btn primary" disabled={!answer.trim()} onClick={() => void resolvePending(request, answer.trim())}>Envoyer</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function PendingRequests() {
  const pending = useChat((s) => s.pending);
  if (pending.length === 0) return null;
  return (
    <div className="overlay">
      <RequestCard key={pending[0].id} request={pending[0]} />
    </div>
  );
}
