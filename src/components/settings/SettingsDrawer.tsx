import { useEffect, useState } from 'react';
import { X, Settings, CheckCircle2, XCircle, Loader2, Mic, Volume2, RotateCcw, Play } from 'lucide-react';
import { bridge } from '../../lib/bridge';
import { HermesClient, discoverHermesUrl, hermesUrlCandidates } from '../../services/hermes/client';
import { listSystemVoices } from '../../services/voice/tts';
import { speech } from '../../services/voice/speech';
import { ensurePreferredVoice } from '../../services/voice/voicePreference';
import { listMicrophones } from '../../services/voice/capture';
import { transcribeWav } from '../../services/voice/stt';
import { encodeWav } from '../../services/voice/wav';
import { useHermes } from '../../state/hermes';
import { DEFAULT_SETTINGS, useSettings, type HudTheme } from '../../state/settings';
import { useVoice } from '../../state/voice';
import { installedModels, useVoiceModels } from '../../state/voiceModels';
import { ModelsSection } from './ModelsSection';

type Section = 'general' | 'hermes' | 'voice' | 'speech' | 'models' | 'webhook' | 'notifications' | 'ui';

interface Props {
  onClose: () => void;
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="switch" onClick={() => onChange(!on)}>
      <div className="text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <span className={`toggle${on ? ' on' : ''}`} />
    </button>
  );
}

type TestState = { status: 'idle' | 'running' | 'ok' | 'fail'; message: string };

function WakeStatus() {
  const wake = useVoice((s) => s.wake);
  const keywords = useVoice((s) => s.wakeKeywords);
  const error = useVoice((s) => s.error);
  const models = useVoiceModels((s) => s.models);
  const download = useVoiceModels((s) => s.download);
  const progress = useVoiceModels((s) => s.progress['kws-en']);
  const installed = models.find((m) => m.id === 'kws-en')?.installed;
  if (installed === false) {
    return (
      <div className="test-result fail" style={{ marginTop: 8 }}>
        <XCircle size={13} />
        <span>Détecteur non installé.</span>
        <button className="btn small primary" style={{ marginLeft: 'auto' }} disabled={!!progress} onClick={() => void download('kws-en')}>
          {progress ? `${progress.percent}%` : 'Télécharger (4 Mo)'}
        </button>
      </div>
    );
  }
  return (
    <div className={`test-result ${wake === 'spotting' ? 'ok' : wake === 'error' ? 'fail' : ''}`} style={{ marginTop: 8 }}>
      {wake === 'spotting' ? <CheckCircle2 size={13} /> : wake === 'error' ? <XCircle size={13} /> : <Loader2 size={13} className="spin" />}
      <span>{wake === 'spotting' ? `à l’écoute de « ${keywords.join(' », « ')} »` : wake === 'error' ? error ?? 'erreur' : 'démarrage…'}</span>
    </div>
  );
}

