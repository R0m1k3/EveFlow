import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Send, Mic, MicOff, Settings, MessageSquare, Volume2, VolumeX,
  Cpu, Minimize2, X, AlertCircle, StopCircle, Paperclip,
  CalendarClock, History, Wrench, Play, Pause, RefreshCw, Trash2, Plus,
  CheckCircle2, WifiOff, Edit3, Save, ChevronUp, ExternalLink,
  BriefcaseBusiness, AlertTriangle
} from 'lucide-react';
import { ThreeCanvas, ToolEvent } from './components/ThreeCanvas';
import { AudioService } from './services/audioService';
import { AgentService, AgentConfig, AgentProvider } from './services/agentService';
import { EmotionService, EveAvatar, EveEmotion } from './services/emotionService';
import { HermesJob, HermesJobDraft, PollingService } from './services/pollingService';
import { AppCallbacks } from './services/toolRegistry';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  emotion?: EveEmotion;
  timestamp: Date;
  source?: 'eveflow' | 'telegram' | 'webhook' | 'cron';
  images?: string[]; // base64 Data URLs pour affichage local direct
}

interface Attachment {
  name: string;
  type: string;
  dataUrl: string; // base64 Data URL
  size: number;
}

type HermesCockpitTab = 'tools' | 'crons' | 'history';
type HermesSyncState = 'idle' | 'syncing' | 'online' | 'offline';

interface HermesRunRecord {
  id: string;
  jobId: string;
  jobName: string;
  status: 'succeeded' | 'failed';
  result: string;
  at: string;
  read: boolean;
}

interface HermesCronCache {
  jobs: HermesJob[];
  runs: HermesRunRecord[];
  lastSyncAt?: string;
}

export const TTS_LONG_TEXT_THRESHOLD = 450;

// Helper de compression d'image asynchrone via Canvas HTML5 (Zero Trust & Zero Dependency)
// Réduit les payloads gigantesques (ex: 8 Mo d'un appareil photo) à environ 100-150 Ko pour fluidifier React et l'API
const compressImage = (dataUrl: string, mimeType: string): Promise<{ dataUrl: string; size: number }> => {
  return new Promise((resolve) => {
    // Si ce n'est pas une image ou si c'est un SVG / GIF animé, on conserve l'original
    if (!mimeType.startsWith('image/') || mimeType === 'image/svg+xml' || mimeType.includes('gif')) {
      resolve({ dataUrl, size: Math.round((dataUrl.length * 3) / 4) });
      return;
    }

    const img = new Image();
    img.src = dataUrl;
    img.onload = () => {
      try {
        const MAX_WIDTH = 1024;
        const MAX_HEIGHT = 1024;
        let width = img.width;
        let height = img.height;

        // Conserver le ratio hauteur/largeur
        if (width > MAX_WIDTH || height > MAX_HEIGHT) {
          if (width > height) {
            height = Math.round((height * MAX_WIDTH) / width);
            width = MAX_WIDTH;
          } else {
            width = Math.round((width * MAX_HEIGHT) / height);
            height = MAX_HEIGHT;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          // Compression en JPEG à 70% de qualité (idéal pour la vision par IA et parfait visuellement pour les miniatures)
          const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.7);
          const approxSize = Math.round((compressedDataUrl.length * 3) / 4);
          resolve({ dataUrl: compressedDataUrl, size: approxSize });
        } else {
          resolve({ dataUrl, size: Math.round((dataUrl.length * 3) / 4) });
        }
      } catch (e) {
        console.error("Échec de la compression de l'image sélectionnée:", e);
        resolve({ dataUrl, size: Math.round((dataUrl.length * 3) / 4) });
      }
    };
    img.onerror = () => {
      resolve({ dataUrl, size: Math.round((dataUrl.length * 3) / 4) });
    };
  });
};

// Prétraite le contenu d'un message pour convertir les tokens MEDIA:<chemin> en syntaxe Markdown image
// Le bot Hermes envoie MEDIA:/tmp/cat.jpg au lieu de ![img](/tmp/cat.jpg), on corrige ça côté renderer
const preprocessMessageContent = (content: string): string => {
  if (!content) return content;
  // Entourer de \n\n pour que ReactMarkdown traite l'image comme un élément bloc (pas inline)
  return content.replace(/MEDIA:\s*(\S+)/g, (_match, filePath) => `\n\n![image](${filePath})\n\n`);
};

// Cache module-level des images déjà chargées (src → dataUrl ou blobUrl)
// Évite les re-fetches et le clignotement quand ReactMarkdown recrée les composants pendant le streaming
const _imgCache = new Map<string, string>();
const _imgPending = new Map<string, Promise<string>>();
const _imgErrorCache = new Map<string, string>();

