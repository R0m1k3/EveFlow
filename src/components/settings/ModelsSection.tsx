import { useEffect } from 'react';
import { Download, Trash2, X, CheckCircle2, Cpu, Mic, Volume2, AlertTriangle, RefreshCw, Ear, Activity } from 'lucide-react';
import type { VoiceModelStatus } from '../../../shared/voice';
import { bridge } from '../../lib/bridge';
import { useShallow } from 'zustand/react/shallow';
import { useVoiceModels } from '../../state/voiceModels';
import { useSettings } from '../../state/settings';

function formatMb(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(2)} Go` : `${Math.round(bytes / 1024 / 1024)} Mo`;
}

function ModelRow({ model }: { model: VoiceModelStatus }) {
  const progress = useVoiceModels((s) => s.progress[model.id]);
  const { download, cancel, remove } = useVoiceModels.getState();
  const activeStt = useSettings((s) => s.settings.voice.localModel);
  const activeTts = useSettings((s) => s.settings.speech.localModel);
  const update = useSettings((s) => s.update);
  const isActive = model.kind === 'stt' ? activeStt === model.id : activeTts === model.id;
  const busy = !!progress && (progress.phase === 'download' || progress.phase === 'extract');

  const wakeMode = useSettings((s) => s.settings.voice.wakeMode);
  const activate = () => {
    if (model.kind === 'stt') update({ voice: { localModel: model.id, provider: 'local' } });
    else if (model.kind === 'kws') update({ voice: { wakeMode: 'kws' } });
    else if (model.kind === 'vad') update({ voice: { neuralVad: true } });
    else update({ speech: { localModel: model.id, provider: 'local', localSpeaker: model.speakers?.[0]?.id ?? 0 } });
  };
  const neuralVad = useSettings((s) => s.settings.voice.neuralVad);
  const activeNow = model.kind === 'kws' ? wakeMode === 'kws' : model.kind === 'vad' ? neuralVad : isActive;

  return (
    <div className="row-item" style={activeNow && model.installed ? { borderColor: 'var(--accent)' } : undefined}>
      <div className="main">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="name">{model.name}</span>
          {model.recommended && <span className="status-pill ok">recommandé</span>}
          {model.installed && <span className="status-pill online">installé · {formatMb(model.installedBytes)}</span>}
          {!model.installed && !busy && <span className="status-pill">{model.sizeMb} Mo</span>}
          {activeNow && model.installed && <span className="status-pill active">actif</span>}
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
            {!activeNow && <button className="btn small" onClick={activate}>Utiliser</button>}
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
  const { models, engine, error } = useVoiceModels(useShallow((s) => ({ models: s.models, engine: s.engine, error: s.error })));
  const { refresh, checkEngine } = useVoiceModels.getState();
  useEffect(() => {
    void refresh();
    void checkEngine();
  }, [refresh, checkEngine]);

  if (!bridge()) return <div className="card"><div className="empty">Les modèles locaux ne sont disponibles que dans l’application Electron.</div></div>;

  const stt = models.filter((m) => m.kind === 'stt');
  const tts = models.filter((m) => m.kind === 'tts');
  const kws = models.filter((m) => m.kind === 'kws');
  const vad = models.filter((m) => m.kind === 'vad');
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
        <div className="section-title"><Ear size={12} /> Mot d’activation</div>
        <div className="list">{kws.map((m) => <ModelRow key={m.id} model={m} />)}</div>
      </div>
      <div className="card">
        <div className="section-title"><Activity size={12} /> Fin de phrase</div>
        <div className="list">{vad.map((m) => <ModelRow key={m.id} model={m} />)}</div>
        <span className="hint" style={{ display: 'block', marginTop: 6 }}>Utilisé automatiquement en écoute permanente dès qu’il est installé ; sinon le VAD énergétique prend le relais.</span>
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