function TestResult({ t }: { t: TestState }) {
  if (t.status === 'idle') return null;
  return (
    <div className={`test-result ${t.status === 'ok' ? 'ok' : t.status === 'fail' ? 'fail' : ''}`}>
      {t.status === 'running' ? <Loader2 size={13} className="spin" /> : t.status === 'ok' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
      <span>{t.message}</span>
    </div>
  );
}

export function SettingsDrawer({ onClose }: Props) {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const reset = useSettings((s) => s.reset);
  const hermesModels = useHermes((s) => s.models);
  const hermesWebhook = useHermes((s) => s.webhook);
  const hermesConnect = useHermes((s) => s.connect);
  const micDevices = useVoice((s) => s.micDevices);
  const voiceModels = useVoiceModels((s) => s.models);
  const refreshModels = useVoiceModels((s) => s.refresh);
  const [section, setSection] = useState<Section>('hermes');
  const [hermesTest, setHermesTest] = useState<TestState>({ status: 'idle', message: '' });
  const [sttTest, setSttTest] = useState<TestState>({ status: 'idle', message: '' });
  const [ttsTest, setTtsTest] = useState<TestState>({ status: 'idle', message: '' });
  const [voices, setVoices] = useState(listSystemVoices());
  const [webhookSecretVisible, setWebhookSecretVisible] = useState(false);

  useEffect(() => {
    const refresh = () => setVoices(listSystemVoices());
    refresh();
    speechSynthesis.addEventListener?.('voiceschanged', refresh);
    void listMicrophones().then((d) => useVoice.getState().setMicDevices(d));
    void refreshModels();
    return () => speechSynthesis.removeEventListener?.('voiceschanged', refresh);
  }, [refreshModels]);

  const testHermes = async () => {
    setHermesTest({ status: 'running', message: 'connexion…' });
    try {
      const client = new HermesClient(settings.hermes);
      const health = await client.health();
      let caps = '';
      try {
        const c = await client.capabilities();
        caps = ` · modèle ${String(c.model ?? '?')} · ${Object.entries(c.features ?? {}).filter(([, v]) => v === true).length} fonctions`;
      } catch (err) {
        const message = (err as Error).message;
        caps = /404/.test(message)
          ? ' · /v1/capabilities absent (Hermes ancien : transport chat completions)'
          : ` · capabilities : ${message}`;
      }
      const via = bridge() ? 'via Electron' : 'via navigateur';
      setHermesTest({ status: 'ok', message: `${health.status} (${via})${caps}` });
      void hermesConnect();
    } catch (err) {
      const message = (err as Error).message;
      setHermesTest({ status: 'running', message: `${message} — recherche de l’API sur le même hôte…` });
      const found = await discoverHermesUrl(settings.hermes, (u) => setHermesTest({ status: 'running', message: `essai ${u}…` })).catch(() => null);
      if (found) {
        update({ hermes: { url: found } });
        setHermesTest({ status: 'ok', message: `API Hermes trouvée : ${found} (URL corrigée automatiquement). Relancez le test.` });
        void hermesConnect();
      } else {
        setHermesTest({ status: 'fail', message: `${message} Aucune API trouvée sur ${hermesUrlCandidates(settings.hermes.url).slice(0, 4).join(', ')}…` });
      }
    }
  };

  const testStt = async () => {
    setSttTest({ status: 'running', message: 'envoi d’un WAV de test…' });
    try {
      const samples = new Float32Array(16000);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 20) * 0.05;
      const text = await transcribeWav(encodeWav(samples, 16000), settings.voice);
      setSttTest({ status: 'ok', message: `endpoint OK (réponse: "${text.slice(0, 40) || 'vide'}")` });
    } catch (err) {
      setSttTest({ status: 'fail', message: (err as Error).message });
    }
  };

  const testTts = () => {
    setTtsTest({ status: 'running', message: 'synthèse…' });
    speech.say(`Bonjour, je suis ${settings.assistantName}. Les systèmes sont opérationnels.`);
    setTimeout(() => setTtsTest({ status: 'ok', message: 'commande envoyée (écoutez le résultat)' }), 600);
  };

  const applyWebhook = async () => {
    const api = bridge();
    if (!api) return;
    await api.store.set('webhook', settings.webhook);
    const status = await api.hermes.webhookRestart();
    useHermes.setState({ webhook: status });
  };

  const nav: Array<[Section, string]> = [
    ['hermes', 'Hermes'],
    ['voice', 'Micro / STT'],
    ['speech', 'Voix / TTS'],
    ['models', 'Modèles locaux'],
    ['webhook', 'Webhook'],
    ['notifications', 'Notifications'],
    ['general', 'Général'],
    ['ui', 'Interface']
  ];

  return (
    <aside className="settings-drawer">
      <header className="panel-head">
        <Settings size={14} />
        <span>Configuration</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} title="Fermer"><X size={16} /></button>
      </header>
      <nav className="settings-nav">
        {nav.map(([id, label]) => (
          <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>{label}</button>
        ))}
      </nav>
      <div className="settings-body">
        {section === 'hermes' && (
          <>
            <div className="card">
              <div className="field">
                <label>URL du serveur API Hermes</label>
                <input className="input" value={settings.hermes.url} placeholder="http://127.0.0.1:8642" onChange={(e) => update({ hermes: { url: e.target.value } })} />
                <span className="hint">Serveur lancé avec <code>hermes gateway</code> (API_SERVER_ENABLED=true, port 8642 par défaut). L’URL peut se terminer par /v1.</span>
              </div>
              <div className="field">
                <label>Clé API (API_SERVER_KEY)</label>
                <input className="input" type="password" value={settings.hermes.apiKey} onChange={(e) => update({ hermes: { apiKey: e.target.value } })} />
              </div>
              <div className="grid-2">
                <div className="field">
                  <label>Modèle</label>
                  <input className="input" list="hermes-models" value={settings.hermes.model} placeholder="(défaut du serveur)" onChange={(e) => update({ hermes: { model: e.target.value } })} />
                  <datalist id="hermes-models">
                    {hermesModels.map((m) => <option key={m.id} value={m.id} />)}
                  </datalist>
                </div>
                <div className="field">
                  <label>Clé de mémoire (X-Hermes-Session-Key)</label>
                  <input className="input" value={settings.hermes.sessionKey} onChange={(e) => update({ hermes: { sessionKey: e.target.value } })} />
                </div>
              </div>
              <div className="grid-2">
                <div className="field">
                  <label>Transport</label>
                  <select className="select" value={settings.hermes.transport} onChange={(e) => update({ hermes: { transport: e.target.value as typeof settings.hermes.transport } })}>
                    <option value="auto">Auto (selon /v1/capabilities)</option>
                    <option value="runs">Runs API (SSE, approbations, steer)</option>
                    <option value="sessions">Sessions API (mémoire serveur)</option>
                    <option value="completions">Chat completions (OpenAI + outils EveFlow)</option>
                  </select>
                </div>
                <div className="field">
                  <label>Effort de raisonnement</label>
                  <select className="select" value={settings.hermes.reasoningEffort} onChange={(e) => update({ hermes: { reasoningEffort: e.target.value as typeof settings.hermes.reasoningEffort } })}>
                    <option value="">Défaut</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
              </div>
              <div className="field">
              <label>Modèle « mission » (tâches longues)</label>
              <input className="input" list="hermes-models" value={settings.hermes.missionModel} placeholder="(même modèle)" onChange={(e) => update({ hermes: { missionModel: e.target.value } })} />
              <span className="hint">Utilisé quand le mode Mission est activé dans la barre de commande. Laissez vide pour garder le modèle principal.</span>
            </div>
            <div className="field">
                <label>Instructions EveFlow (superposées au prompt Hermes)</label>
                <textarea className="textarea" value={settings.hermes.instructions} onChange={(e) => update({ hermes: { instructions: e.target.value } })} />
              </div>
              <Toggle on={settings.hermes.localTools} onChange={(v) => update({ hermes: { localTools: v } })} label="Outils EveFlow côté client" hint="En mode chat completions : état du HUD, fichiers partagés, notifications." />
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn primary small" onClick={() => void testHermes()}><Play size={13} /> Tester la liaison</button>
              </div>
              <div style={{ marginTop: 8 }}><TestResult t={hermesTest} /></div>
            </div>
          </>
        )}

        {section === 'voice' && (
          <div className="card">
            <div className="field">
              <label>Moteur de reconnaissance</label>
              <select className="select" value={settings.voice.provider} onChange={(e) => update({ voice: { provider: e.target.value as typeof settings.voice.provider } })}>
                <option value="local">Local dans l’application (Whisper via sherpa-onnx, hors ligne)</option>
                <option value="openai-compatible">API compatible OpenAI (Qwen3-ASR, Whisper, Speaches, LocalAI…)</option>
                <option value="browser">Reconnaissance Chromium (en ligne, secours)</option>
              </select>
            </div>
            {settings.voice.provider === 'local' && (
              <div className="field">
                <label>Modèle local</label>
                {installedModels(voiceModels, 'stt').length === 0 ? (
                  <span className="hint">Aucun modèle installé. <a href="#" onClick={(e) => { e.preventDefault(); setSection('models'); }}>Téléchargez Whisper base dans « Modèles locaux »</a>.</span>
                ) : (
                  <select className="select" value={settings.voice.localModel} onChange={(e) => update({ voice: { localModel: e.target.value } })}>
                    {installedModels(voiceModels, 'stt').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                )}
              </div>
            )}
            {settings.voice.provider === 'openai-compatible' && (
              <>
                <div className="field">
                  <label>URL de l’API STT</label>
                  <input className="input" value={settings.voice.apiUrl} placeholder="http://127.0.0.1:8000/v1" onChange={(e) => update({ voice: { apiUrl: e.target.value } })} />
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label>Modèle</label>
                    <input className="input" value={settings.voice.model} onChange={(e) => update({ voice: { model: e.target.value } })} />
                  </div>
                  <div className="field">
                    <label>Clé API</label>
                    <input className="input" type="password" value={settings.voice.apiKey} onChange={(e) => update({ voice: { apiKey: e.target.value } })} />
                  </div>
                </div>
              </>
            )}
            <div className="grid-2">
              <div className="field">
                <label>Langue</label>
                <select className="select" value={settings.voice.language} onChange={(e) => update({ voice: { language: e.target.value }, language: e.target.value })}>
                  <option value="fr-FR">Français</option>
                  <option value="en-US">English</option>
                  <option value="es-ES">Español</option>
                  <option value="de-DE">Deutsch</option>
                  <option value="it-IT">Italiano</option>
                </select>
              </div>
              <div className="field">
                <label>Microphone</label>
                <select className="select" value={settings.voice.micDeviceId} onChange={(e) => update({ voice: { micDeviceId: e.target.value } })}>
                  <option value="">Par défaut du système</option>
                  {micDevices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label>Mode de capture</label>
              <div className="seg">
                <button className={settings.voice.captureMode === 'auto' ? 'active' : ''} onClick={() => update({ voice: { captureMode: 'auto' } })}>Auto (détection de silence)</button>
                <button className={settings.voice.captureMode === 'manual' ? 'active' : ''} onClick={() => update({ voice: { captureMode: 'manual' } })}>Manuel (clic pour arrêter)</button>
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label>Sensibilité : {settings.voice.sensitivity}/5</label>
                <input className="range" type="range" min={1} max={5} step={1} value={settings.voice.sensitivity} onChange={(e) => update({ voice: { sensitivity: Number(e.target.value) } })} />
              </div>
              <div className="field">
                <label>Silence de fin : {settings.voice.silenceMs} ms</label>
                <input className="range" type="range" min={400} max={2500} step={100} value={settings.voice.silenceMs} onChange={(e) => update({ voice: { silenceMs: Number(e.target.value) } })} />
              </div>
            </div>
            <Toggle on={settings.voice.handsFree} onChange={(v) => { update({ voice: { handsFree: v } }); useVoice.getState().setHandsFree(v); }} label="Mains libres au démarrage" hint="Le micro se réactive automatiquement après chaque réponse." />
            <Toggle on={settings.voice.wakeChime} onChange={(v) => update({ voice: { wakeChime: v } })} label="Signal sonore d’écoute" />
            <div className="field" style={{ marginTop: 10 }}>
              <label>Mot d’activation</label>
              <select className="select" value={settings.voice.wakeMode} onChange={(e) => update({ voice: { wakeMode: e.target.value as typeof settings.voice.wakeMode, wakeWordEnabled: e.target.value === 'transcript' } })}>
                <option value="off">Désactivé (bouton, raccourci ou mains libres)</option>
                <option value="kws">Écoute permanente : le micro reste ouvert et réagit au mot-clé (recommandé)</option>
                <option value="transcript">Filtre après transcription (mains libres) : les phrases sans le mot sont ignorées</option>
              </select>
              <span className="hint">
                {settings.voice.wakeMode === 'kws'
                  ? 'Détection locale par un modèle de 3 Mo, quasi gratuite en CPU. Dire le mot seul ouvre l’écoute ; dire le mot puis la commande envoie directement. Le mot coupe aussi la voix en cours.'
                  : settings.voice.wakeMode === 'transcript'
                    ? 'Chaque phrase est transcrite puis filtrée : plus coûteux, à réserver à la reconnaissance locale.'
                    : 'Le micro s’active avec le bouton, Ctrl+Shift+Espace ou la boucle mains libres.'}
              </span>
            </div>
            {settings.voice.wakeMode !== 'off' && (
              <div className="grid-2">
                <div className="field">
                  <label>Mot-clé</label>
                  <input className="input" value={settings.voice.wakeWord} placeholder="jarvis" onChange={(e) => update({ voice: { wakeWord: e.target.value.toLowerCase().slice(0, 40) } })} />
                  <span className="hint">Prononciation anglaise conseillée (« jarvis », « hey jarvis », « computer », « friday »…).</span>
                </div>
                {settings.voice.wakeMode === 'kws' && (
                  <div className="field">
                    <label>Sensibilité du mot-clé : {settings.voice.kwsSensitivity}/5</label>
                    <input className="range" type="range" min={1} max={5} step={1} value={settings.voice.kwsSensitivity} onChange={(e) => update({ voice: { kwsSensitivity: Number(e.target.value) } })} />
                  </div>
                )}
              </div>
            )}
            {settings.voice.wakeMode === 'kws' && (
              <>
                <WakeStatus />
                <Toggle on={settings.voice.neuralVad} onChange={(v) => update({ voice: { neuralVad: v } })} label="Fin de phrase neuronale (Silero)" hint="Coupe l’écoute au bon moment, même avec du bruit de fond. Nécessite le modèle Silero VAD (0,6 Mo) dans Modèles locaux." />
              </>
            )}
            <Toggle on={settings.voice.localCommands} onChange={(v) => update({ voice: { localCommands: v } })} label="Commandes locales instantanées" hint="« Verrouille la session », « monte le son », « ouvre Spotify », « regarde mon écran »… exécutées sur ce PC sans passer par Hermes." />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn small" onClick={() => void testStt()} disabled={settings.voice.provider === 'browser'}><Mic size={13} /> Tester la reconnaissance</button>
            </div>
            <div style={{ marginTop: 8 }}><TestResult t={sttTest} /></div>
          </div>
        )}

        {section === 'speech' && (
          <div className="card">
            <div className="field">
              <label>Voix</label>
              <div className="segmented">
                <button className={(settings.speech.voiceGender ?? 'male') === 'male' ? 'active' : ''} onClick={() => { update({ speech: { voiceGender: 'male' } }); void ensurePreferredVoice().then((m) => m && setTtsTest({ status: 'ok', message: m })); }}>Masculine</button>
                <button className={settings.speech.voiceGender === 'female' ? 'active' : ''} onClick={() => { update({ speech: { voiceGender: 'female' } }); void ensurePreferredVoice().then((m) => m && setTtsTest({ status: 'ok', message: m })); }}>Féminine</button>
              </div>
              <span className="hint">S’applique à tous les moteurs : voix locale (Piper Tom ou Pierre pour le masculin, téléchargée automatiquement si besoin), voix OpenAI (onyx / nova), voix système Windows (Paul / Hortense).</span>
            </div>
            <div className="field">
              <label>Moteur de synthèse</label>
              <select className="select" value={settings.speech.provider} onChange={(e) => update({ speech: { provider: e.target.value as typeof settings.speech.provider } })}>
                <option value="local">Local dans l’application (Kokoro / Piper via sherpa-onnx, hors ligne)</option>
                <option value="openai-compatible">API compatible OpenAI /v1/audio/speech (Kokoro, Piper, OpenAI, LocalAI…)</option>
                <option value="system">Voix système Windows</option>
                <option value="google-free">Google Translate (gratuit, en ligne)</option>
                <option value="off">Désactivée</option>
              </select>
            </div>
            {settings.speech.provider === 'openai-compatible' && (
              <>
                <div className="field">
                  <label>URL de l’API TTS</label>
                  <input className="input" value={settings.speech.apiUrl} placeholder="http://127.0.0.1:8000/v1" onChange={(e) => update({ speech: { apiUrl: e.target.value } })} />
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label>Modèle</label>
                    <input className="input" value={settings.speech.model} onChange={(e) => update({ speech: { model: e.target.value } })} />
                  </div>
                  <div className="field">
                    <label>Voix</label>
                    <input className="input" value={settings.speech.voice} placeholder="alloy, onyx, af_heart…" onChange={(e) => update({ speech: { voice: e.target.value } })} />
                  </div>
                  <div className="field">
                    <label>Clé API</label>
                    <input className="input" type="password" value={settings.speech.apiKey} onChange={(e) => update({ speech: { apiKey: e.target.value } })} />
                  </div>
                  <div className="field">
                    <label>Format</label>
                    <select className="select" value={settings.speech.format} onChange={(e) => update({ speech: { format: e.target.value as typeof settings.speech.format } })}>
                      <option value="mp3">mp3</option>
                      <option value="wav">wav</option>
                      <option value="opus">opus</option>
                    </select>
                  </div>
                </div>
              </>
            )}
            {settings.speech.provider === 'local' && (
              installedModels(voiceModels, 'tts').length === 0 ? (
                <div className="field">
                  <span className="hint">Aucun modèle de voix installé. <a href="#" onClick={(e) => { e.preventDefault(); setSection('models'); }}>Téléchargez Kokoro dans « Modèles locaux »</a>.</span>
                </div>
              ) : (
                <div className="grid-2">
                  <div className="field">
                    <label>Modèle local</label>
                    <select className="select" value={settings.speech.localModel} onChange={(e) => {
                      const m = voiceModels.find((x) => x.id === e.target.value);
                      update({ speech: { localModel: e.target.value, localSpeaker: m?.speakers?.[0]?.id ?? 0 } });
                    }}>
                      {installedModels(voiceModels, 'tts').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Voix</label>
                    <select className="select" value={settings.speech.localSpeaker} onChange={(e) => update({ speech: { localSpeaker: Number(e.target.value) } })}>
                      {(voiceModels.find((m) => m.id === settings.speech.localModel)?.speakers ?? [{ id: 0, name: 'Voix 0', lang: '' }]).map((sp) => (
                        <option key={sp.id} value={sp.id}>{sp.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )
            )}
            {settings.speech.provider === 'system' && (
              <div className="field">
                <label>Voix système</label>
                <select className="select" value={settings.speech.systemVoice} onChange={(e) => update({ speech: { systemVoice: e.target.value } })}>
                  <option value="">Automatique ({settings.speech.language})</option>
                  {voices.map((v) => <option key={v.name} value={v.name}>{v.name} · {v.lang}</option>)}
                </select>
              </div>
            )}
            <div className="grid-2">
              <div className="field">
                <label>Vitesse : {settings.speech.speed.toFixed(2)}</label>
                <input className="range" type="range" min={0.6} max={1.8} step={0.05} value={settings.speech.speed} onChange={(e) => update({ speech: { speed: Number(e.target.value) } })} />
              </div>
              <div className="field">
                <label>Volume : {Math.round(settings.speech.volume * 100)}%</label>
                <input className="range" type="range" min={0} max={1.2} step={0.05} value={settings.speech.volume} onChange={(e) => update({ speech: { volume: Number(e.target.value) } })} />
              </div>
            </div>
            <Toggle on={settings.speech.autoSpeak} onChange={(v) => update({ speech: { autoSpeak: v } })} label="Lire les réponses en streaming" hint="Chaque phrase est prononcée dès qu’elle est complète." />
            <Toggle on={settings.speech.speakIncoming} onChange={(v) => update({ speech: { speakIncoming: v } })} label="Lire les messages entrants (webhook, crons)" />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn small" onClick={testTts} disabled={settings.speech.provider === 'off'}><Volume2 size={13} /> Tester la voix</button>
            </div>
            <div style={{ marginTop: 8 }}><TestResult t={ttsTest} /></div>
          </div>
        )}

        {section === 'models' && <ModelsSection />}

        {section === 'webhook' && (
          <div className="card">
            <Toggle on={settings.webhook.enabled} onChange={(v) => update({ webhook: { enabled: v } })} label="Serveur webhook local" hint="Hermes (crons, gateway, scripts) peut pousser des messages vers EveFlow." />
            <div className="grid-2">
              <div className="field">
                <label>Port</label>
                <input className="input" type="number" min={1024} max={65535} value={settings.webhook.port} onChange={(e) => update({ webhook: { port: Number(e.target.value) || 7842 } })} />
              </div>
              <div className="field">
                <label>Secret (en-tête X-EveFlow-Secret)</label>
                <div className="row">
                  <input className="input" type={webhookSecretVisible ? 'text' : 'password'} value={settings.webhook.secret} onChange={(e) => update({ webhook: { secret: e.target.value } })} />
                  <button className="btn ghost small" onClick={() => setWebhookSecretVisible((v) => !v)}>{webhookSecretVisible ? 'cacher' : 'voir'}</button>
                </div>
              </div>
            </div>
            <div className="field">
              <label>Exemple d’appel</label>
              <pre className="input" style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, userSelect: 'text' }}>{`curl -X POST http://<ip-de-ce-pc>:${settings.webhook.port}/eveflow/hook \\
  -H "Content-Type: application/json"${settings.webhook.secret ? ' \\\n  -H "X-EveFlow-Secret: ***"' : ''} \\
  -d '{"role":"assistant","text":"Rapport terminé","source":"telegram"}'`}</pre>
              <span className="hint">Formats acceptés : {'{role,text}'}, {'{event:"run.completed",input,output}'}, {'{event:"job.completed",job:{name},output,status}'}, {'{type:"message",payload:{text}}'}.</span>
            </div>
            <div className="field">
              <label>Serveur MCP pour Hermes (outils du PC : écran, applications, volume, presse-papiers, voix)</label>
              <pre className="input" style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, userSelect: 'text' }}>{`# ~/.hermes/config.yaml côté Hermes
mcp_servers:
  eveflow:
    url: "http://<ip-de-ce-pc>:${settings.webhook.port}/mcp"${settings.webhook.secret ? '\n    headers:\n      Authorization: "Bearer <secret>"' : ''}`}</pre>
              <span className="hint">Même port et même secret que le webhook. Sans secret, EveFlow n’écoute qu’en local (127.0.0.1) : définissez un secret pour un Hermes distant.</span>
            </div>
            <div className="row">
              <button className="btn primary small" onClick={() => void applyWebhook()} disabled={!bridge()}>Appliquer et redémarrer</button>
              {hermesWebhook && <span className={`status-pill ${hermesWebhook.listening ? 'online' : 'offline'}`}>{hermesWebhook.listening ? `port ${hermesWebhook.port}` : hermesWebhook.error ?? 'inactif'}</span>}
            </div>
          </div>
        )}

        {section === 'notifications' && (
          <div className="card">
            <Toggle on={settings.notifications.quietEnabled} onChange={(v) => update({ notifications: { quietEnabled: v } })} label="Heures calmes" hint="Les messages poussés (crons, Telegram) s’affichent sans être lus à voix haute ni faire clignoter le noyau ; le HUD passe en mode nuit." />
            <div className="grid-2">
              <div className="field">
                <label>Début</label>
                <input className="input" type="time" value={settings.notifications.quietStart} onChange={(e) => update({ notifications: { quietStart: e.target.value } })} />
              </div>
              <div className="field">
                <label>Fin</label>
                <input className="input" type="time" value={settings.notifications.quietEnd} onChange={(e) => update({ notifications: { quietEnd: e.target.value } })} />
              </div>
            </div>
            <Toggle on={settings.notifications.nightTheme} onChange={(v) => update({ notifications: { nightTheme: v } })} label="Thème nuit pendant les heures calmes" />
            <div className="field" style={{ marginTop: 10 }}>
              <label>Mots prioritaires (lus même en heures calmes)</label>
              <input className="input" value={settings.notifications.priorityKeywords} onChange={(e) => update({ notifications: { priorityKeywords: e.target.value } })} placeholder="urgent, alerte, panne" />
              <span className="hint">Séparés par des virgules ; comparés au texte et au nom du cron. Les échecs de crons sont toujours prioritaires.</span>
            </div>
            <Toggle on={settings.notifications.summarizeIncoming} onChange={(v) => update({ notifications: { summarizeIncoming: v } })} label="Résumé vocal des messages entrants" hint="Seules les premières phrases sont lues ; le message complet reste dans le fil." />
            {settings.notifications.summarizeIncoming && (
              <div className="field">
                <label>Phrases lues : {settings.notifications.summarySentences}</label>
                <input className="range" type="range" min={1} max={5} step={1} value={settings.notifications.summarySentences} onChange={(e) => update({ notifications: { summarySentences: Number(e.target.value) } })} />
              </div>
            )}
          </div>
        )}

        {section === 'general' && (
          <div className="card">
            <div className="grid-2">
              <div className="field">
                <label>Nom de l’assistant</label>
                <input className="input" value={settings.assistantName} onChange={(e) => update({ assistantName: e.target.value.toUpperCase().slice(0, 18) || 'JARVIS' })} />
              </div>
              <div className="field">
                <label>Votre nom</label>
                <input className="input" value={settings.userName} placeholder="Monsieur" onChange={(e) => update({ userName: e.target.value.slice(0, 24) })} />
              </div>
            </div>
            <div className="field">
              <label>Thème du HUD</label>
              <div className="theme-swatches">
                {(['arc', 'gold', 'crimson', 'emerald'] as HudTheme[]).map((t) => {
                  const colors: Record<HudTheme, string> = { arc: '#34e4ff', gold: '#ffc35a', crimson: '#ff5c6c', emerald: '#4ef0a8' };
                  return <button key={t} className={`swatch${settings.theme === t ? ' active' : ''}`} style={{ background: colors[t] }} title={t} aria-label={`Thème ${t}`} aria-pressed={settings.theme === t} onClick={() => update({ theme: t })} />;
                })}
              </div>
            </div>
            <div className="field">
              <label>Raccourcis globaux</label>
              <span className="hint"><span className="kbd">Ctrl+Shift+Espace</span> micro · <span className="kbd">Ctrl+Shift+J</span> afficher/masquer · <span className="kbd">Ctrl+Alt+Échap</span> couper la voix · <span className="kbd">Ctrl+K</span> saisie</span>
            </div>
            <div className="divider" />
            <button className="btn danger small" onClick={() => { if (confirm('Réinitialiser tous les paramètres ?')) reset(); }}><RotateCcw size={13} /> Réinitialiser</button>
          </div>
        )}

        {section === 'ui' && (
          <div className="card">
            <Toggle on={settings.ui.showTelemetry} onChange={(v) => update({ ui: { showTelemetry: v } })} label="Télémétrie système" />
            <Toggle on={settings.ui.showReasoning} onChange={(v) => update({ ui: { showReasoning: v } })} label="Afficher le raisonnement du modèle" hint="Quand Hermes le transmet (reasoning.available)." />
            <Toggle on={settings.ui.reduceMotion} onChange={(v) => update({ ui: { reduceMotion: v } })} label="Réduire les animations" />
            <div className="field" style={{ marginTop: 10 }}>
              <label>Opacité du widget compact : {Math.round(settings.ui.compactOpacity * 100)}%</label>
              <input className="range" type="range" min={0.5} max={1} step={0.02} value={settings.ui.compactOpacity} onChange={(e) => update({ ui: { compactOpacity: Number(e.target.value) } })} />
            </div>
            <span className="hint">Valeurs par défaut : {DEFAULT_SETTINGS.assistantName}, thème {DEFAULT_SETTINGS.theme}.</span>
          </div>
        )}
      </div>
    </aside>
  );
}