// Composant de rendu asynchrone pour les images locales dans ReactMarkdown et la galerie
// Gère de façon Zero Trust la distinction entre base64 local, fichier Windows, et chemin absolu du serveur distant Hermes
// Le cache module-level _imgCache évite les refetch et le clignotement lors du streaming React
const LocalImage: React.FC<{ 
  src: string; 
  alt?: string; 
  agentUrl?: string; 
  provider?: string;
  hermesApiKey?: string;
  hermesSessionKey?: string;
  [key: string]: any; 
}> = ({ src, alt, agentUrl, provider, hermesApiKey, hermesSessionKey, ...props }) => {
  // Initialisation lazy : si déjà en cache, pas de flash du GIF transparent
  const [imageSrc, setImageSrc] = useState<string>(() => _imgCache.get(src) || '');
  const [error, setError] = useState<string>(() => _imgErrorCache.get(src) || '');
  void error;

  useEffect(() => {
    if (!src) return;

    // Cache hit : image déjà chargée, on l'affiche immédiatement sans aucun fetch
    if (_imgCache.has(src)) {
      setImageSrc(_imgCache.get(src)!);
      return;
    }

    if (_imgErrorCache.has(src)) {
      setError(_imgErrorCache.get(src)!);
      return;
    }

    const setAndCache = (url: string) => {
      _imgCache.set(src, url);
      _imgErrorCache.delete(src);
      setError('');
      setImageSrc(url);
    };

    const setFailure = (message: string) => {
      _imgErrorCache.set(src, message);
      setError(message);
      setImageSrc('');
    };

    const loadRemote = (remoteUrl: string, headers?: Record<string, string>) => {
      const api = (window as any).electronAPI;
      if (!api?.fetchRemoteImage) {
        setAndCache(remoteUrl);
        return;
      }

      if (!_imgPending.has(remoteUrl)) {
        const pending = api.fetchRemoteImage(remoteUrl, headers || {})
          .then((dataUrl: string) => {
            _imgCache.set(remoteUrl, dataUrl);
            _imgErrorCache.delete(remoteUrl);
            return dataUrl;
          })
          .catch((err: any) => {
            const message = `Image inaccessible (${err?.message || 'erreur reseau'})`;
            _imgErrorCache.set(remoteUrl, message);
            throw new Error(message);
          })
          .finally(() => _imgPending.delete(remoteUrl));
        _imgPending.set(remoteUrl, pending);
      }

      _imgPending.get(remoteUrl)!
        .then(setAndCache)
        .catch((err: any) => setFailure(err?.message || 'Image inaccessible'));
    };
    void loadRemote;

    // 1. Data URL directe — rien à faire
    if (src.startsWith('data:')) {
      setAndCache(src);
      return;
    }

    // 2. URL HTTP/HTTPS : passer par le processus principal Electron (Node.js) pour
    //    charger l'image sans restriction CORS ni problème de serveur statique
    if (src.startsWith('http://') || src.startsWith('https://')) {
      const api = (window as any).electronAPI;
      if (api?.fetchRemoteImage) {
        api.fetchRemoteImage(src)
          .then(setAndCache)
          .catch(() => setAndCache(src)); // fallback direct si IPC échoue
      } else {
        setAndCache(src);
      }
      return;
    }

    // 3. Chemin local Windows (file:// ou C:\...)
    const isWindowsLocal = src.startsWith('file://') || /^[a-zA-Z]:/.test(src);

    const resolveRemoteHermes = () => {
      if (provider === 'hermes' && agentUrl) {
        try {
          const parsed = new URL(agentUrl);
          const hostUrl = `${parsed.protocol}//${parsed.host}`;
          let relativePath = src;
          if (src.startsWith('file://')) {
            relativePath = src.replace(/^file:\/\/\/[a-zA-Z]:/, '').replace(/^file:\/\//, '');
          } else if (/^[a-zA-Z]:/.test(src)) {
            relativePath = src.substring(2);
          }
          relativePath = relativePath.replace(/\\/g, '/');
          const resolvedUrl = `${hostUrl.replace(/\/$/, '')}/${relativePath.replace(/^\//, '')}`;

          const authHeaders: Record<string, string> = {};
          if (hermesApiKey) authHeaders['Authorization'] = `Bearer ${hermesApiKey}`;
          if (hermesSessionKey) authHeaders['X-Hermes-Session-Key'] = hermesSessionKey;

          const api = (window as any).electronAPI;
          if (api?.fetchRemoteImage) {
            api.fetchRemoteImage(resolvedUrl, authHeaders)
              .then(setAndCache)
              .catch(() => setAndCache(resolvedUrl));
          } else {
            setAndCache(resolvedUrl);
          }
        } catch {
          setAndCache(src);
        }
      } else {
        setAndCache(src);
      }
    };

    if (isWindowsLocal && (window as any).electronAPI?.readLocalFile) {
      let cleanPath = src;
      if (src.startsWith('file:///')) cleanPath = src.substring(8);
      else if (src.startsWith('file://')) cleanPath = src.substring(7);
      cleanPath = cleanPath.replace(/\//g, '\\');
      (window as any).electronAPI.readLocalFile(cleanPath)
        .then(setAndCache)
        .catch(() => resolveRemoteHermes());
    } else {
      // Chemin Unix (/tmp/cat.jpg) → construire l'URL Hermes et charger via IPC
      resolveRemoteHermes();
    }
  }, [src, agentUrl, provider]);

  return (
    <img
      src={imageSrc || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}
      alt={alt || 'Visualisation'}
      className="markdown-image"
      {...props}
    />
  );
};
void LocalImage;

const ResilientImage: React.FC<{
  src: string;
  alt?: string;
  agentUrl?: string;
  provider?: string;
  hermesApiKey?: string;
  hermesSessionKey?: string;
  [key: string]: any;
}> = ({ src, alt, agentUrl, provider, hermesApiKey, hermesSessionKey, ...props }) => {
  const [imageSrc, setImageSrc] = useState<string>(() => _imgCache.get(src) || '');
  const [error, setError] = useState<string>(() => _imgErrorCache.get(src) || '');

  useEffect(() => {
    if (!src) return;

    if (_imgCache.has(src)) {
      setImageSrc(_imgCache.get(src)!);
      setError('');
      return;
    }

    if (_imgErrorCache.has(src)) {
      setError(_imgErrorCache.get(src)!);
      return;
    }

    const setSuccess = (cacheKey: string, value: string) => {
      _imgCache.set(cacheKey, value);
      _imgErrorCache.delete(cacheKey);
      setImageSrc(value);
      setError('');
    };

    const setFailure = (cacheKey: string, message: string) => {
      _imgErrorCache.set(cacheKey, message);
      setImageSrc('');
      setError(message);
    };

    const loadRemote = (remoteUrl: string, headers?: Record<string, string>) => {
      const api = (window as any).electronAPI;
      if (!api?.fetchRemoteImage) {
        setSuccess(src, remoteUrl);
        return;
      }

      if (!_imgPending.has(remoteUrl)) {
        const pending = api.fetchRemoteImage(remoteUrl, headers || {})
          .then((dataUrl: string) => {
            _imgCache.set(remoteUrl, dataUrl);
            _imgErrorCache.delete(remoteUrl);
            return dataUrl;
          })
          .catch((err: any) => {
            const message = `Image inaccessible (${err?.message || 'erreur reseau'})`;
            _imgErrorCache.set(remoteUrl, message);
            throw new Error(message);
          })
          .finally(() => _imgPending.delete(remoteUrl));
        _imgPending.set(remoteUrl, pending);
      }

      _imgPending.get(remoteUrl)!
        .then((dataUrl) => setSuccess(src, dataUrl))
        .catch((err: any) => setFailure(src, err?.message || 'Image inaccessible'));
    };

    if (src.startsWith('data:')) {
      setSuccess(src, src);
      return;
    }

    if (src.startsWith('http://') || src.startsWith('https://')) {
      loadRemote(src);
      return;
    }

    const isWindowsLocal = src.startsWith('file://') || /^[a-zA-Z]:/.test(src);
    const resolveRemoteHermes = () => {
      if (provider === 'hermes' && agentUrl) {
        try {
          const parsed = new URL(agentUrl);
          const hostUrl = `${parsed.protocol}//${parsed.host}`;
          let relativePath = src;
          if (src.startsWith('file://')) {
            relativePath = src.replace(/^file:\/\/\/[a-zA-Z]:/, '').replace(/^file:\/\//, '');
          } else if (/^[a-zA-Z]:/.test(src)) {
            relativePath = src.substring(2);
          }
          relativePath = relativePath.replace(/\\/g, '/');
          const resolvedUrl = `${hostUrl.replace(/\/$/, '')}/${relativePath.replace(/^\//, '')}`;
          const headers: Record<string, string> = {};
          if (hermesApiKey) headers.Authorization = `Bearer ${hermesApiKey}`;
          if (hermesSessionKey) headers['X-Hermes-Session-Key'] = hermesSessionKey;
          loadRemote(resolvedUrl, headers);
        } catch {
          setSuccess(src, src);
        }
      } else {
        setSuccess(src, src);
      }
    };

    if (isWindowsLocal && (window as any).electronAPI?.readLocalFile) {
      let cleanPath = src;
      if (src.startsWith('file:///')) cleanPath = src.substring(8);
      else if (src.startsWith('file://')) cleanPath = src.substring(7);
      cleanPath = cleanPath.replace(/\//g, '\\');
      (window as any).electronAPI.readLocalFile(cleanPath)
        .then((dataUrl: string) => setSuccess(src, dataUrl))
        .catch(() => resolveRemoteHermes());
    } else {
      resolveRemoteHermes();
    }
  }, [src, agentUrl, provider, hermesApiKey, hermesSessionKey]);

  if (error && !imageSrc) {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="markdown-image-error" title={src}>
        Image impossible a charger
      </a>
    );
  }

  return (
    <img
      src={imageSrc || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}
      alt={alt || 'Visualisation'}
      className="markdown-image"
      {...props}
    />
  );
};


function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

const AVATAR_PROFILES: Record<EveAvatar, {
  name: string;
  role: string;
  accent: string;
  glow: string;
  welcome: string;
  assetPath?: string;
}> = {
  eve: {
    name: 'Eve',
    role: "Unite d'assistance generale",
    accent: '#00f2ff',
    glow: 'rgba(0, 242, 255, 0.28)',
    welcome: "Bonjour ! Je suis Eve, ton assistante retro-futuriste. Comment puis-je t'aider aujourd'hui ?"
  },
  nova: {
    name: 'Nova',
    role: "Unite d'analyse et cybersecurite",
    accent: '#ff00ea',
    glow: 'rgba(255, 0, 234, 0.28)',
    welcome: "Systeme de calcul Nova operationnel. Initialisation des protocoles d'analyse. Quelle est votre requete, operateur ?",
    assetPath: 'public/avatars/retrobot-space-explorer.glb'
  },
  aegis: {
    name: 'Aegis',
    role: 'Unite de garde et diagnostic',
    accent: '#ff6a00',
    glow: 'rgba(255, 106, 0, 0.28)',
    welcome: "Aegis en ligne. Bouclier thermique stabilise et securite reseau au niveau maximal. J'attends vos instructions de controle, commandant.",
    assetPath: 'public/avatars/aegis.glb'
  }
};

const getInitialAvatarId = (): EveAvatar => {
  // Lecture synchrone localStorage pour l'état initial React (le store IPC est async)
  // L'avatar est ensuite re-synchronisé via persistRead dans useEffect si besoin
  try {
    if (typeof window === 'undefined') return 'eve';
    const savedAvatar = window.localStorage.getItem('eveflow_avatar_id') as EveAvatar | null;
    return savedAvatar && savedAvatar in AVATAR_PROFILES ? savedAvatar : 'eve';
  } catch {
    return 'eve';
  }
};

// Lecture persistante : store fichier Electron en priorité, localStorage en fallback
const readLocalStorage = (key: string): string | null => {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeLocalStorage = (key: string, value: string) => {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(key, value);
    }
  } catch { /* ignore */ }
};

// Store persistant via IPC Electron (fichier userData/userdata.json)
// Garantit la persistance indépendamment de l'origine (dev/prod)
const persistRead = async (key: string): Promise<string | null> => {
  try {
    if (window.electronAPI?.storeGet) {
      const val = await window.electronAPI.storeGet(key);
      return val !== null ? val : readLocalStorage(key);
    }
  } catch { /* ignore */ }
  return readLocalStorage(key);
};

const persistWrite = (key: string, value: string) => {
  writeLocalStorage(key, value);
  try {
    window.electronAPI?.storeSet?.(key, value);
  } catch { /* ignore */ }
};

const createWelcomeMessage = (avatarId: EveAvatar): Message => ({
  id: 'welcome',
  role: 'assistant',
  content: AVATAR_PROFILES[avatarId].welcome,
  emotion: 'neutral',
  timestamp: new Date()
});

const getHermesJobId = (job: HermesJob): string => job.id || String(job.job_id || job.name || Math.random());

const getHermesJobStatus = (job: HermesJob): string => {
  if (job.state) return String(job.state);
  if (job.status) return String(job.status);
  if (job.enabled === false) return 'paused';
  if (job.last_status) return String(job.last_status);
  return 'scheduled';
};

const formatHermesSchedule = (schedule: HermesJob['schedule']): string => {
  if (!schedule) return 'non planifie';
  if (typeof schedule === 'string') return schedule;
  return schedule.display || schedule.expr || schedule.kind || 'schedule';
};

const getHermesJobResult = (job: HermesJob): string => (
  job.result || job.last_result || job.output || job.last_output || job.error || job.last_error || ''
);

const getHermesJobTime = (job: HermesJob): string => (
  job.completed_at || job.last_run_at || job.updated_at || job.created_at || new Date().toISOString()
);

const buildRunRecordFromJob = (job: HermesJob): HermesRunRecord | null => {
  const result = getHermesJobResult(job);
  const status = getHermesJobStatus(job).toLowerCase();
  if (!result || (!['completed', 'failed', 'ok'].includes(status) && !job.completed_at && !job.last_run_at)) {
    return null;
  }

  const at = getHermesJobTime(job);
  const jobId = getHermesJobId(job);
  return {
    id: `${jobId}:${at}:${result.slice(0, 24)}`,
    jobId,
    jobName: job.name || jobId,
    status: status === 'failed' || job.error || job.last_error ? 'failed' : 'succeeded',
    result,
    at,
    read: false
  };
};

const previewText = (value: string, max = 96): string => (
  value.length > max ? `${value.slice(0, max - 1)}...` : value
);

const createDefaultCronDraft = (): HermesJobDraft => ({
  name: '',
  schedule: 'every 1h',
  prompt: '',
  deliver: 'local'
});

const HermesCockpitWindow: React.FC<{
  events: ToolEvent[];
  isWorking: boolean;
  jobs: HermesJob[];
  runs: HermesRunRecord[];
  syncState: HermesSyncState;
  syncDetail?: string;
  lastSyncAt?: string;
  draft: HermesJobDraft;
  editingJobId: string | null;
  isSaving: boolean;
  onDraftChange: (draft: HermesJobDraft) => void;
  onCreate: () => void;
  onCancelEdit: () => void;
  onStartEdit: (job: HermesJob) => void;
  onUpdate: () => void;
  onRefresh: () => void;
  onPause: (job: HermesJob) => void;
  onResume: (job: HermesJob) => void;
  onRun: (job: HermesJob) => void;
  onDelete: (job: HermesJob) => void;
  onOpenRun: (run: HermesRunRecord) => void;
  onClose: () => void;
}> = ({
  events,
  isWorking,
  jobs,
  runs,
  syncState,
  syncDetail,
  lastSyncAt,
  draft,
  editingJobId,
  isSaving,
  onDraftChange,
  onCreate,
  onCancelEdit,
  onStartEdit,
  onUpdate,
  onRefresh,
  onPause,
  onResume,
  onRun,
  onDelete,
  onOpenRun,
  onClose
}) => {
  const latestEvents = events.slice(-8).reverse();
  const [activeTab, setActiveTab] = useState<HermesCockpitTab>('tools');
  const unreadRuns = runs.filter(run => !run.read).length;
  const hasDraft = draft.name.trim() && draft.schedule.trim() && draft.prompt.trim();
  const canSaveDraft = !!hasDraft && !isSaving;

  const renderTools = () => (
    <div className="tool-screen-body hermes-cockpit-scroll">
      {latestEvents.length === 0 ? (
        <div className="tool-screen-empty">Aucun outil en cours</div>
      ) : (
        latestEvents.map((event) => (
          <div key={event.id} className={`tool-screen-line ${event.status}`}>
            <span className="tool-screen-status">{event.status.toUpperCase()}</span>
            <span className="tool-screen-text">{event.label}</span>
            {event.detail && <span className="tool-screen-detail">{event.detail}</span>}
          </div>
        ))
      )}
    </div>
  );

  const renderCrons = () => (
    <div className="hermes-cron-panel hermes-cockpit-scroll">
      <div className="hermes-cron-editor">
        <input
          className="hermes-cockpit-input"
          value={draft.name}
          onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
          placeholder="Nom du cron"
        />
        <input
          className="hermes-cockpit-input"
          value={draft.schedule}
          onChange={(e) => onDraftChange({ ...draft, schedule: e.target.value })}
          placeholder="every 1h / 0 9 * * *"
        />
        <textarea
          className="hermes-cockpit-textarea"
          value={draft.prompt}
          onChange={(e) => onDraftChange({ ...draft, prompt: e.target.value })}
          placeholder="Mission Hermes planifiee"
        />
        <div className="hermes-cron-editor-actions">
          {editingJobId && (
            <button className="hermes-icon-btn" onClick={onCancelEdit} title="Annuler l'edition">
              <X size={13} />
            </button>
          )}
          <button
            className="hermes-icon-btn primary"
            onClick={editingJobId ? onUpdate : onCreate}
            disabled={!canSaveDraft}
            title={editingJobId ? 'Sauvegarder le cron' : 'Creer le cron'}
          >
            {editingJobId ? <Save size={13} /> : <Plus size={13} />}
          </button>
        </div>
      </div>

      <div className="hermes-jobs-list">
        {jobs.length === 0 ? (
          <div className="tool-screen-empty">Aucun cron Hermes synchronise</div>
        ) : jobs.map((job) => {
          const jobId = getHermesJobId(job);
          const status = getHermesJobStatus(job);
          const paused = status === 'paused' || job.enabled === false;
          const result = getHermesJobResult(job);

          return (
            <div key={jobId} className={`hermes-job-row ${status.toLowerCase()}`}>
              <div className="hermes-job-main">
                <span className="hermes-job-name">{job.name || jobId}</span>
                <span className="hermes-job-meta">
                  {status.toUpperCase()} // {formatHermesSchedule(job.schedule)}
                </span>
                <span className="hermes-job-meta">
                  NEXT {job.next_run_at ? new Date(job.next_run_at).toLocaleString() : 'inconnu'}
                </span>
                {result && <span className="hermes-job-result">{previewText(result)}</span>}
              </div>
              <div className="hermes-job-actions">
                <button className="hermes-icon-btn" onClick={() => onRun(job)} title="Lancer maintenant"><Play size={12} /></button>
                <button className="hermes-icon-btn" onClick={() => paused ? onResume(job) : onPause(job)} title={paused ? 'Reprendre' : 'Mettre en pause'}>
                  {paused ? <Play size={12} /> : <Pause size={12} />}
                </button>
                <button className="hermes-icon-btn" onClick={() => onStartEdit(job)} title="Editer"><Edit3 size={12} /></button>
                <button className="hermes-icon-btn danger" onClick={() => onDelete(job)} title="Supprimer"><Trash2 size={12} /></button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderHistory = () => (
    <div className="hermes-history-list hermes-cockpit-scroll">
      {runs.length === 0 ? (
        <div className="tool-screen-empty">Aucun resultat de cron en cache</div>
      ) : runs.slice(0, 24).map((run) => (
        <button key={run.id} className={`hermes-run-row ${run.status} ${run.read ? 'read' : 'unread'}`} onClick={() => onOpenRun(run)}>
          <span className="hermes-run-status">{run.status === 'failed' ? 'ERR' : 'OK'}</span>
          <span className="hermes-run-content">
            <strong>{run.jobName}</strong>
            <span>{previewText(run.result, 120)}</span>
          </span>
          <span className="hermes-run-time">{new Date(run.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className={`tool-screen-window hermes-cockpit-window ${isWorking || syncState === 'syncing' ? 'active' : ''}`}>
      <div className="tool-screen-header">
        <span className={`tool-screen-led ${syncState}`} />
        <span>COCKPIT HERMES</span>
        <div className="hermes-header-actions">
          <button className="hermes-icon-btn" onClick={onRefresh} title="Synchroniser Hermes">
            <RefreshCw size={12} />
          </button>
          <button className="hermes-icon-btn" onClick={onClose} title="Refermer le cockpit Hermes">
            <X size={12} />
          </button>
        </div>
      </div>
      <div className="hermes-cockpit-status">
        {syncState === 'offline' ? <WifiOff size={12} /> : <CheckCircle2 size={12} />}
        <span>{syncState === 'offline' ? 'HERMES OFFLINE' : syncState === 'syncing' ? 'SYNC...' : 'HERMES ONLINE'}</span>
        {lastSyncAt && <span>{new Date(lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
      </div>
      {syncState === 'offline' && syncDetail && <div className="hermes-cockpit-error">{previewText(syncDetail, 120)}</div>}
      <div className="hermes-cockpit-tabs">
        <button className={activeTab === 'tools' ? 'active' : ''} onClick={() => setActiveTab('tools')} title="Outils Hermes"><Wrench size={13} /></button>
        <button className={activeTab === 'crons' ? 'active' : ''} onClick={() => setActiveTab('crons')} title="Crons Hermes"><CalendarClock size={13} /></button>
        <button className={activeTab === 'history' ? 'active' : ''} onClick={() => setActiveTab('history')} title="Historique des crons">
          <History size={13} />
          {unreadRuns > 0 && <span className="hermes-tab-badge">{unreadRuns}</span>}
        </button>
      </div>
      {activeTab === 'tools' && renderTools()}
      {activeTab === 'crons' && renderCrons()}
      {activeTab === 'history' && renderHistory()}
    </div>
  );
};

export const App: React.FC = () => {
  // --- ÉTATS ---
  const [avatarId, setAvatarId] = useState<EveAvatar>(() => getInitialAvatarId());
  const [messages, setMessages] = useState<Message[]>(() => [createWelcomeMessage(avatarId)]);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [hermesJobs, setHermesJobs] = useState<HermesJob[]>([]);
  const [hermesRunHistory, setHermesRunHistory] = useState<HermesRunRecord[]>([]);
  const [hermesLastSyncAt, setHermesLastSyncAt] = useState<string>('');
  const [hermesSyncState, setHermesSyncState] = useState<HermesSyncState>('idle');
  const [hermesSyncDetail, setHermesSyncDetail] = useState<string>('');
  const [hermesCronDraft, setHermesCronDraft] = useState<HermesJobDraft>(() => createDefaultCronDraft());
  const [editingHermesJobId, setEditingHermesJobId] = useState<string | null>(null);
  const [isSavingHermesCron, setIsSavingHermesCron] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentlyPlayingMsgId, setCurrentlyPlayingMsgId] = useState<string | null>(null);

  // États de télémétrie réelle (dynamique et mesurée)
  const [realFps, setRealFps] = useState(60);
  const [hostname, setHostname] = useState('UNRAID_HERMES');
  const [cpuFreq, setCpuFreq] = useState(2400);
  const [cpuTemp, setCpuTemp] = useState(36.5);

  // États pour la gestion des pièces jointes (Fichiers / Images)
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Gestion de la sélection des fichiers joints (Zéro Trust validation)
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles) return;

    const filesArray = Array.from(selectedFiles);
    let processedCount = 0;

    const checkReset = () => {
      processedCount++;
      if (processedCount === filesArray.length && fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    };

    filesArray.forEach(file => {
      const MAX_FILE_SIZE = 10 * 1024 * 1024;
      if (file.size > MAX_FILE_SIZE) {
        setErrorMessage(`Le fichier ${file.name} dépasse la limite autorisée de 10 Mo.`);
        checkReset();
        return;
      }

      // Déduction robuste du type MIME à partir de l'extension de fichier si l'OS renvoie une valeur vide
      let detectedType = file.type;
      const ext = file.name.split('.').pop()?.toLowerCase();
      const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
      if (ext && imageExtensions.includes(ext) && !detectedType.startsWith('image/')) {
        detectedType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      }

      const reader = new FileReader();
      reader.onload = async (event) => {
        const dataUrl = event.target?.result as string;
        if (dataUrl) {
          try {
            let finalDataUrl = dataUrl;
            let finalSize = file.size;

            // Compresser l'image à la volée s'il s'agit d'un format d'image supporté
            if (detectedType.startsWith('image/')) {
              console.log(`[EveFlow] Compression à la volée de ${file.name}... Taille originale: ${(file.size / 1024).toFixed(1)} KB`);
              const compressed = await compressImage(dataUrl, detectedType);
              finalDataUrl = compressed.dataUrl;
              finalSize = compressed.size;
              console.log(`[EveFlow] Compression terminée pour ${file.name}. Nouvelle taille: ${(finalSize / 1024).toFixed(1)} KB`);
            }

            setAttachments(prev => [...prev, {
              name: file.name,
              type: detectedType,
              dataUrl: finalDataUrl,
              size: finalSize
            }]);
          } catch (compressErr) {
            console.error(`[EveFlow] Échec de compression pour ${file.name}, utilisation de la version originale:`, compressErr);
            setAttachments(prev => [...prev, {
              name: file.name,
              type: detectedType,
              dataUrl: dataUrl,
              size: file.size
            }]);
          }
        }
      };
      reader.onloadend = () => {
        checkReset();
      };
      reader.onerror = (err) => {
        console.error(`Erreur de lecture du fichier ${file.name}:`, err);
        checkReset();
      };
      reader.readAsDataURL(file);
    });
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // Moteur 3D & Audio
  const [currentEmotion, setCurrentEmotion] = useState<EveEmotion>('neutral');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isMuted] = useState(false);

  // Fenêtre & Navigation
  const [isFloatingMode, setIsFloatingMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHermesCockpit, setShowHermesCockpit] = useState(false);

  // Paramètres d'Agents et de Voix (sauvegardés localement)
  const [agentConfig, setAgentConfig] = useState<AgentConfig>({
    provider: 'ollama',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'llama3',
    hermesUrl: 'http://127.0.0.1:8642/v1',
    hermesModel: 'hermes-agent',
    hermesApiKey: '',
    hermesSessionKey: 'eveflow-user-session'
  });

  const [availableVoices, setAvailableVoices] = useState<any[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>('');
  const [ttsRate, setTtsRate] = useState<number>(1.15);
  const [sttLang, setSttLang] = useState<string>('fr-FR');
  const [ttsProvider, setTtsProvider] = useState<'system' | 'google-free'>('google-free');
  const activeAvatar = AVATAR_PROFILES[avatarId];
  const hermesUnreadRuns = hermesRunHistory.filter(run => !run.read).length;
  const hermesSyncLabel = hermesSyncState === 'offline'
    ? 'Hermes offline'
    : hermesSyncState === 'syncing'
      ? 'Hermes sync'
      : 'Hermes OK';
  const pushToolEvent = (event: Omit<ToolEvent, 'id' | 'ts'>) => {
    setToolEvents(prev => [
      ...prev.slice(-11),
      {
        ...event,
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ts: Date.now()
      }
    ]);
  };



  // Session Hermes persistante — garantit la continuité mémoire/skills entre redémarrages
  const persistHermesCronCache = (cache: HermesCronCache) => {
    persistWrite('eveflow_hermes_cron_cache', JSON.stringify(cache));
  };

  const mergeHermesJobs = (jobs: HermesJob[], syncedAt: string) => {
    setHermesJobs(jobs);
    setHermesLastSyncAt(syncedAt);
    setHermesRunHistory(prev => {
      const previousById = new Map(prev.map(run => [run.id, run]));
      const incoming = jobs
        .map(buildRunRecordFromJob)
        .filter((run): run is HermesRunRecord => !!run)
        .map(run => ({ ...run, read: previousById.get(run.id)?.read ?? false }));
      const merged = [...incoming, ...prev.filter(run => !incoming.some(next => next.id === run.id))]
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, 80);

      persistHermesCronCache({ jobs, runs: merged, lastSyncAt: syncedAt });

      const newRuns = incoming.filter(run => !previousById.has(run.id));
      if (newRuns.length > 0) {
        const newest = newRuns[0];
        setMessages(messagesPrev => [...messagesPrev, {
          id: newest.id,
          role: 'assistant',
          content: newest.result,
          source: 'cron',
          timestamp: new Date(newest.at)
        }]);
        setCurrentEmotion(newest.status === 'failed' ? 'sad' : 'happy');
        if (!isMuted && audioServiceRef.current && newest.status === 'succeeded') {
          audioServiceRef.current.speak(newest.result, selectedVoice, ttsRate, 1.1, ttsProvider);
        }
      }

      return merged;
    });
  };

  const refreshHermesJobs = async () => {
    if (!pollingServiceRef.current || agentConfig.provider !== 'hermes') return;
    try {
      setHermesSyncState('syncing');
      const snapshot = await pollingServiceRef.current.refresh();
      mergeHermesJobs(snapshot.jobs, snapshot.syncedAt);
      setHermesSyncState('online');
      setHermesSyncDetail('');
    } catch (e: any) {
      setHermesSyncState('offline');
      setHermesSyncDetail(e?.message || String(e));
    }
  };

  const finishHermesCronMutation = async (successLabel: string) => {
    pushToolEvent({ label: successLabel, status: 'done' });
    await refreshHermesJobs();
  };

  const handleCreateHermesCron = async () => {
    if (!pollingServiceRef.current) return;
    setIsSavingHermesCron(true);
    pushToolEvent({ label: 'Creation cron Hermes', status: 'running', detail: hermesCronDraft.schedule });
    try {
      await pollingServiceRef.current.createJob(hermesCronDraft);
      setHermesCronDraft(createDefaultCronDraft());
      await finishHermesCronMutation('Cron Hermes cree');
    } catch (e: any) {
      const message = e?.message || String(e);
      setErrorMessage(`Cron Hermes: ${message}`);
      pushToolEvent({ label: 'Creation cron Hermes', status: 'error', detail: message });
    } finally {
      setIsSavingHermesCron(false);
    }
  };

  const handleStartEditHermesCron = (job: HermesJob) => {
    setEditingHermesJobId(getHermesJobId(job));
    setHermesCronDraft({
      name: job.name || getHermesJobId(job),
      schedule: formatHermesSchedule(job.schedule),
      prompt: job.prompt || '',
      deliver: typeof job.deliver === 'string' ? job.deliver : 'local'
    });
  };

  const handleCancelEditHermesCron = () => {
    setEditingHermesJobId(null);
    setHermesCronDraft(createDefaultCronDraft());
  };

  const handleUpdateHermesCron = async () => {
    if (!pollingServiceRef.current || !editingHermesJobId) return;
    setIsSavingHermesCron(true);
    pushToolEvent({ label: 'Mise a jour cron Hermes', status: 'running', detail: editingHermesJobId });
    try {
      await pollingServiceRef.current.updateJob(editingHermesJobId, hermesCronDraft);
      handleCancelEditHermesCron();
      await finishHermesCronMutation('Cron Hermes mis a jour');
    } catch (e: any) {
      const message = e?.message || String(e);
      setErrorMessage(`Cron Hermes: ${message}`);
      pushToolEvent({ label: 'Mise a jour cron Hermes', status: 'error', detail: message });
    } finally {
      setIsSavingHermesCron(false);
    }
  };

  const runHermesCronAction = async (job: HermesJob, action: 'pause' | 'resume' | 'run' | 'delete') => {
    if (!pollingServiceRef.current) return;
    const jobId = getHermesJobId(job);
    const labels = {
      pause: 'Pause cron Hermes',
      resume: 'Reprise cron Hermes',
      run: 'Execution immediate Hermes',
      delete: 'Suppression cron Hermes'
    };
    pushToolEvent({ label: labels[action], status: 'running', detail: job.name || jobId });
    try {
      if (action === 'pause') await pollingServiceRef.current.pauseJob(jobId);
      if (action === 'resume') await pollingServiceRef.current.resumeJob(jobId);
      if (action === 'run') await pollingServiceRef.current.runJob(jobId);
      if (action === 'delete') await pollingServiceRef.current.deleteJob(jobId);
      await finishHermesCronMutation(`${labels[action]} OK`);
    } catch (e: any) {
      const message = e?.message || String(e);
      setErrorMessage(`Cron Hermes: ${message}`);
      pushToolEvent({ label: labels[action], status: 'error', detail: message });
    }
  };

  const openHermesRunInChat = (run: HermesRunRecord) => {
    setHermesRunHistory(prev => {
      const updated = prev.map(item => item.id === run.id ? { ...item, read: true } : item);
      persistHermesCronCache({ jobs: hermesJobs, runs: updated, lastSyncAt: hermesLastSyncAt });
      return updated;
    });
    setMessages(prev => [...prev, {
      id: `cron-open-${run.id}`,
      role: 'assistant',
      content: run.result,
      source: 'cron',
      timestamp: new Date(run.at)
    }]);
  };

  const [hermesSessionId, setHermesSessionId] = useState<string>('');

  // Références de services
  const audioServiceRef = useRef<AudioService | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollingServiceRef = useRef<PollingService | null>(null);

  // AppCallbacks for tools
  const buildCallbacks = (): AppCallbacks => ({
    setEmotion: (emotion) => setCurrentEmotion(emotion as EveEmotion),
    getStatus: () => ({
      provider: agentConfig.provider,
      avatar: avatarId,
      emotion: currentEmotion,
      isSpeaking,
      isMuted,
      messageCount: messages.length
    }),
    getHistory: (n) => messages.slice(-n).map(m => ({ role: m.role, content: m.content })),
    speak: (text) => {
      if (!isMuted && audioServiceRef.current) {
        setIsSpeaking(true);
        audioServiceRef.current.speak(text, selectedVoice, ttsRate, 1.1, ttsProvider).then(() => setIsSpeaking(false));
      }
    }
  });

  // --- TÉLÉMÉTRIE RÉELLE SYSTÈME ET MESURE DU FPS ---
  useEffect(() => {
    // 1. Calcul du FPS de rendu client (via requestAnimationFrame)
    let frameCount = 0;
    let lastTime = performance.now();
    let animFrameId: number;

    const fpsLoop = () => {
      frameCount++;
      const now = performance.now();
      if (now - lastTime >= 1000) {
        setRealFps(Math.round((frameCount * 1000) / (now - lastTime)));
        frameCount = 0;
        lastTime = now;
      }
      animFrameId = requestAnimationFrame(fpsLoop);
    };
    animFrameId = requestAnimationFrame(fpsLoop);

    // 2. Récupération asynchrone des métriques système réelles (IPC toutes les 2 secondes)
    const fetchMetrics = () => {
      if ((window as any).electronAPI?.getSystemMetrics) {
        (window as any).electronAPI.getSystemMetrics()
          .then((metrics: { hostname: string; cpuFreq: number; cpuTemp: number }) => {
            if (metrics) {
              if (metrics.hostname) setHostname(metrics.hostname);
              if (metrics.cpuFreq) setCpuFreq(metrics.cpuFreq);
              if (metrics.cpuTemp) setCpuTemp(metrics.cpuTemp);
            }
          })
          .catch((err: any) => {
            console.warn("[Telemetry] Échec de la récupération des métriques système:", err.message);
          });
      }
    };

    // Premier appel immédiat, puis polling régulier
    fetchMetrics();
    const intervalId = setInterval(fetchMetrics, 2000);

    return () => {
      cancelAnimationFrame(animFrameId);
      clearInterval(intervalId);
    };
  }, []);

  // --- INITIALISATION ---
  useEffect(() => {
    const service = new AudioService();
    audioServiceRef.current = service;

    // Charger la configuration depuis le store persistant (IPC fichier > localStorage)
    persistRead('eveflow_agent_config').then(savedConfig => {
      if (savedConfig) {
        try {
          const parsed = JSON.parse(savedConfig);
          // Si la clé de session Hermes n'existe pas encore dans la config sauvegardée, on met une valeur par défaut
          if (!parsed.hermesSessionKey) {
            parsed.hermesSessionKey = 'eveflow-user-session';
          }
          setAgentConfig(prev => ({ ...prev, ...parsed }));
        } catch (e) {
          console.error("Erreur de chargement de la configuration", e);
        }
      }
    });

    persistRead('eveflow_voice').then(savedVoice => {
      if (savedVoice) setSelectedVoice(savedVoice);
    });

    persistRead('eveflow_tts_provider').then(savedProvider => {
      if (savedProvider === 'system' || savedProvider === 'google-free') {
        setTtsProvider(savedProvider as 'system' | 'google-free');
      }
    });

    persistRead('eveflow_avatar_id').then(savedAvatar => {
      if (savedAvatar && savedAvatar in AVATAR_PROFILES) {
        setAvatarId(savedAvatar as EveAvatar);
      }
    });

    persistRead('eveflow_hermes_session_id').then(savedId => {
      if (savedId) {
        setHermesSessionId(savedId);
      } else {
        const newId = generateUUID();
        setHermesSessionId(newId);
        persistWrite('eveflow_hermes_session_id', newId);
      }
    });

    // Charger les voix système
    persistRead('eveflow_hermes_cron_cache').then(savedCache => {
      if (!savedCache) return;
      try {
        const parsed = JSON.parse(savedCache) as HermesCronCache;
        if (Array.isArray(parsed.jobs)) setHermesJobs(parsed.jobs);
        if (Array.isArray(parsed.runs)) setHermesRunHistory(parsed.runs);
        if (parsed.lastSyncAt) setHermesLastSyncAt(parsed.lastSyncAt);
      } catch (e) {
        console.warn('Cache Hermes crons illisible', e);
      }
    });

    const loadVoices = () => {
      const voices = service.getVoices();
      setAvailableVoices(voices);
      persistRead('eveflow_voice').then(saved => {
        if (!saved && voices.length > 0) {
          const frVoice = voices.find(v => v.lang.startsWith('fr'));
          if (frVoice) setSelectedVoice(frVoice.name);
        }
      });
    };

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;

    // Écouter le mode de fenêtre Electron
    if (window.electronAPI) {
      const unsubscribe = window.electronAPI.onWindowModeChanged((mode) => {
        setIsFloatingMode(mode === 'floating');
        if (mode === 'floating') {
          setShowSettings(false);
        }
      });
      return unsubscribe;
    }

    return undefined;
  }, []);

  // Défilement automatique
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, showSettings]);



  // Polling Hermes Jobs
  useEffect(() => {
    if (agentConfig.provider !== 'hermes') {
      pollingServiceRef.current?.stop();
      setHermesSyncState('idle');
      return;
    }

    if (!pollingServiceRef.current) {
      pollingServiceRef.current = new PollingService(30000);
    }

    pollingServiceRef.current.start(
      agentConfig.hermesUrl,
      agentConfig.hermesApiKey,
      (snapshot) => {
        mergeHermesJobs(snapshot.jobs, snapshot.syncedAt);
        setHermesSyncDetail('');
      },
      (status, detail) => {
        setHermesSyncState(status);
        setHermesSyncDetail(detail || '');
      }
    );

    return () => pollingServiceRef.current?.stop();
  }, [agentConfig.provider, agentConfig.hermesUrl, agentConfig.hermesApiKey, isMuted, selectedVoice, ttsRate, ttsProvider]);

  // Webhook Events — mirrors all Hermes conversations (Telegram, etc.) into the chat
  useEffect(() => {
    if (window.electronAPI && window.electronAPI.onHermesPush) {
      const unsubscribe = window.electronAPI.onHermesPush((event: any) => {
        // Events are already normalized by main.js into { type, role, text, source }
        if (event.type === 'message' && event.text) {
          const role = event.role === 'user' ? 'user' : 'assistant';
          const source = event.source || 'webhook';
          setMessages(prev => [...prev, {
            id: Math.random().toString(),
            role,
            content: event.text,
            images: Array.isArray(event.images) ? event.images : undefined,
            source: source as Message['source'],
            timestamp: new Date()
          }]);
          if (role === 'assistant') {
            setCurrentEmotion('happy');
            if (!isMuted && audioServiceRef.current) {
              audioServiceRef.current.speak(event.text, selectedVoice, ttsRate, 1.1, ttsProvider)
                .then(() => setIsSpeaking(false))
                .catch(() => {});
              setIsSpeaking(true);
            }
          }
        }
      });
      return unsubscribe;
    }
    return undefined;
  }, [isMuted, selectedVoice, ttsRate, ttsProvider]);

  // --- ACTIONS ---
  const saveConfig = (newConfig: AgentConfig) => {
    setAgentConfig(newConfig);
    persistWrite('eveflow_agent_config', JSON.stringify(newConfig));
  };



  const handleWindowControl = (action: 'minimize' | 'maximize' | 'close') => {
    if (window.electronAPI) {
      window.electronAPI.windowControl(action);
    }
  };

  const toggleWindowMode = () => {
    if (window.electronAPI) {
      const targetMode = isFloatingMode ? 'normal' : 'floating';
      window.electronAPI.setWindowMode(targetMode);
    } else {
      setIsFloatingMode(!isFloatingMode);
    }
  };

  const toggleHermesCockpit = () => {
    const nextOpen = !showHermesCockpit;
    setShowHermesCockpit(nextOpen);
    window.electronAPI?.setCockpitMode?.(nextOpen);
  };

  const closeHermesCockpit = () => {
    setShowHermesCockpit(false);
    window.electronAPI?.setCockpitMode?.(false);
  };

  const handleSendMessage = async (text: string) => {
    if (!text.trim() && attachments.length === 0) return;
    if (isSending) return;

    // Arrêter immédiatement toute lecture vocale en cours
    if (audioServiceRef.current) {
      audioServiceRef.current.stopSpeaking();
    }
    setIsSpeaking(false);

    setErrorMessage(null);
    setIsSending(true);
    pushToolEvent({
      label: 'Nouvelle execution Hermes',
      detail: agentConfig.provider,
      status: 'running'
    });

    // Séparer les attachements : images vs documents texte
    const images = attachments.filter(a => a.type.startsWith('image/')).map(a => a.dataUrl);
    const textDocs = attachments.filter(a => !a.type.startsWith('image/'));

    // 1. Construire le prompt textuel final (si documents texte, on extrait leur contenu)
    let finalPrompt = text;
    let textDocsContext = '';
    textDocs.forEach(doc => {
      try {
        const base64Content = doc.dataUrl.split(',')[1];
        // Décoder le base64 en UTF-8 proprement
        const textContent = decodeURIComponent(
          atob(base64Content)
            .split('')
            .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
        );
        const ext = doc.name.split('.').pop() || 'txt';
        textDocsContext += `\n\n[Fichier joint : ${doc.name}]\n\`\`\`${ext}\n${textContent}\n\`\`\`\n[Fin du fichier joint : ${doc.name}]`;
      } catch (err: any) {
        console.error(`Échec du décodage du document ${doc.name}:`, err.message);
      }
    });

    if (textDocsContext) {
      finalPrompt = textDocsContext + "\n\n" + (text.trim() || "Analyse le document ci-dessus.");
    }

    // 2. Construire le contenu à afficher localement dans le chat pour l'utilisateur
    let displayContent = text;
    attachments.forEach(att => {
      if (!att.type.startsWith('image/')) {
        displayContent += `\n\n📄 **[Fichier joint : ${att.name}]**`;
      }
    });

    const userMessage: Message = {
      id: Math.random().toString(),
      role: 'user',
      content: displayContent || "Analyse des documents joints.",
      images: images.length > 0 ? images : undefined,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setAttachments([]); // Vider les pièces jointes après l'envoi
    setCurrentEmotion('thinking');

    try {
      const chatHistory = messages
        .slice(-8)
        .map(m => ({ role: m.role, content: m.content }));

      // Create a placeholder message for streaming
      const assistantId = Math.random().toString();
      setMessages(prev => [...prev, {
        id: assistantId,
        role: 'assistant',
        content: '',
        emotion: 'thinking',
        timestamp: new Date()
      }]);

      let fullReply = '';
      // Batch token updates via rAF — évite N re-renders par seconde pendant le streaming
      let pendingContent = '';
      let rafHandle: number | null = null;
      const flushTokens = () => {
        rafHandle = null;
        const snapshot = pendingContent;
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: snapshot } : m
        ));
      };

      // Index de suivi de lecture vocale pour le streaming en temps réel
      let lastSpokenIndex = 0;

      const reply = await AgentService.sendMessage(
        finalPrompt,
        chatHistory,
        agentConfig,
        avatarId,
        buildCallbacks(),
        // onToken — UI rAF (mise à jour fluide en temps réel)
        (token) => {
          fullReply += token;
          pendingContent = fullReply;
          if (rafHandle === null) rafHandle = requestAnimationFrame(flushTokens);

          // Synthèse vocale fluide phrase par phrase en temps réel (streaming)
          if (!isMuted && audioServiceRef.current) {
            const textToParse = fullReply.substring(lastSpokenIndex);
            // Regex robuste pour isoler les phrases se terminant par un point, exclamation, interrogation ou saut de ligne
            const sentenceRegex = /[^.!?\n\r]+[.!?\n\r]+/g;
            let match;
            let lastMatchEnd = 0;
            while ((match = sentenceRegex.exec(textToParse)) !== null) {
              const sentence = match[0].trim();
              // Ignorer les tokens MEDIA: pour ne pas les lire à voix haute (ex: MEDIA:/tmp/cat.jpg)
              if (sentence && !/^MEDIA:\s*\S+$/.test(sentence)) {
                setIsSpeaking(true);
                audioServiceRef.current.queueSentence(sentence, selectedVoice, ttsRate, 1.1, ttsProvider);
              }
              lastMatchEnd = match.index + match[0].length;
            }
            if (lastMatchEnd > 0) {
              lastSpokenIndex += lastMatchEnd;
            }
          }
        },
        // onToolCall
        (toolName, detail, status = 'running') => {
          pushToolEvent({
            label: toolName,
            detail: detail || 'progression Hermes',
            status
          });
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: m.content + `\n\n> ⚙️ *${toolName}*\n\n` } : m
          ));
        },
        hermesSessionId || undefined,
        (newSessionId) => {
          setHermesSessionId(newSessionId);
          persistWrite('eveflow_hermes_session_id', newSessionId);
        },
        images
      );
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);

      const deducedEmotion = EmotionService.analyzeSentiment(reply);
      setCurrentEmotion(deducedEmotion);
      pushToolEvent({
        label: 'Reponse finalisee',
        detail: `${reply.length} caracteres`,
        status: 'done'
      });

      // Mettre à jour le message final dans le chat
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: reply, emotion: deducedEmotion } : m
      ));

      // Diction de la portion restante finale non encore prononcée
      if (!isMuted && audioServiceRef.current) {
        const remainingText = reply.substring(lastSpokenIndex).trim();
        if (remainingText) {
          setIsSpeaking(true);
          audioServiceRef.current.queueSentence(remainingText, selectedVoice, ttsRate, 1.1, ttsProvider);
        }
        
        // Attendre la fin complète de la file d'écoute pour arrêter l'animation d'élocution (isSpeaking)
        (async () => {
          while (audioServiceRef.current?.isSpeakingActive) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          setIsSpeaking(false);
          setCurrentEmotion('neutral');
        })().catch(() => {});
      }

    } catch (e: any) {
      setErrorMessage(e.message || "Une erreur s'est produite.");
      setCurrentEmotion('sad');
      pushToolEvent({
        label: 'Execution interrompue',
        detail: e.message || 'erreur agent',
        status: 'error'
      });
      const errorMessageObj: Message = {
        id: Math.random().toString(),
        role: 'assistant',
        content: `Erreur : Impossible de contacter l'agent. Veuillez vérifier votre connexion et les paramètres.`,
        emotion: 'sad',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessageObj]);
    } finally {
      setIsSending(false);
    }
  };

  const handleStartVocalRecord = () => {
    if (!audioServiceRef.current) return;

    audioServiceRef.current.stopSpeaking();
    setIsSpeaking(false);

    audioServiceRef.current.startListening(
      (text) => {
        handleSendMessage(text);
      },
      () => {
        setIsListening(true);
        setCurrentEmotion('thinking');
      },
      () => {
        setIsListening(false);
      },
      (err) => {
        setIsListening(false);
        console.error(err);
      },
      sttLang
    );
  };

  const handleStopListening = () => {
    if (audioServiceRef.current) {
      audioServiceRef.current.stopListening();
    }
  };

  const handleStopTTS = () => {
    if (audioServiceRef.current) {
      audioServiceRef.current.flushQueue();
      audioServiceRef.current.stopSpeaking();
    }
    setIsSpeaking(false);
    setCurrentEmotion('neutral');
  };





  const handlePlayLongMessage = (messageId: string, content: string) => {
    if (!audioServiceRef.current) return;

    if (currentlyPlayingMsgId === messageId) {
      // Arrêt si on reclique sur le bouton de lecture en cours
      audioServiceRef.current.flushQueue();
      audioServiceRef.current.stopSpeaking();
      setCurrentlyPlayingMsgId(null);
      setIsSpeaking(false);
      setCurrentEmotion('neutral');
    } else {
      // Arrêt de toute lecture en cours et démarrage de la lecture intégrale
      audioServiceRef.current.flushQueue();
      audioServiceRef.current.stopSpeaking();
      
      setCurrentlyPlayingMsgId(messageId);
      setIsSpeaking(true);
      
      const deducedEmotion = EmotionService.analyzeSentiment(content);
      setCurrentEmotion(deducedEmotion);

      audioServiceRef.current.speak(content, selectedVoice, ttsRate, 1.1, ttsProvider)
        .then(() => {
          setCurrentlyPlayingMsgId(null);
          setIsSpeaking(false);
          setCurrentEmotion('neutral');
        })
        .catch(err => {
          console.error("Long message audio speak error:", err);
          setCurrentlyPlayingMsgId(null);
          setIsSpeaking(false);
          setCurrentEmotion('neutral');
        });
    }
  };

  return (
    <div className={`app-container ${isFloatingMode ? 'transparent-bg' : ''}`}>
      {/* 1. APP HEADER */}
      {!isFloatingMode && (
        <header className="app-header" style={{ WebkitAppRegion: 'drag' } as any}>
          <div className="flex-row" style={{ display: 'flex', alignItems: 'center', gap: '6px', WebkitAppRegion: 'no-drag' } as any}>
            <span className="logo-dot" />
            <span className="logo-text">EVEFLOW</span>
          </div>

          {agentConfig.provider === 'hermes' && (
            <div className="header-hermes-status" style={{
              color: hermesSyncState === 'offline' ? '#ef4444' : '#10b981',
              borderColor: hermesSyncState === 'offline' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(0, 242, 255, 0.2)',
              WebkitAppRegion: 'no-drag'
            } as any}>
              <span className="status-dot" style={{
                backgroundColor: hermesSyncState === 'offline' ? '#ef4444' : '#10b981',
                boxShadow: hermesSyncState === 'offline' ? '0 0 10px #ef4444' : '0 0 10px #10b981'
              }} />
              <span>{hermesSyncState === 'offline' ? 'Hermes OFFLINE' : 'Hermes OK'}</span>
            </div>
          )}

          <div className="window-controls" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <button
              className="control-btn"
              onClick={() => setShowSettings(!showSettings)}
              title="Configuration globale"
            >
              <Settings size={16} />
            </button>
            {window.electronAPI && (
              <>
                <button
                  className="control-btn"
                  onClick={() => handleWindowControl('minimize')}
                  title="Réduire"
                >
                  <Minimize2 size={16} />
                </button>
                <button
                  className="control-btn close"
                  onClick={() => handleWindowControl('close')}
                  title="Fermer"
                >
                  <X size={16} />
                </button>
              </>
            )}
          </div>
        </header>
      )}

      {/* 2. MAIN LAYOUT CONTAINER */}
      <div className="app-main">
        {/* CHAT SECTION (De gauche) */}
        {!isFloatingMode && !showSettings && (
          <section className="chat-section">
            {agentConfig.provider === 'hermes' && (
              <div className="chat-status-bar">
                <div className={`status-item ${hermesSyncState === 'offline' ? 'red' : 'green'}`}>
                  {hermesSyncState === 'offline' ? <WifiOff size={14} /> : <CheckCircle2 size={14} />}
                  <span>{hermesSyncLabel}</span>
                </div>
                <span className="status-separator">|</span>
                <div className="status-item blue">
                  <BriefcaseBusiness size={14} />
                  <span>{hermesJobs.length} job{hermesJobs.length > 1 ? 's' : ''}</span>
                </div>
                <span className="status-separator">|</span>
                <div className={`status-item ${hermesUnreadRuns > 0 ? 'red' : 'blue'}`}>
                  <AlertTriangle size={14} />
                  <span>{hermesUnreadRuns} alerte{hermesUnreadRuns > 1 ? 's' : ''}</span>
                </div>
                <button
                  className="cockpit-btn"
                  onClick={toggleHermesCockpit}
                  title={showHermesCockpit ? 'Refermer le cockpit Hermes' : 'Ouvrir le cockpit Hermes'}
                >
                  <span>Cockpit</span>
                  <ChevronUp size={12} className={`chevron ${showHermesCockpit ? 'rotated' : ''}`} />
                </button>
              </div>
            )}
            <div className="messages-container">
              {messages.map((msg) => {
                const isUser = msg.role === 'user';
                
                const markdownAndMedia = (
                  <div className="markdown-content">
                    <ReactMarkdown 
                      remarkPlugins={[remarkGfm]}
                      components={{
                        img: ({ node, ...props }) => (
                          <ResilientImage 
                            src={props.src || ''} 
                            alt={props.alt} 
                            agentUrl={agentConfig.hermesUrl} 
                            provider={agentConfig.provider}
                            hermesApiKey={agentConfig.hermesApiKey}
                            hermesSessionKey={agentConfig.hermesSessionKey}
                          />
                        ),
                        a: ({ node, ...props }) => {
                          const isLocal = props.href?.startsWith('file://') || /^[a-zA-Z]:/.test(props.href || '');
                          if (isLocal) {
                            return (
                              <a 
                                href="#" 
                                onClick={(e) => {
                                  e.preventDefault();
                                  let cleanPath = props.href || '';
                                  if (cleanPath.startsWith('file:///')) {
                                    cleanPath = cleanPath.substring(8);
                                  } else if (cleanPath.startsWith('file://')) {
                                    cleanPath = cleanPath.substring(7);
                                  }
                                  cleanPath = cleanPath.replace(/\//g, '\\');
                                  (window as any).electronAPI?.openLocalFile?.(cleanPath)
                                    .catch((err: any) => console.error("Impossible d'ouvrir le fichier :", err));
                                }}
                                className="markdown-link-local"
                                style={{ color: 'var(--text-neon)', textDecoration: 'underline', fontWeight: 'bold' }}
                                title={`Ouvrir le fichier local : ${props.href}`}
                              >
                                {props.children}
                              </a>
                            );
                          }
                          return <a href={props.href} target="_blank" rel="noopener noreferrer">{props.children}</a>;
                        }
                      }}
                    >
                      {preprocessMessageContent(msg.content)}
                    </ReactMarkdown>

                    {msg.images && msg.images.length > 0 && (
                      <div className="message-images-gallery" style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        {msg.images.map((imgUrl, i) => (
                          <ResilientImage 
                            key={i} 
                            src={imgUrl} 
                            alt="Image jointe" 
                            agentUrl={agentConfig.hermesUrl} 
                            provider={agentConfig.provider}
                            hermesApiKey={agentConfig.hermesApiKey}
                            hermesSessionKey={agentConfig.hermesSessionKey}
                          />
                        ))}
                      </div>
                    )}

                    {!isUser && msg.content.length >= TTS_LONG_TEXT_THRESHOLD && (
                      <div className="long-message-audio-controls">
                        <button
                          onClick={() => handlePlayLongMessage(msg.id, msg.content)}
                          className={`audio-control-btn ${currentlyPlayingMsgId === msg.id ? 'playing' : ''}`}
                          title={currentlyPlayingMsgId === msg.id ? "Arrêter la lecture vocale complète" : "Écouter la lecture vocale complète"}
                        >
                          {currentlyPlayingMsgId === msg.id ? (
                            <>
                              <VolumeX style={{ width: '13px', height: '13px' }} />
                              <span>[ STOP_AUDIO ]</span>
                            </>
                          ) : (
                            <>
                              <Volume2 style={{ width: '13px', height: '13px' }} />
                              <span>[ LIRE_MESSAGE_COMPLET ]</span>
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                );

                if (isUser) {
                  return (
                    <div key={msg.id} className="message-row user">
                      <div className="message-bubble user">
                        {markdownAndMedia}
                        <div className="message-time">
                          <span>{msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          <span className="double-check">✓✓</span>
                        </div>
                      </div>
                    </div>
                  );
                } else {
                  return (
                    <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
                      <div className="transmission-tag">
                        # [TRANSMISSION: {activeAvatar.name.toUpperCase()} // TELEMETRY: {msg.emotion?.toUpperCase() || 'NEUTRAL'}]
                        {msg.source && msg.source !== 'eveflow' && (
                          <span style={{ marginLeft: '8px', fontSize: '9px', padding: '1px 6px', backgroundColor: 'rgba(0,212,245,0.15)', border: '1px solid rgba(0,212,245,0.35)', borderRadius: '10px', color: 'var(--accent-cyan)', fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase' }}>
                            {msg.source}
                          </span>
                        )}
                      </div>
                      <div className="message-row assistant">
                        <div className="avatar-wrapper">
                          <img src="/avatars/eve-round.png" alt={activeAvatar.name} className="avatar-img" />
                        </div>
                        <div className="message-bubble assistant">
                          {markdownAndMedia}
                          <div className="message-time" style={{ color: 'rgba(226, 240, 255, 0.4)', fontSize: '9px', marginTop: '6px', textAlign: 'right' }}>
                            {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }
              })}

              {errorMessage && (
                <div className="settings-card" style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderColor: 'rgba(239,68,68,0.4)', color: '#ff6b6b', padding: '16px', display: 'flex', flexDirection: 'row', gap: '12px', alignItems: 'flex-start' }}>
                  <AlertCircle style={{ width: '20px', height: '20px', flexShrink: '0' }} />
                  <div>
                    <strong style={{ fontSize: '13px', display: 'block', marginBottom: '4px' }}>DÉFAILLANCE ANALOGIQUE</strong>
                    <p style={{ fontSize: '12px' }}>{errorMessage}</p>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Diagnostic Console Bar Retro-Futuriste Space Age */}
            <div className="diagnostic-bar" style={{ display: 'flex', gap: '16px', padding: '8px 16px', backgroundColor: 'var(--bg-secondary)', borderTop: '3px solid var(--text-primary)', fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', fontWeight: 'bold', letterSpacing: '1px' }}>
              <span>&gt;&gt;&gt; HOST: {hostname} // LIVE</span>
              <span className="diag-item-secondary">// FREQ: {cpuFreq} MHz</span>
              <span className="diag-item-secondary">// TRANSCEIVER: ACTIVE</span>
              <span className="diag-item-temp" style={{ marginLeft: 'auto' }}>TEMP: {cpuTemp}°C // FPS: {realFps}</span>
            </div>

            {/* Aperçu des pièces jointes */}
            {attachments.length > 0 && (
              <div className="attachments-preview">
                {attachments.map((att, idx) => (
                  <div key={idx} className="attachment-preview-card">
                    {att.type.startsWith('image/') ? (
                      <img src={att.dataUrl} alt={att.name} className="attachment-preview-thumbnail" />
                    ) : (
                      <span className="attachment-preview-icon">📄</span>
                    )}
                    <div className="attachment-preview-details">
                      <span className="attachment-preview-name">{att.name}</span>
                      <span className="attachment-preview-size">{(att.size / 1024).toFixed(1)} KB</span>
                    </div>
                    <button 
                      onClick={() => removeAttachment(idx)} 
                      className="attachment-preview-remove"
                      title="Supprimer la pièce jointe"
                    >
                      <X style={{ width: '12px', height: '12px' }} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Input Bar */}
            <div className="input-container">
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                style={{ display: 'none' }} 
                multiple 
              />

              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage(inputText)}
                placeholder="Message a Eve..."
                className="glow-input"
                disabled={isSending}
              />

              {/* Stop TTS — visible uniquement pendant la lecture */}
              {isSpeaking && (
                <button
                  onClick={handleStopTTS}
                  className="input-circle-btn"
                  style={{
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239, 68, 68, 0.15)',
                  }}
                  title="Arrêter la lecture vocale"
                >
                  <StopCircle style={{ width: '18px', height: '18px', color: '#ef4444' }} />
                </button>
              )}

              <button
                onClick={() => fileInputRef.current?.click()}
                className="input-circle-btn"
                style={{
                  borderColor: attachments.length > 0 ? 'var(--accent-cyan)' : 'rgba(226, 240, 255, 0.12)',
                  backgroundColor: attachments.length > 0 ? 'rgba(0, 242, 255, 0.1)' : '#050914',
                }}
                title="Ajouter des pièces jointes (Images, Fichiers texte...)"
              >
                <Paperclip style={{ width: '18px', height: '18px', color: attachments.length > 0 ? 'var(--accent-cyan)' : 'var(--text-secondary)' }} />
              </button>

              <button
                onClick={isListening ? handleStopListening : handleStartVocalRecord}
                className="input-circle-btn"
                style={{
                  borderColor: isListening ? '#ef4444' : 'rgba(226, 240, 255, 0.12)',
                  backgroundColor: isListening ? 'rgba(239, 68, 68, 0.15)' : '#050914'
                }}
                title={isListening ? "Arrêter l'écoute" : "Démarrer la saisie vocale"}
              >
                {isListening ? <MicOff style={{ width: '18px', height: '18px', color: '#ef4444' }} /> : <Mic style={{ width: '18px', height: '18px', color: 'var(--text-secondary)' }} />}
              </button>

              <button
                onClick={() => handleSendMessage(inputText)}
                disabled={(!inputText.trim() && attachments.length === 0) || isSending}
                className="input-send-btn"
                title="Envoyer le message"
              >
                <Send style={{ width: '16px', height: '16px' }} />
              </button>
            </div>
          </section>
        )}

        {/* PARAMÈTRES SECTION (De gauche, recouvre le chat) */}
        {!isFloatingMode && showSettings && (
          <section className="settings-section">
            <div className="flex-between" style={{ paddingBottom: '16px', borderBottom: '3px solid var(--text-primary)' }}>
              <h2 className="neon-title text-xl font-bold flex items-center gap-2" style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
                <Settings style={{ width: '20px', height: '20px', color: 'var(--accent-cyan)' }} />
                Configuration Globale
              </h2>
              <button 
                onClick={() => setShowSettings(false)}
                className="neon-btn neon-btn-secondary"
                style={{ padding: '6px 16px', fontSize: '12px' }}
              >
                Retour au Chat
              </button>
            </div>



            {/* A. Agents */}
            <div className="settings-card">
              <h3 className="label-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Cpu style={{ width: '14px', height: '14px' }} /> Connecteurs d'Agents
              </h3>
              
              <div className="grid-3">
                {(['ollama', 'hermes'] as AgentProvider[]).map((prov) => (
                  <button
                    key={prov}
                    onClick={() => saveConfig({ ...agentConfig, provider: prov })}
                    className="neon-btn"
                    style={{ 
                      padding: '8px 12px', 
                      fontSize: '11px',
                      background: agentConfig.provider === prov ? '' : 'transparent',
                      border: agentConfig.provider === prov ? 'none' : '1px solid #cbd5e1',
                      color: agentConfig.provider === prov ? 'white' : '#64748b',
                      boxShadow: agentConfig.provider === prov ? '' : 'none'
                    }}
                  >
                    {prov}
                  </button>
                ))}
              </div>

              {agentConfig.provider === 'ollama' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <label className="label-title">URL Endpoint Ollama</label>
                    <input 
                      type="text" 
                      value={agentConfig.ollamaUrl}
                      onChange={(e) => saveConfig({ ...agentConfig, ollamaUrl: e.target.value })}
                      className="glow-input"
                      style={{ padding: '8px 12px', fontSize: '12px' }}
                    />
                  </div>
                  <div>
                    <label className="label-title">Modèle (ex: llama3, mistral)</label>
                    <input 
                      type="text" 
                      value={agentConfig.ollamaModel}
                      onChange={(e) => saveConfig({ ...agentConfig, ollamaModel: e.target.value })}
                      className="glow-input"
                      style={{ padding: '8px 12px', fontSize: '12px' }}
                    />
                  </div>
                </div>
              )}

              {agentConfig.provider === 'hermes' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <label className="label-title">URL Endpoint Hermes Agent</label>
                    <input 
                      type="text" 
                      value={agentConfig.hermesUrl}
                      onChange={(e) => saveConfig({ ...agentConfig, hermesUrl: e.target.value })}
                      className="glow-input"
                      style={{ padding: '8px 12px', fontSize: '12px' }}
                      placeholder="Ex: http://hermes.monserveur.eu"
                    />
                    <span style={{ display: 'block', marginTop: '5px', fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      ℹ️ Formats acceptés: <code>http://host</code> · <code>http://host/v1</code> · <code>http://host/v1/chat/completions</code>
                    </span>
                  </div>
                  <div className="grid-2">
                    <div>
                      <label className="label-title">Modèle (ex: hermes3)</label>
                      <input 
                        type="text" 
                        value={agentConfig.hermesModel}
                        onChange={(e) => saveConfig({ ...agentConfig, hermesModel: e.target.value })}
                        className="glow-input"
                        style={{ padding: '8px 12px', fontSize: '12px' }}
                        placeholder="hermes3"
                      />
                    </div>
                    <div>
                      <label className="label-title">Clé API (Optionnel)</label>
                      <input 
                        type="password" 
                        value={agentConfig.hermesApiKey}
                        onChange={(e) => saveConfig({ ...agentConfig, hermesApiKey: e.target.value })}
                        className="glow-input"
                        style={{ padding: '8px 12px', fontSize: '12px' }}
                        placeholder="Bearer token (API_SERVER_KEY)"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="label-title">Clé de Session (Mémoire stable à long terme)</label>
                    <input 
                      type="text" 
                      value={agentConfig.hermesSessionKey}
                      onChange={(e) => saveConfig({ ...agentConfig, hermesSessionKey: e.target.value })}
                      className="glow-input"
                      style={{ padding: '8px 12px', fontSize: '12px' }}
                      placeholder="Ex: eveflow-user-session"
                    />
                    <span style={{ display: 'block', marginTop: '5px', fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      ℹ️ Cette clé associe EveFlow à vos fichiers de mémoire persistante (<code>USER.md</code> et <code>MEMORY.md</code>) sur votre hôte <code>UNRAID_HERMES</code>.
                    </span>
                  </div>
                </div>
              )}


            </div>

            {/* B. TTS / STT */}
            <div className="settings-card">
              <h3 className="label-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Volume2 style={{ width: '14px', height: '14px' }} /> Voix de {activeAvatar.name} (Text-to-Speech)
              </h3>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div>
                  <label className="label-title">Type de Synthèse Vocale</label>
                  <div className="grid-2" style={{ gap: '10px', marginTop: '4px' }}>
                    <button
                      onClick={() => {
                        setTtsProvider('google-free');
                        persistWrite('eveflow_tts_provider', 'google-free');
                      }}
                      className="neon-btn"
                      style={{
                        padding: '8px 12px',
                        fontSize: '11px',
                        background: ttsProvider === 'google-free' ? '' : 'transparent',
                        border: ttsProvider === 'google-free' ? 'none' : '1px solid #cbd5e1',
                        color: ttsProvider === 'google-free' ? 'white' : '#64748b',
                        boxShadow: ttsProvider === 'google-free' ? '' : 'none'
                      }}
                    >
                      🟢 Voix Naturelle (Ligne)
                    </button>
                    <button
                      onClick={() => {
                        setTtsProvider('system');
                        persistWrite('eveflow_tts_provider', 'system');
                      }}
                      className="neon-btn"
                      style={{
                        padding: '8px 12px',
                        fontSize: '11px',
                        background: ttsProvider === 'system' ? '' : 'transparent',
                        border: ttsProvider === 'system' ? 'none' : '1px solid #cbd5e1',
                        color: ttsProvider === 'system' ? 'white' : '#64748b',
                        boxShadow: ttsProvider === 'system' ? '' : 'none'
                      }}
                    >
                      🔌 Voix Système (Local)
                    </button>
                  </div>
                </div>

                {ttsProvider === 'system' && (
                  <div>
                    <label className="label-title">Voix Synthétique Locale</label>
                    <select 
                      value={selectedVoice}
                      onChange={(e) => {
                        setSelectedVoice(e.target.value);
                        persistWrite('eveflow_voice', e.target.value);
                      }}
                      className="glow-input"
                      style={{ padding: '8px 12px', fontSize: '12px' }}
                    >
                      {availableVoices.map((voice) => (
                        <option key={voice.name} value={voice.name}>
                          {voice.name} ({voice.lang})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {ttsProvider === 'google-free' && (
                  <div style={{ padding: '8px 12px', backgroundColor: 'var(--accent-light)', border: '1px solid rgba(0,212,245,0.2)', borderRadius: '10px', fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-neon)', lineHeight: 1.5 }}>
                    ℹ️ **Mode Voix Naturelle Actif** : EveFlow utilise la voix neuronale ultra-fluide et humaine de Google. Aucun frais ni clé API requis. En cas de perte de connexion, elle basculera automatiquement sur votre voix locale hors-ligne.
                  </div>
                )}

                <div className="grid-2">
                  <div>
                    <label className="label-title">Vitesse: {ttsRate.toFixed(2)}</label>
                    <input 
                      type="range" 
                      min="0.8" 
                      max="1.5" 
                      step="0.05"
                      value={ttsRate}
                      onChange={(e) => setTtsRate(parseFloat(e.target.value))}
                      style={{ width: '100%', marginTop: '6px' }}
                    />
                  </div>
                  <div>
                    <label className="label-title">Langue de dictée (STT)</label>
                    <select
                      value={sttLang}
                      onChange={(e) => setSttLang(e.target.value)}
                      className="glow-input"
                      style={{ padding: '8px 12px', fontSize: '12px' }}
                    >
                      <option value="fr-FR">Français (France)</option>
                      <option value="en-US">English (USA)</option>
                    </select>
                  </div>
                </div>

                <button 
                  onClick={() => {
                    if (audioServiceRef.current) {
                      setIsSpeaking(true);
                      audioServiceRef.current.speak(activeAvatar.welcome, selectedVoice, ttsRate, 1.1, ttsProvider)
                        .then(() => setIsSpeaking(false));
                    }
                  }}
                  className="neon-btn neon-btn-secondary"
                  style={{ width: '100%', padding: '8px 16px', fontSize: '12px' }}
                >
                  Tester la voix de {activeAvatar.name}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* COMPAGNON 3D SECTION (De droite) */}
        <section className={`eve-section ${isFloatingMode ? 'floating-widget' : ''} ${isListening || isSpeaking || isSending ? 'eve-active' : ''}`}>
          {!isFloatingMode && (
            <div className="eve-status-pill">
              <span className="status-led" />
              <span>{isListening ? 'Eve ecoute' : isSpeaking ? 'Eve parle' : isSending ? 'Eve reflechit' : 'Eve ecoute'}</span>
            </div>
          )}

          {!isFloatingMode && (
            <button onClick={toggleWindowMode} className="eve-popout-btn" title="Mode Widget flottant">
              <ExternalLink size={14} />
            </button>
          )}


          
          {/* Header flottant discret pour contrôle en mode Widget */}
          {isFloatingMode && (
            <div className="flex-between" style={{ position: 'absolute', top: '12px', left: '12px', right: '12px', zIndex: 50, WebkitAppRegion: 'drag' } as any}>
              <div className="flex-row" style={{ WebkitAppRegion: 'no-drag' } as any}>
                <span className="h-3 w-3 rounded-full pulsing-led" style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: activeAvatar.accent, boxShadow: `0 0 12px ${activeAvatar.accent}` }}></span>
                <span style={{ fontSize: '11px', fontWeight: '800', color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '1px', fontFamily: 'var(--font-title)' }}>{activeAvatar.name}</span>
              </div>
              <div className="flex-row" style={{ WebkitAppRegion: 'no-drag' } as any}>
                <button 
                  onClick={toggleWindowMode} 
                  className="glow-input"
                  style={{ padding: '6px 12px', width: 'auto', borderRadius: '20px', cursor: 'pointer', backgroundColor: 'var(--bg-secondary)', borderColor: 'rgba(0,212,245,0.3)' }}
                  title="Retourner au chat complet"
                >
                  <MessageSquare style={{ width: '12px', height: '12px', color: 'var(--text-primary)' }} />
                </button>
                {window.electronAPI && (
                  <button 
                    onClick={() => handleWindowControl('close')} 
                    className="glow-input"
                    style={{ padding: '6px 12px', width: 'auto', borderRadius: '20px', cursor: 'pointer', backgroundColor: 'rgba(239,68,68,0.15)', borderColor: 'rgba(239,68,68,0.4)', color: '#ff6b6b' }}
                  >
                    <X style={{ width: '12px', height: '12px' }} />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Rendu Canvas 3D */}
          <div style={{ flex: 1, width: '100%', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ThreeCanvas
              emotion={currentEmotion}
              isSpeaking={isSpeaking}
              avatarId={avatarId}
            />
            {avatarId !== 'eve' && activeAvatar.assetPath && (
              <div style={{ position: 'absolute', top: '16px', left: '50%', transform: 'translateX(-50%)', padding: '7px 14px', borderRadius: '18px', backgroundColor: 'var(--bg-secondary)', border: '1px solid rgba(0,212,245,0.25)', boxShadow: '0 0 20px rgba(0,212,245,0.1)', fontSize: '9px', fontFamily: 'var(--font-mono)', fontWeight: 800, letterSpacing: '0.8px', color: 'var(--text-secondary)', textTransform: 'uppercase', pointerEvents: 'none' }}>
                {activeAvatar.name}: asset premium attendu
              </div>
            )}

            {/* Badge d'humeur en bas */}
            {!isFloatingMode && false && (
              <div style={{ position: 'absolute', bottom: '16px', left: '50%', transform: 'translateX(-50%)', padding: '8px 20px', borderRadius: '30px', backgroundColor: 'var(--bg-secondary)', border: '2px solid var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 4px 15px rgba(45, 30, 24, 0.08)', fontSize: '12px', fontWeight: '700' }}>
                <span className="h-3 w-3 rounded-full pulsing-led" style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: activeAvatar.accent, boxShadow: `0 0 10px ${activeAvatar.accent}` }}></span>
                <span style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', fontSize: '9px', letterSpacing: '1px', fontFamily: 'var(--font-title)' }}>Humeur:</span>
                <span style={{ color: 'var(--text-neon)', textTransform: 'uppercase', fontSize: '10.5px', fontWeight: '800', fontFamily: 'var(--font-title)' }}>{currentEmotion}</span>
              </div>
            )}
          </div>

          {/* Contrôle micro en mode Widget */}
          {isFloatingMode && (
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', paddingBottom: '12px' }}>
              <button
                onClick={isListening ? handleStopListening : handleStartVocalRecord}
                className="neon-btn"
                style={{ 
                  borderRadius: '50%', 
                  padding: '16px',
                  width: '56px',
                  height: '56px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: isListening ? 'linear-gradient(135deg, #ef4444, #b91c1c)' : 'linear-gradient(135deg, var(--accent-cyan), var(--accent-blue))',
                  boxShadow: isListening ? '0 0 20px rgba(239, 68, 68, 0.4)' : '0 4px 12px rgba(255, 85, 0, 0.25)',
                  border: '2px solid var(--text-primary)'
                }}
                title={isListening ? "Arrêter l'écoute" : `Parler à ${activeAvatar.name}`}
              >
                {isListening ? <MicOff style={{ width: '22px', height: '22px' }} /> : <Mic style={{ width: '22px', height: '22px' }} />}
              </button>
              <div style={{ fontSize: '9px', fontWeight: '800', textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '1.5px', padding: '4px 14px', borderRadius: '15px', backgroundColor: 'var(--bg-secondary)', border: '2px solid var(--text-primary)', fontFamily: 'var(--font-title)' }}>
                {isListening ? "À l'écoute..." : "Prête à t'écouter"}
              </div>
            </div>
          )}


        </section>

        {!isFloatingMode && !showSettings && agentConfig.provider === 'hermes' && showHermesCockpit && (
          <HermesCockpitWindow
            events={toolEvents}
            isWorking={isSending}
            jobs={hermesJobs}
            runs={hermesRunHistory}
            syncState={hermesSyncState}
            syncDetail={hermesSyncDetail}
            lastSyncAt={hermesLastSyncAt}
            draft={hermesCronDraft}
            editingJobId={editingHermesJobId}
            isSaving={isSavingHermesCron}
            onDraftChange={setHermesCronDraft}
            onCreate={handleCreateHermesCron}
            onCancelEdit={handleCancelEditHermesCron}
            onStartEdit={handleStartEditHermesCron}
            onUpdate={handleUpdateHermesCron}
            onRefresh={refreshHermesJobs}
            onPause={(job) => runHermesCronAction(job, 'pause')}
            onResume={(job) => runHermesCronAction(job, 'resume')}
            onRun={(job) => runHermesCronAction(job, 'run')}
            onDelete={(job) => runHermesCronAction(job, 'delete')}
            onOpenRun={openHermesRunInChat}
            onClose={closeHermesCockpit}
          />
        )}

      </div>
    </div>
  );
};

export default App;

