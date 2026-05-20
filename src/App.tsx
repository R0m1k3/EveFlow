import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Send, Mic, MicOff, Settings, MessageSquare, Volume2, VolumeX,
  Sparkles, Cpu, Minimize2, X, AlertCircle, StopCircle, Paperclip
} from 'lucide-react';
import { ThreeCanvas } from './components/ThreeCanvas';
import { AudioService } from './services/audioService';
import { AgentService, AgentConfig, AgentProvider } from './services/agentService';
import { EmotionService, EveAvatar, EveEmotion } from './services/emotionService';
import { PollingService } from './services/pollingService';
import { AppCallbacks } from './services/toolRegistry';
import { version } from '../package.json';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  emotion?: EveEmotion;
  timestamp: Date;
  source?: 'eveflow' | 'telegram' | 'webhook';
  images?: string[]; // base64 Data URLs pour affichage local direct
}

interface Attachment {
  name: string;
  type: string;
  dataUrl: string; // base64 Data URL
  size: number;
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

// Composant de rendu asynchrone pour les images locales dans ReactMarkdown et la galerie
// Gère de façon Zero Trust la distinction entre base64 local, fichier Windows, et chemin absolu du serveur distant Hermes
const LocalImage: React.FC<{ 
  src: string; 
  alt?: string; 
  agentUrl?: string; 
  provider?: string; 
  [key: string]: any; 
}> = ({ src, alt, agentUrl, provider, ...props }) => {
  const [imageSrc, setImageSrc] = useState<string>('');

  useEffect(() => {
    // 1. Si c'est une image base64 en direct (Data URL), pas de traitement IPC requis
    if (src.startsWith('data:')) {
      setImageSrc(src);
      return;
    }

    // 2. Si c'est une URL HTTP/HTTPS directe complète, on l'affiche directement
    if (src.startsWith('http://') || src.startsWith('https://')) {
      setImageSrc(src);
      return;
    }

    // 3. Détecter si c'est un chemin de fichier local réel sur la machine Windows de l'utilisateur
    // Un vrai chemin local Windows commencera par file:// ou par une lettre de lecteur comme C:
    const isWindowsLocal = src.startsWith('file://') || /^[a-zA-Z]:/.test(src);

    const resolveDistantFallback = () => {
      if (provider === 'hermes' && agentUrl) {
        try {
          // Nettoyer l'URL de l'agent pour obtenir la racine du serveur (ex: http://host:port)
          const parsed = new URL(agentUrl);
          const hostUrl = `${parsed.protocol}//${parsed.host}`;
          
          let relativePath = src;
          // Nettoyer les reliquats de chemins de fichiers si présents
          if (src.startsWith('file://')) {
            relativePath = src.replace(/^file:\/\/\/[a-zA-Z]:/, '').replace(/^file:\/\//, '');
          } else if (/^[a-zA-Z]:/.test(src)) {
            relativePath = src.substring(2);
          }
          
          // Remplacer les antislashs par des slashs pour l'URL HTTP
          relativePath = relativePath.replace(/\\/g, '/');
          
          const resolvedUrl = `${hostUrl.replace(/\/$/, '')}/${relativePath.replace(/^\//, '')}`;
          console.log("[LocalImage] Chemin distant résolu pour Hermes:", resolvedUrl);
          setImageSrc(resolvedUrl);
        } catch (urlErr) {
          console.error("[LocalImage] Impossible de résoudre l'URL de secours distante:", urlErr);
          setImageSrc(src);
        }
      } else {
        setImageSrc(src);
      }
    };

    if (isWindowsLocal && (window as any).electronAPI?.readLocalFile) {
      let cleanPath = src;
      // Retirer les préfixes de protocole file:/// ou file://
      if (src.startsWith('file:///')) {
        cleanPath = src.substring(8);
      } else if (src.startsWith('file://')) {
        cleanPath = src.substring(7);
      }
      
      // Convertir les slashes pour s'adapter au système de fichiers Windows
      cleanPath = cleanPath.replace(/\//g, '\\');

      (window as any).electronAPI.readLocalFile(cleanPath)
        .then((dataUrl: string) => {
          setImageSrc(dataUrl);
        })
        .catch((err: any) => {
          console.warn("[LocalImage] Échec de la lecture IPC locale, tentative de fallback distant:", err.message);
          resolveDistantFallback();
        });
    } else {
      // Si ce n'est pas un chemin local Windows (par exemple un chemin Unix absolu /data/jobs...), 
      // ou si l'API Electron n'est pas présente, on résout directement à distance sans faire d'appel IPC Windows coûteux qui échouera.
      resolveDistantFallback();
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

export const App: React.FC = () => {
  // --- ÉTATS ---
  const [avatarId, setAvatarId] = useState<EveAvatar>(() => getInitialAvatarId());
  const [messages, setMessages] = useState<Message[]>(() => [createWelcomeMessage(avatarId)]);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
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
  const [isMuted, setIsMuted] = useState(false);

  // Fenêtre & Navigation
  const [isFloatingMode, setIsFloatingMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

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
  const [ttsRate, setTtsRate] = useState<number>(1.05);
  const [sttLang, setSttLang] = useState<string>('fr-FR');
  const activeAvatar = AVATAR_PROFILES[avatarId];



  // Session Hermes persistante — garantit la continuité mémoire/skills entre redémarrages
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
        audioServiceRef.current.speak(text, selectedVoice, ttsRate).then(() => setIsSpeaking(false));
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
      return;
    }

    if (!pollingServiceRef.current) {
      pollingServiceRef.current = new PollingService(30000);
    }

    pollingServiceRef.current.start(agentConfig.hermesUrl, agentConfig.hermesApiKey, (job) => {
      if (job.result) {
        setMessages(prev => [...prev, {
          id: Math.random().toString(),
          role: 'assistant',
          content: job.result!,
          timestamp: new Date()
        }]);
        // Trigger generic emotion for a pushed job
        setCurrentEmotion('happy');
        if (!isMuted && audioServiceRef.current) {
          audioServiceRef.current.speak(job.result, selectedVoice, ttsRate);
        }
      }
    });

    return () => pollingServiceRef.current?.stop();
  }, [agentConfig.provider, agentConfig.hermesUrl, agentConfig.hermesApiKey, isMuted, selectedVoice, ttsRate]);

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
            source: source as Message['source'],
            timestamp: new Date()
          }]);
          if (role === 'assistant') {
            setCurrentEmotion('happy');
            if (!isMuted && audioServiceRef.current) {
              audioServiceRef.current.speak(event.text, selectedVoice, ttsRate)
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
  }, [isMuted, selectedVoice, ttsRate]);

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

  const handleSendMessage = async (text: string) => {
    if (!text.trim() && attachments.length === 0) return;
    if (isSending) return;

    setErrorMessage(null);
    setIsSending(true);

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

      // TTS streaming : désactivé au fil de l'eau pour gérer intelligemment les messages longs en fin de génération

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
        },
        // onToolCall
        (toolName) => {
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

      // Update final message
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: reply, emotion: deducedEmotion } : m
      ));

