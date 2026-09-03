import { useEffect } from 'react';
import { Download, Trash2, X, CheckCircle2, Cpu, Mic, Volume2, AlertTriangle, RefreshCw } from 'lucide-react';
import type { VoiceModelStatus } from '../../../shared/voice';
import { bridge } from '../../lib/bridge';
import { useVoiceModels } from '../../state/voiceModels';
import { useSettings } from '../../state/settings';

function formatMb(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(2)} Go` : `${Math.round(bytes / 1024 / 1024)} Mo`;
}

function ModelRow({ model }: { model: VoiceModelStatus }) {
  const progress = useVoiceModels((s) => s.progress[model.id]);
  const { download, cancel, remove } = useVoiceModels();
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const isActive = model.kind === 'stt' ? settings.voice.localModel === model.id : settings.speech.localModel === model.id;
  const busy = !!progress && (progress.phase === 'download' || progress.phase === 'extract');

  const activate = () => {
    if (model.kind === 'stt') update({ voice: { localModel: model.id, provider: 'local' } });
    else update({ speech: { localModel: model.id, provider: 'local', localSpeaker: model.speakers?.[0]?.id ?? 0 } });
  };

  return (
    <div className="row-item" style={isActive && model.installed ? { borderColor: 'var(--accent)' } : undefined}>
      <div className="main">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="name">{model.name}</span>
          {model.recommended && <span className="status-pill ok">recommandé</span>}
          {model.installed && <span className="status-pill online">installé · {formatMb(model.installedBytes)}</span>}
          {!model.installed && !busy && <span className="status-pill">{model.sizeMb} Mo</span>}
          {isActive && model.installed && <span className="status-pill active">actif</span>}
        </div>
        <span className="desc">{model.description}</span>
        <span className="meta">langues : {model.languages.join(', ')}{model.speakers ? ` · ${model.speakers.length} voix` : ''}</span>
        {busy && (
          <div style={{ marginTop: 6 }}>
            <div className="level-meter"><div style={{ width: `${progress.percent}%` }} /></div>
            <span className="meta">{progress.phase === 'extract' ? 'extraction…' : `${progress.percent}% · ${formatMb(progress.received)} / ${formatMb(progress.total)}`}</span>
          </div>
        )}
        {progress?.phase === 'error' && <span className="meta" style={{ color: 'var(--danger)' }}>échec : {progress.message}</span>}
      </div>
      <div className="actions">
        {busy ? (
          <button className="icon-btn danger" title="Annuler" onClick={() => void cancel(model.id)}><X size={13} /></button>
        ) : model.installed ? (
          <>
            {!isActive && <button className="btn small" onClick={activate}>Utiliser</button>}
            <button className="icon-btn danger" title="Supprimer du disque" onClick={() => { if (confirm(`Supprimer « ${model.name} » ?`)) void remove(model.id); }}><Trash2 size={13} /></button>
          </>
        ) : (
          <button className="btn small primary" onClick={() => void download(model.id)}><Download size={13} /> Télécharger</button>
        )}
      </div>
    </div>
  );
}

export function ModelsSection() {
  const { models, engine, error, refresh, checkEngine } = useVoiceModels();
  useEffect(() => {
    void refresh();
    void checkEngine();
  }, [refresh, checkEngine]);

  if (!bridge()) return <div className="card"><div className="empty">Les modèles locaux ne sont disponibles que dans l’application Electron.</div></div>;

  const stt = models.filter((m) => m.kind === 'stt');
  const tts = models.filter((m) => m.kind === 'tts');
  return (
    <>
      <div className="card">
        <div className="section-title"><Cpu size={12} /> Moteur local (sherpa-onnx)</div>
        {engine === null ? (
          <span className="muted">vérification…</span>
        ) : engine.available ? (
          <div className="test-result ok"><CheckCircle2 size={13} /> moteur prêt · version {engine.version}{engine.loaded.length ? ` · chargé : ${engine.loaded.join(', ')}` : ''}</div>
        ) : (
          <div className="test-result fail"><AlertTriangle size={13} /> {engine.error}</div>
        )}
        <span className="hint" style={{ display: 'block', marginTop: 8 }}>
          Les modèles tournent sur le processeur, sans connexion, dans un processus séparé. Dossier : <code>{engine?.modelsDir}</code>
        </span>
        {error && <div className="test-result fail" style={{ marginTop: 8 }}><AlertTriangle size={13} /> {error}</div>}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn small ghost" onClick={() => { void refresh(); void checkEngine(); }}><RefreshCw size={13} /> Actualiser</button>
        </div>
      </div>
      <div className="card">
        <div className="section-title"><Mic size={12} /> Reconnaissance vocale</div>
        <div className="list">{stt.map((m) => <ModelRow key={m.id} model={m} />)}</div>
      </div>
      <div className="card">
        <div className="section-title"><Volume2 size={12} /> Synthèse vocale</div>
        <div className="list">{tts.map((m) => <ModelRow key={m.id} model={m} />)}</div>
      </div>
    </>
  );
}
