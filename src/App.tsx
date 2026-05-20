import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Send, Mic, MicOff, Settings, MessageSquare, Volume2, VolumeX,
  Sparkles, Cpu, Minimize2, X, AlertCircle, StopCircle
} from 'lucide-react';
import { ThreeCanvas } from './components/ThreeCanvas';
import { AudioService } from './services/audioService';
import { AgentService, AgentConfig, AgentProvider } from './services/agentService';
import { EmotionService, EveAvatar, EveEmotion } from './services/emotionService';
import { PollingService } from './services/pollingService';
import { AppCallbacks } from './services/toolRegistry';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  emotion?: EveEmotion;
  timestamp: Date;
  source?: 'eveflow' | 'telegram' | 'webhook';
}

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
    minimaxApiKey: '',
    minimaxGroupId: '',
    minimaxModel: 'abab6.5-chat'
  });

  const [availableVoices, setAvailableVoices] = useState<any[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>('');
  const [ttsRate, setTtsRate] = useState<number>(1.05);
  const [sttLang, setSttLang] = useState<string>('fr-FR');
  const activeAvatar = AVATAR_PROFILES[avatarId];

  // Minimax dynamic models states
  const [minimaxModelsList, setMinimaxModelsList] = useState<string[]>([
    'MiniMax-Text-01',
    'MiniMax-M2.7',
    'MiniMax-M2.5',
    'MiniMax-M2.1',
    'MiniMax-M2',
    'MiniMax-M2-her',
    'abab6.5-chat'
  ]);
  const [isLoadingMinimaxModels, setIsLoadingMinimaxModels] = useState(false);
  const [minimaxModelsError, setMinimaxModelsError] = useState<string | null>(null);
  const [lastLoadedMinimaxCredentials, setLastLoadedMinimaxCredentials] = useState<{ apiKey: string, groupId: string } | null>(null);

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

  // --- INITIALISATION ---
  useEffect(() => {
    const service = new AudioService();
    audioServiceRef.current = service;

    // Charger la configuration depuis le store persistant (IPC fichier > localStorage)
    persistRead('eveflow_agent_config').then(savedConfig => {
      if (savedConfig) {
        try {
          setAgentConfig(prev => ({ ...prev, ...JSON.parse(savedConfig) }));
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

  // Chargement automatique des modèles Minimax lorsque les identifiants requis sont saisis et que le fournisseur est Minimax
  useEffect(() => {
    const hasCredentialsChanged = !lastLoadedMinimaxCredentials || 
      lastLoadedMinimaxCredentials.apiKey !== agentConfig.minimaxApiKey || 
      lastLoadedMinimaxCredentials.groupId !== agentConfig.minimaxGroupId;

    if (
      agentConfig.provider === 'minimax' &&
      agentConfig.minimaxApiKey &&
      agentConfig.minimaxGroupId &&
      hasCredentialsChanged &&
      !isLoadingMinimaxModels
    ) {
      handleLoadMinimaxModels();
    }
  }, [agentConfig.provider, agentConfig.minimaxApiKey, agentConfig.minimaxGroupId, lastLoadedMinimaxCredentials]);

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

  const handleAvatarChange = (nextAvatarId: EveAvatar) => {
    setAvatarId(nextAvatarId);
    setCurrentEmotion('neutral');
    persistWrite('eveflow_avatar_id', nextAvatarId);

    setMessages(prev => {
      const canReplaceWelcome = prev.length === 0 || (prev.length === 1 && prev[0].id === 'welcome');
      return canReplaceWelcome ? [createWelcomeMessage(nextAvatarId)] : prev;
    });
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
    if (!text.trim() || isSending) return;

    setErrorMessage(null);
    setIsSending(true);

    const userMessage: Message = {
      id: Math.random().toString(),
      role: 'user',
      content: text,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInputText('');
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

      // TTS streaming : buffer de phrase en cours de construction
      let sentenceBuffer = '';
      let ttsStarted = false;
      // Détecte fin de phrase : point, !, ?, newline — suivi d'espace ou fin de token
      const SENTENCE_END = /([.!?…][\s"»]|[.!?…]$|\n)/;

      const reply = await AgentService.sendMessage(
        text,
        chatHistory,
        agentConfig,
        avatarId,
        buildCallbacks(),
        // onToken — UI rAF + TTS par phrase
        (token) => {
          fullReply += token;
          pendingContent = fullReply;
          if (rafHandle === null) rafHandle = requestAnimationFrame(flushTokens);

          if (!isMuted && audioServiceRef.current) {
            sentenceBuffer += token;
            if (SENTENCE_END.test(sentenceBuffer)) {
              const parts = sentenceBuffer.split(SENTENCE_END);
              // Envoyer toutes les phrases complètes sauf le dernier fragment en cours
              for (let i = 0; i < parts.length - 1; i++) {
                const s = parts[i].trim();
                if (s.length > 2) {
                  audioServiceRef.current.queueSentence(s, selectedVoice, ttsRate);
                  if (!ttsStarted) { setIsSpeaking(true); ttsStarted = true; }
                }
              }
              sentenceBuffer = parts[parts.length - 1];
            }
          }
        },
        // onToolCall
        (toolName) => {
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: m.content + `\n\n> ⚙️ *${toolName}*\n\n` } : m
          ));
        },
        hermesSessionId || undefined
      );
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);

      const deducedEmotion = EmotionService.analyzeSentiment(reply);
      setCurrentEmotion(deducedEmotion);

      // Update final message
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: reply, emotion: deducedEmotion } : m
      ));

      // Lire le fragment restant après la dernière ponctuation (si non muet)
      if (!isMuted && audioServiceRef.current) {
        const tail = sentenceBuffer.trim();
        if (tail.length > 2) {
          audioServiceRef.current.queueSentence(tail, selectedVoice, ttsRate);
          if (!ttsStarted) { setIsSpeaking(true); ttsStarted = true; }
        }
        // Si pas de streaming (réponse non-streamed), lecture normale
        if (!ttsStarted) {
          setIsSpeaking(true);
          audioServiceRef.current.speak(reply, selectedVoice, ttsRate)
            .then(() => { setIsSpeaking(false); setCurrentEmotion('neutral'); })
            .catch(() => setIsSpeaking(false));
        } else {
          // Attendre la fin de la file TTS via polling léger
          const waitTTS = setInterval(() => {
            if (!audioServiceRef.current?.ttsSynth.speaking) {
              clearInterval(waitTTS);
              setIsSpeaking(false);
              setCurrentEmotion('neutral');
            }
          }, 300);
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

  const handleLoadMinimaxModels = async () => {
    if (!agentConfig.minimaxApiKey) {
      setMinimaxModelsError("Veuillez saisir votre clé API Minimax.");
      return;
    }
    
    setIsLoadingMinimaxModels(true);
    setMinimaxModelsError(null);
    
    try {
      const models = await AgentService.getMinimaxModels(
        agentConfig.minimaxApiKey,
        agentConfig.minimaxGroupId
      );
      if (models && models.length > 0) {
        setMinimaxModelsList(models);
        setLastLoadedMinimaxCredentials({
          apiKey: agentConfig.minimaxApiKey,
          groupId: agentConfig.minimaxGroupId
        });
        // Si le modèle configuré n'est pas dans la liste des modèles disponibles, on bascule vers le premier
        if (!models.includes(agentConfig.minimaxModel)) {
          saveConfig({ ...agentConfig, minimaxModel: models[0] });
        }
      } else {
        throw new Error("Aucun modèle retourné par l'API.");
      }
    } catch (err: any) {
      console.error("Échec de chargement des modèles Minimax:", err);
      setMinimaxModelsError(err.message || "Impossible de charger les modèles.");
    } finally {
      setIsLoadingMinimaxModels(false);
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
              <span className="sys-ready-badge" style={{ fontSize: '9px', padding: '3px 10px', backgroundColor: 'var(--accent-light)', color: 'var(--text-neon)', border: '1px solid rgba(0,212,245,0.4)', borderRadius: '20px', fontWeight: 'bold', fontFamily: 'var(--font-mono)' }}>SYS_READY_V74</span>
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
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </ReactMarkdown>
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
              <span>&gt;&gt;&gt; HOST: UNRAID_HERMES // LIVE</span>
              <span className="diag-item-secondary">// FREQ: 742.8 MHz</span>
              <span className="diag-item-secondary">// TRANSCEIVER: ACTIVE</span>
              <span className="diag-item-temp" style={{ marginLeft: 'auto' }}>TEMP: 34.6°C // FPS: 60</span>
            </div>

            {/* Input Bar */}
            <div className="input-container">
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
                disabled={!inputText.trim() || isSending}
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

            {/* Avatar Selector */}
            <div className="settings-card">
              <h3 className="label-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Sparkles style={{ width: '14px', height: '14px' }} /> Selection d'Avatar
              </h3>
              <div className="grid-3">
                {(Object.keys(AVATAR_PROFILES) as EveAvatar[]).map((id) => {
                  const profile = AVATAR_PROFILES[id];
                  const isActive = avatarId === id;
                  return (
                    <button
                      key={id}
                      onClick={() => handleAvatarChange(id)}
                      className="glow-input"
                      style={{
                        cursor: 'pointer',
                        minHeight: '112px',
                        padding: '14px',
                        textAlign: 'left',
                        borderColor: isActive ? profile.accent : 'var(--text-primary)',
                        backgroundColor: isActive ? 'var(--bg-glass-active)' : 'var(--bg-secondary)',
                        boxShadow: isActive ? `0 0 18px ${profile.glow}` : 'none'
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: profile.accent, boxShadow: `0 0 12px ${profile.accent}` }} />
                        <span style={{ fontFamily: 'var(--font-title)', fontWeight: 900, fontSize: '13px', textTransform: 'uppercase' }}>{profile.name}</span>
                      </span>
                      <span style={{ display: 'block', fontSize: '10px', lineHeight: 1.4, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>
                        {profile.role}
                      </span>
                      {profile.assetPath && (
                        <span style={{ display: 'block', marginTop: '10px', fontSize: '9px', lineHeight: 1.35, color: isActive ? profile.accent : 'var(--text-secondary)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', fontWeight: 800 }}>
                          Asset requis: {profile.assetPath}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {avatarId !== 'eve' && activeAvatar.assetPath && (
                <div style={{ marginTop: '12px', padding: '10px 12px', border: '1px solid rgba(0,212,245,0.2)', borderRadius: 'var(--radius-sm)', backgroundColor: 'rgba(0,212,245,0.06)', fontSize: '10px', lineHeight: 1.45, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                  Si le fichier GLB premium est absent, EveFlow utilise Eve comme fallback visuel. Installe l'asset dans {activeAvatar.assetPath} pour activer le vrai modele {activeAvatar.name}.
                </div>
              )}
            </div>

            {/* A. Agents */}
            <div className="settings-card">
              <h3 className="label-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Cpu style={{ width: '14px', height: '14px' }} /> Connecteurs d'Agents
              </h3>
              
              <div className="grid-3">
                {(['ollama', 'hermes', 'minimax'] as AgentProvider[]).map((prov) => (
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
                </div>
              )}

              {agentConfig.provider === 'minimax' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <label className="label-title">Clé API Minimax</label>
                    <input 
                      type="password" 
                      value={agentConfig.minimaxApiKey}
                      onChange={(e) => saveConfig({ ...agentConfig, minimaxApiKey: e.target.value })}
                      className="glow-input"
                      style={{ padding: '8px 12px', fontSize: '12px' }}
                      placeholder="Ex: MM-..."
                    />
                  </div>
                  <div className="grid-2">
                    <div>
                      <label className="label-title">Minimax Group ID</label>
                      <input 
                        type="text" 
                        value={agentConfig.minimaxGroupId}
                        onChange={(e) => saveConfig({ ...agentConfig, minimaxGroupId: e.target.value })}
                        className="glow-input"
                        style={{ padding: '8px 12px', fontSize: '12px' }}
                        placeholder="Ex: 1234567"
                      />
                    </div>
                    <div>
                      <label className="label-title">Modèle Actuel</label>
                      <select
                        value={agentConfig.minimaxModel}
                        onChange={(e) => saveConfig({ ...agentConfig, minimaxModel: e.target.value })}
                        className="glow-input"
                        style={{ padding: '8px 12px', fontSize: '12px', width: '100%' }}
                      >
                        {minimaxModelsList.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  
                  <div style={{ marginTop: '4px' }}>
                    <button
                      onClick={handleLoadMinimaxModels}
                      className="neon-btn neon-btn-secondary"
                      style={{ width: '100%', padding: '8px 16px', fontSize: '11px', gap: '6px', cursor: 'pointer' }}
                      disabled={isLoadingMinimaxModels}
                    >
                      {isLoadingMinimaxModels ? "Chargement des modèles..." : "Charger les modèles disponibles"}
                    </button>
                    {minimaxModelsError && (
                      <span style={{ fontSize: '10px', color: '#ef4444', display: 'block', marginTop: '6px', fontWeight: 'bold' }}>
                        ⚠️ {minimaxModelsError} (Utilisation des modèles par défaut)
                      </span>
                    )}
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