      // Synthèse vocale de fin de message intelligente (Zero Trust & asynchrone)
      if (!isMuted && audioServiceRef.current) {
        setIsSpeaking(true);
        
        if (reply.length >= TTS_LONG_TEXT_THRESHOLD) {
          // Si le texte est long, l'agent génère une description courte par IA en arrière-plan
          setCurrentEmotion('thinking');
          generateLongMessageSummary(reply)
            .then((shortDescription) => {
              setCurrentEmotion(deducedEmotion);
              return audioServiceRef.current!.speak(shortDescription, selectedVoice, ttsRate);
            })
            .then(() => {
              setIsSpeaking(false);
              setCurrentEmotion('neutral');
            })
            .catch(() => {
              setIsSpeaking(false);
              setCurrentEmotion('neutral');
            });
        } else {
          // Si le texte est court, lecture intégrale directe
          audioServiceRef.current.speak(reply, selectedVoice, ttsRate)
            .then(() => {
              setIsSpeaking(false);
              setCurrentEmotion('neutral');
            })
            .catch(() => {
              setIsSpeaking(false);
              setCurrentEmotion('neutral');
            });
        }
      }

    } catch (e: any) {
      setErrorMessage(e.message || "Une erreur s'est produite.");
      setCurrentEmotion('sad');
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

  const generateLongMessageSummary = async (text: string): Promise<string> => {
    const prompt = `Fais une description orale très courte (une seule phrase simple de maximum 12 mots) pour annoncer et résumer le texte suivant de manière agréable. Parle obligatoirement à la première personne en tant qu'assistant de l'utilisateur (ex: "Voici mon rapport de sécurité..." ou "Voici mon analyse géométrique...").\n\nTexte :\n${text}`;
    try {
      // Appel asynchrone direct et ultra-rapide sans historique pour le résumé
      const result = await AgentService.sendMessage(
        prompt,
        [],
        agentConfig,
        avatarId,
        buildCallbacks()
      );
      
      // Nettoyer la réponse des guillemets superflus
      return result.replace(/^["']|["']$/g, '').trim();
    } catch (err) {
      console.warn("[TTS] Échec de la description vocale IA, utilisation du fallback statique:", err);
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      return `Voici ma transmission contenant environ ${wordCount} mots. Vous pouvez lancer son écoute audio complète à l'aide du bouton de lecture au bas du message.`;
    }
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

      audioServiceRef.current.speak(content, selectedVoice, ttsRate)
        .then(() => {
          setCurrentlyPlayingMsgId(null);
          setIsSpeaking(false);
          setCurrentEmotion('neutral');
        })
        .catch((err) => {
          console.error("[TTS] Échec de la lecture audio complète :", err);
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
          <div className="flex-row">
            <div className="h-3 w-3 rounded-full pulsing-led" style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: activeAvatar.accent, boxShadow: `0 0 12px ${activeAvatar.accent}` }}></div>
            <h1 className="neon-title" style={{ fontFamily: 'var(--font-title)', letterSpacing: '2px', color: 'var(--text-primary)', fontSize: '18px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '10px', lineHeight: 1 }}>
              EVEFLOW
              <span className="header-subtitle" style={{ color: 'var(--text-secondary)', fontWeight: 500, fontSize: '14px' }}>// ANALOG SPACE OS</span>
              <span className="sys-ready-badge" style={{ fontSize: '9px', padding: '3px 10px', backgroundColor: 'var(--accent-light)', color: 'var(--text-neon)', border: '1px solid rgba(0,212,245,0.4)', borderRadius: '20px', fontWeight: 'bold', fontFamily: 'var(--font-mono)' }}>SYS_READY_V{version}</span>
            </h1>
          </div>

          <div className="flex-row" style={{ WebkitAppRegion: 'no-drag' } as any}>
            {/* Statut Agent */}
            <div className="flex-row agent-status-badge" style={{ padding: '6px 14px', backgroundColor: 'var(--bg-primary)', fontSize: '11px', fontWeight: '800', color: 'var(--text-neon)', border: '2px solid var(--text-primary)', borderRadius: '20px', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '1px' }}>
              <Cpu style={{ width: '13px', height: '13px', color: 'var(--accent-cyan)' }} />
              <span>[ RECEIVER: {agentConfig.provider} ]</span>
            </div>

            {/* Sourdine */}
            <button 
              onClick={() => {
                if (audioServiceRef.current && isSpeaking) {
                  audioServiceRef.current.stopSpeaking();
                  setIsSpeaking(false);
                }
                setIsMuted(!isMuted);
              }}
              className="glow-input"
              style={{ padding: '8px 12px', width: 'auto', borderRadius: '20px', display: 'flex', alignItems: 'center', cursor: 'pointer', borderColor: isMuted ? '#ef4444' : 'rgba(0,212,245,0.3)', backgroundColor: isMuted ? 'rgba(239,68,68,0.15)' : 'var(--bg-secondary)' }}
              title={isMuted ? `Activer la voix de ${activeAvatar.name}` : `Couper la voix de ${activeAvatar.name}`}
            >
              {isMuted ? <VolumeX style={{ width: '16px', height: '16px', color: '#ef4444' }} /> : <Volume2 style={{ width: '16px', height: '16px', color: 'var(--text-primary)' }} />}
            </button>

            {/* Paramètres */}
            <button 
              onClick={() => setShowSettings(!showSettings)}
              className="glow-input"
              style={{ padding: '8px 12px', width: 'auto', borderRadius: '20px', display: 'flex', alignItems: 'center', cursor: 'pointer', borderColor: showSettings ? 'var(--accent-cyan)' : 'rgba(0,212,245,0.3)', backgroundColor: showSettings ? 'var(--accent-light)' : 'var(--bg-secondary)' }}
              title="Paramètres de configuration"
            >
              <Settings style={{ width: '16px', height: '16px', color: 'var(--text-primary)' }} />
            </button>

            {/* Mode Widget Flottant */}
            <button 
              onClick={toggleWindowMode}
              className="glow-input"
              style={{ padding: '8px 12px', width: 'auto', borderRadius: '20px', borderColor: 'rgba(0,212,245,0.3)', backgroundColor: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', cursor: 'pointer' }}
              title="Activer le mode compagnon flottant"
            >
              <Minimize2 style={{ width: '16px', height: '16px', color: 'var(--text-primary)' }} />
            </button>

            {/* Electron Controls */}
            {window.electronAPI && (
              <div className="flex-row" style={{ borderLeft: '2px solid var(--text-primary)', paddingLeft: '12px' }}>
                <button 
                  onClick={() => handleWindowControl('minimize')} 
                  className="glow-input"
                  style={{ padding: '8px 12px', width: 'auto', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--text-primary)', fontWeight: 'bold' }}
                >
                  —
                </button>
                <button 
                  onClick={() => handleWindowControl('close')} 
                  className="glow-input"
                  style={{ padding: '8px 12px', width: 'auto', cursor: 'pointer', border: 'none', background: 'transparent', color: '#ef4444', fontWeight: 'bold' }}
                >
                  <X style={{ width: '16px', height: '16px' }} />
                </button>
              </div>
            )}
          </div>
        </header>
      )}

      {/* 2. MAIN LAYOUT CONTAINER */}
      <div className="app-main">

        {/* CHAT SECTION (De gauche) */}
        {!isFloatingMode && !showSettings && (
          <section className="chat-section">
            <div className="messages-container">
              {messages.map((msg) => (
                <div 
                  key={msg.id} 
                  className={`message-row ${msg.role === 'user' ? 'user' : 'assistant'}`}
                >
                  <div className={`message-bubble ${msg.role === 'user' ? 'user' : 'assistant'}`}>
                    {msg.role === 'assistant' ? (
                      <div className="message-meta" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '1.5px', color: 'var(--text-neon)', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <Sparkles style={{ width: '12px', height: '12px', color: 'var(--accent-cyan)', flexShrink: 0 }} />
                        <span>[TRANSMISSION: {activeAvatar.name.toUpperCase()} // TELEMETRY: {msg.emotion?.toUpperCase() || 'NEUTRAL'}]</span>
                        {msg.source && msg.source !== 'eveflow' && (
                          <span style={{ fontSize: '9px', padding: '2px 7px', backgroundColor: 'rgba(0,212,245,0.15)', border: '1px solid rgba(0,212,245,0.35)', borderRadius: '10px', color: 'var(--accent-cyan)', fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase' }}>
                            {msg.source}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="message-meta" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '1.5px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span>[TELECOMMANDE // CONSOLE_INPUT]</span>
                        {msg.source && msg.source !== 'eveflow' && (
                          <span style={{ fontSize: '9px', padding: '2px 7px', backgroundColor: 'rgba(255,160,0,0.15)', border: '1px solid rgba(255,160,0,0.35)', borderRadius: '10px', color: '#ffb84d', fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase' }}>
                            {msg.source}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="markdown-content">
                      <ReactMarkdown 
                        remarkPlugins={[remarkGfm]}
                        components={{
                          img: ({ node, ...props }) => (
                            <LocalImage 
                              src={props.src || ''} 
                              alt={props.alt} 
                              agentUrl={agentConfig.hermesUrl} 
                              provider={agentConfig.provider} 
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
                        {msg.content}
                      </ReactMarkdown>

                      {msg.images && msg.images.length > 0 && (
                        <div className="message-images-gallery" style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          {msg.images.map((imgUrl, i) => (
                            <LocalImage 
                              key={i} 
                              src={imgUrl} 
                              alt="Image jointe" 
                              agentUrl={agentConfig.hermesUrl} 
                              provider={agentConfig.provider} 
                            />
                          ))}
                        </div>
                      )}

                      {msg.role === 'assistant' && msg.content.length >= TTS_LONG_TEXT_THRESHOLD && (
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
                    <span className="message-time">
                      {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              ))}
              


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
                placeholder="Tape ton message ici..."
                className="glow-input"
                disabled={isSending}
              />

              {/* Stop TTS — visible uniquement pendant la lecture */}
              {isSpeaking && (
                <button
                  onClick={handleStopTTS}
                  className="glow-input"
                  style={{
                    padding: '12px',
                    width: 'auto',
                    cursor: 'pointer',
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239,68,68,0.15)',
                    flexShrink: 0
                  }}
                  title="Arrêter la lecture vocale"
                >
                  <StopCircle style={{ width: '18px', height: '18px', color: '#ef4444' }} />
                </button>
              )}

              <button
                onClick={() => fileInputRef.current?.click()}
                className="glow-input"
                style={{
                  padding: '12px',
                  width: 'auto',
                  cursor: 'pointer',
                  borderColor: attachments.length > 0 ? 'var(--accent-cyan)' : 'var(--text-primary)',
                  backgroundColor: attachments.length > 0 ? 'var(--accent-light)' : 'var(--bg-secondary)',
                  flexShrink: 0
                }}
                title="Ajouter des pièces jointes (Images, Fichiers texte...)"
              >
                <Paperclip style={{ width: '18px', height: '18px', color: attachments.length > 0 ? 'var(--accent-cyan)' : 'var(--text-primary)' }} />
              </button>

              <button
                onClick={isListening ? handleStopListening : handleStartVocalRecord}
                className="glow-input"
                style={{
                  padding: '12px',
                  width: 'auto',
                  cursor: 'pointer',
                  borderColor: isListening ? '#ef4444' : 'var(--text-primary)',
                  backgroundColor: isListening ? 'rgba(239,68,68,0.15)' : 'var(--bg-secondary)'
                }}
                title={isListening ? "Arrêter l'écoute" : "Démarrer la saisie vocale"}
              >
                {isListening ? <MicOff style={{ width: '18px', height: '18px', color: '#ef4444' }} /> : <Mic style={{ width: '18px', height: '18px', color: 'var(--text-primary)' }} />}
              </button>

              <button
                onClick={() => handleSendMessage(inputText)}
                disabled={(!inputText.trim() && attachments.length === 0) || isSending}
                className="neon-btn"
              >
                <Send style={{ width: '14px', height: '14px' }} />
                <span className="btn-text">Envoyer</span>
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
                      audioServiceRef.current.speak(activeAvatar.welcome, selectedVoice, ttsRate)
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
        <section className={`eve-section ${isFloatingMode ? 'floating-widget' : ''}`}>
          
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
          <div style={{ flex: 1, width: '100%', position: 'relative' }}>
            <ThreeCanvas emotion={currentEmotion} isSpeaking={isSpeaking} avatarId={avatarId} />
            {avatarId !== 'eve' && activeAvatar.assetPath && (
              <div style={{ position: 'absolute', top: '16px', left: '50%', transform: 'translateX(-50%)', padding: '7px 14px', borderRadius: '18px', backgroundColor: 'var(--bg-secondary)', border: '1px solid rgba(0,212,245,0.25)', boxShadow: '0 0 20px rgba(0,212,245,0.1)', fontSize: '9px', fontFamily: 'var(--font-mono)', fontWeight: 800, letterSpacing: '0.8px', color: 'var(--text-secondary)', textTransform: 'uppercase', pointerEvents: 'none' }}>
                {activeAvatar.name}: asset premium attendu
              </div>
            )}

            {/* Badge d'humeur en bas */}
            {!isFloatingMode && (
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

      </div>
    </div>
  );
};

export default App;

