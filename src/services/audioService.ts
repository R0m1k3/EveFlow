export interface VoiceOption {
  name: string;
  lang: string;
  voice: SpeechSynthesisVoice;
}

// Dictionnaire phonétique local pour corriger la prononciation des acronymes et anglicismes en français
const PHONETIC_DICTIONARY: Record<string, string> = {
  'api': 'a-pé-i',
  'cors': 'korss',
  'svg': 'ess-vé-gé',
  'cpu': 'cé-pé-u',
  'fps': 'eff-pé-ess',
  'tts': 'té-té-ess',
  'ui': 'u-i',
  'ai': 'a-i',
  'ia': 'i-a',
  'json': 'dji-zone',
  'url': 'u-err-el',
  'html': 'ach-té-em-el',
  'css': 'cé-ess-ess',
  'js': 'ji-ess',
  'typescript': 'taïpe-skript',
  'javascript': 'djava-skript',
  'electron': 'élèktron',
  'react': 'ri-akt',
  'github': 'gitte-ub',
  'git': 'gitte',
  'setup': 'sétup',
  'c++': 'cé-plus-plus',
  'node.js': 'node-j-s',
  'nodejs': 'node-j-s',
  'database': 'deïta-beïss',
  'token': 'tokène',
  'cli': 'cé-el-i',
  'npm': 'en-pé-em',
  'npx': 'en-pé-ix',
  'vite': 'vite',
  'vscode': 'vé-ess-code',
  'vs code': 'vé-ess-code',
  'windows': 'windoze',
  'macos': 'mak-os',
  'linux': 'linux',
  'docker': 'dokeur',
  'cyberpunk': 'saïbeur-pounk',
  'avatar': 'avatar',
  'chat': 'tchat',
  'prompt': 'prompte',
  'welcome': 'ouel-kome',
  'ipc': 'i-pé-cé'
};

export class AudioService {
  public ttsSynth: SpeechSynthesis;
  private recognition: any = null;
  private isListeningActive = false;
  private currentAudioElement: HTMLAudioElement | null = null;
  private audioQueue: { text: string; voiceName?: string; rate: number; pitch: number; provider: 'system' | 'google-free' | 'openai-tts' }[] = [];
  private isPlayingQueue = false;
  private activeReject: ((err: any) => void) | null = null;

  // ASR/STT & TTS Custom API settings
  private sttProvider: 'browser' | 'qwen3-asr' = 'browser';
  private sttApiUrl = 'http://127.0.0.1:8000/v1';
  private sttApiKey = '';
  private sttModel = 'Qwen/Qwen3-ASR-0.6B';
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];

  private ttsApiUrl = 'http://127.0.0.1:8000/v1';
  private ttsApiKey = '';
  private ttsModel = 'tts-1';

  public get isSpeakingActive(): boolean {
    return this.isPlayingQueue || this.audioQueue.length > 0;
  }

  private logError(tag: string, message: string, data?: any) {
    console.error(`[${tag}] ${message}`, data);
    if ((window as any).electronAPI?.writeLog) {
      (window as any).electronAPI.writeLog({
        ts: new Date().toISOString(),
        level: 'ERROR',
        tag,
        message,
        data: data ? { message: data.message, stack: data.stack, ...data } : undefined
      });
    }
  }
  
  private logWarn(tag: string, message: string, data?: any) {
    console.warn(`[${tag}] ${message}`, data);
    if ((window as any).electronAPI?.writeLog) {
      (window as any).electronAPI.writeLog({
        ts: new Date().toISOString(),
        level: 'WARN',
        tag,
        message,
        data: data ? { message: data.message, stack: data.stack, ...data } : undefined
      });
    }
  }

  constructor() {
    this.ttsSynth = window.speechSynthesis;
    this.initSTT();
  }

  // Permet de mettre à jour dynamiquement la configuration de la reconnaissance vocale
  public updateSTTConfig(provider: 'browser' | 'qwen3-asr', apiUrl: string, apiKey: string, model: string) {
    this.sttProvider = provider;
    this.sttApiUrl = apiUrl;
    this.sttApiKey = apiKey;
    this.sttModel = model;
  }

  // Permet de mettre à jour dynamiquement la configuration du lecteur de voix personnalisé
  public updateTTSConfig(apiUrl: string, apiKey: string, model: string) {
    this.ttsApiUrl = apiUrl;
    this.ttsApiKey = apiKey;
    this.ttsModel = model;
  }

  // Initialisation de la reconnaissance vocale locale et gratuite (Web Speech API)
  private initSTT() {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = false; // Arrête après une phrase
      this.recognition.interimResults = false; // Ne renvoie que les résultats finaux
      this.recognition.lang = 'fr-FR'; // Langue française par défaut
    } else {
      console.warn("La reconnaissance vocale (Speech-to-Text) n'est pas supportée dans cette WebView.");
    }
  }

  // Calculer un score de qualité pour trier les voix locales
  private _getVoiceScore(v: SpeechSynthesisVoice): number {
    const lang = v.lang.toLowerCase();
    const name = v.name.toLowerCase();
    
    if (!lang.startsWith('fr')) return 0;
    
    let score = 100; // Base français
    
    if (name.includes('google') || name.includes('online')) {
      score += 50;
    }
    if (name.includes('natural') || name.includes('neural')) {
      score += 40;
    }
    if (name.includes('mobile')) {
      score += 30;
    }
    if (name.includes('julie') || name.includes('paul')) {
      score += 20;
    }
    if (name.includes('hortense')) {
      score += 10;
    }
    
    return score;
  }

  // Récupérer les voix françaises et globales disponibles
  public getVoices(): VoiceOption[] {
    if (!this.ttsSynth) return [];
    
    const allVoices = this.ttsSynth.getVoices();
    
    // Trier pour mettre les meilleures voix françaises en haut
    const sorted = [...allVoices].sort((a, b) => {
      const scoreA = this._getVoiceScore(a);
      const scoreB = this._getVoiceScore(b);
      
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      return a.name.localeCompare(b.name);
    });

    return sorted.map(v => ({
      name: v.name,
      lang: v.lang,
      voice: v
    }));
  }

  private _resolveVoice(voiceName?: string): SpeechSynthesisVoice | undefined {
    const voices = this.ttsSynth.getVoices();
    if (voiceName) return voices.find(v => v.name === voiceName);
    
    const frVoices = voices.filter(v => v.lang.toLowerCase().startsWith('fr'));
    if (frVoices.length === 0) return voices.find(v => v.lang.startsWith('en'));
    
    // Sélectionner la voix française locale avec le meilleur score
    return frVoices.sort((a, b) => this._getVoiceScore(b) - this._getVoiceScore(a))[0];
  }

  private _applyPhoneticCorrections(text: string): string {
    let corrected = text;
    for (const [key, replacement] of Object.entries(PHONETIC_DICTIONARY)) {
      const escapedKey = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      // Regex recherchant le mot technique avec des limites Unicode ou de ponctuations
      const regex = new RegExp(`(?<=^|\\s|\\p{P})${escapedKey}(?=$|\\s|\\p{P})`, 'giu');
      corrected = corrected.replace(regex, replacement);
    }
    return corrected;
  }

  private _cleanForTTS(raw: string): string {
    // 0a. Supprimer les tokens MEDIA: (chemins de fichiers envoyés par le bot) pour ne pas les lire à voix haute
    let noMedia = raw.replace(/MEDIA:\s*\S+/g, '');

    // 0b. Supprimer complètement les blocs de code Markdown (```code```) car ils ne sont pas prononçables oralement
    let noCode = noMedia.replace(/```[\s\S]*?```/g, ' ');
    
    // 1. Améliorer la ponctuation Markdown pour forcer des pauses de diction naturelles
    // Remplacer les puces de liste (ex: - item, * item) par une pause douce (virgule)
    let formatted = noCode.replace(/(?:\r?\n)\s*[-*+]\s+/g, ', ');
    
    // Remplacer les deux-points suivis d'un saut de ligne par un point
    formatted = formatted.replace(/:\s*(?:\r?\n)/g, '. ');
    
    // Remplacer les doubles sauts de ligne par des points (pauses de paragraphes)
    formatted = formatted.replace(/(?:\r?\n){2,}/g, '. ');
    
    // Remplacer les sauts de ligne simples restant par des espaces
    formatted = formatted.replace(/(?:\r?\n)/g, ' ');

    // 2. Extraire le texte des liens Markdown [Texte](url)
    let cleaned = formatted.replace(/\[([^\]]+)\]\((?:[^)(]+|\([^)(]*\))*\)/g, '$1');

    // 3. Supprimer toutes les URLs nues (http, https, ftp, file)
    cleaned = cleaned.replace(/(?:https?|ftp|file):\/\/\S+/gi, '');

    // 4. Supprimer les adresses www.
    cleaned = cleaned.replace(/www\.\S+/gi, '');

    // 5. Filtrer les mots techniques complexes (chemins de fichiers, adresses IP)
    const words = cleaned.split(/\s+/);
    cleaned = words
      .filter(word => {
        if (word.includes('/') || word.includes('\\')) {
          return false;
        }
        if (/(?:[a-zA-Z0-9-]+\.[a-zA-Z]{2,6}|localhost|[\d.]+):\d+/.test(word)) {
          return false;
        }
        if (/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(word)) {
          return false;
        }
        return true;
      })
      .join(' ');

    // 6. Nettoyer les caractères Markdown, Emojis et symboles non prononçables
    cleaned = cleaned
      // Emojis et symboles Unicode
      .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA9F}]/gu, '')
      // Markdown restant : **, *, _, __, #, `, ~
      .replace(/(\*\*|__|~~|[*_#`~])/g, '')
      // Balises techniques résiduelles [⚙️ Exécution...]
      .replace(/\[[^\]]*\]/g, '')
      // Ponctuation répétée ou décorative : ---, ===, ~~~, ...
      .replace(/(-{2,}|={2,}|~{2,}|\.{2,})/g, ' ')
      // Caractères techniques restants non lisibles
      .replace(/[<>{}|\\^]/g, '')
      // Espaces multiples
      .replace(/\s{2,}/g, ' ')
      .trim();

    // 7. Appliquer les corrections phonétiques locales
    return this._applyPhoneticCorrections(cleaned);
  }

  private _makeUtterance(text: string, voiceName?: string, rate = 1.0, pitch = 1.1): SpeechSynthesisUtterance {
    const clean = this._cleanForTTS(text);
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'fr-FR';
    u.rate = rate;
    u.pitch = pitch;
    const voice = this._resolveVoice(voiceName);
    if (voice) u.voice = voice;
    return u;
  }

  // Moteur Google TTS gratuit en ligne avec découpage intelligent
  private async speakGoogleFree(text: string, rate: number): Promise<void> {
    const cleanText = this._cleanForTTS(text);
    if (!cleanText.trim()) return;

    const chunks: string[] = [];
    let currentChunk = '';
    
    // Regex pour couper en phrases
    const sentences = cleanText.match(/[^.!?]+[.!?]*|.+/g) || [cleanText];
    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > 180) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        if (sentence.length > 180) {
          const words = sentence.split(/\s+/);
          let temp = '';
          for (const word of words) {
            if ((temp + ' ' + word).length > 180) {
              chunks.push(temp.trim());
              temp = word;
            } else {
              temp += (temp ? ' ' : '') + word;
            }
          }
          if (temp) currentChunk = temp;
        } else {
          currentChunk = sentence;
        }
      } else {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
      }
    }
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    for (const chunk of chunks) {
      if (!chunk) continue;
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=fr&client=tw-ob&q=${encodeURIComponent(chunk)}`;
      await new Promise<void>((resolve, reject) => {
        const audio = new Audio(url);
        this.currentAudioElement = audio;
        audio.playbackRate = rate;
        this.activeReject = reject;
        
        const timeout = setTimeout(() => {
          if (this.currentAudioElement === audio) this.currentAudioElement = null;
          this.activeReject = null;
          audio.pause();
          reject(new Error("playback_stopped"));
        }, 15000);
        
        audio.onended = () => {
          clearTimeout(timeout);
          if (this.currentAudioElement === audio) this.currentAudioElement = null;
          this.activeReject = null;
          resolve();
        };
        
        audio.onerror = () => {
          clearTimeout(timeout);
          if (this.currentAudioElement === audio) this.currentAudioElement = null;
          this.activeReject = null;
          const code = audio.error ? audio.error.code : 'UNKNOWN';
          const msg = audio.error ? audio.error.message : 'No message';
          reject(new Error(`Erreur de chargement Google TTS (code: ${code}, msg: ${msg})`));
        };
        
        audio.play().catch((err) => {
          clearTimeout(timeout);
          if (this.currentAudioElement === audio) this.currentAudioElement = null;
          this.activeReject = null;
          reject(err);
        });
      });
    }
  }

  // Synthese vocale personnalisee via API OpenAI /v1/audio/speech
  private async speakCustomAPI(text: string, voiceName?: string, rate: number = 1.0): Promise<void> {
    const cleanText = this._cleanForTTS(text);
    if (!cleanText.trim()) return;

    if (!this.ttsApiUrl) {
      throw new Error("L'URL de l'API TTS n'est pas configurée.");
    }

    const base = this.ttsApiUrl.replace(/\/$/, '');
    let endpoint: string;
    if (base.endsWith('/speech')) {
      endpoint = base;
    } else if (base.endsWith('/v1')) {
      endpoint = `${base}/audio/speech`;
    } else {
      endpoint = `${base}/v1/audio/speech`;
    }

    const body = {
      model: this.ttsModel || 'tts-1',
      input: cleanText,
      voice: voiceName || 'alloy'
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.ttsApiKey) {
      headers['Authorization'] = `Bearer ${this.ttsApiKey.trim()}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const rawErr = await response.text().catch(() => '(no body)');
      let errMsg = `Erreur TTS API: ${response.status}`;
      try {
        const parsed = JSON.parse(rawErr);
        errMsg = parsed.error?.message || parsed.message || rawErr;
      } catch {}
      throw new Error(errMsg);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    await new Promise<void>((resolve, reject) => {
      const audio = new Audio(url);
      this.currentAudioElement = audio;
      audio.playbackRate = rate;
      this.activeReject = reject;

      const timeout = setTimeout(() => {
        if (this.currentAudioElement === audio) this.currentAudioElement = null;
        this.activeReject = null;
        audio.pause();
        reject(new Error("playback_stopped"));
      }, 60000); // 60 secondes max pour une portion

      audio.onended = () => {
        clearTimeout(timeout);
        if (this.currentAudioElement === audio) this.currentAudioElement = null;
        this.activeReject = null;
        URL.revokeObjectURL(url);
        resolve();
      };

      audio.onerror = () => {
        clearTimeout(timeout);
        if (this.currentAudioElement === audio) this.currentAudioElement = null;
        this.activeReject = null;
        URL.revokeObjectURL(url);
        const code = audio.error ? audio.error.code : 'UNKNOWN';
        const msg = audio.error ? audio.error.message : 'No message';
        reject(new Error(`Erreur de lecture audio API (code: ${code}, msg: ${msg})`));
      };

      audio.play().catch((err) => {
        clearTimeout(timeout);
        if (this.currentAudioElement === audio) this.currentAudioElement = null;
        this.activeReject = null;
        URL.revokeObjectURL(url);
        reject(err);
      });
    });
  }

  // File de traitement asynchrone des phrases de synthèse vocale (Zero Trust & Zero Dependency)
  private async processQueue(): Promise<void> {
    if (this.isPlayingQueue) return;
    this.isPlayingQueue = true;

    while (this.audioQueue.length > 0) {
      const item = this.audioQueue.shift();
      if (!item) continue;

      try {
        if (item.provider === 'google-free') {
          await this.speakGoogleFree(item.text, item.rate);
        } else if (item.provider === 'openai-tts') {
          await this.speakCustomAPI(item.text, item.voiceName, item.rate);
        } else {
          await new Promise<void>((resolve, reject) => {
            if (!this.ttsSynth) { reject('TTS non supporté'); return; }
            const u = this._makeUtterance(item.text, item.voiceName, item.rate, item.pitch);
            u.onend = () => resolve();
            u.onerror = (e: any) => {
              if (e && (e.error === 'interrupted' || e.error === 'canceled')) {
                reject(new Error("playback_stopped"));
              } else {
                reject(new Error("Erreur de diction système"));
              }
            };
            this.ttsSynth.speak(u);
          });
        }
      } catch (err: any) {
        if (err?.message === 'playback_stopped') {
          break;
        }
        this.logWarn("AudioService", "Échec de la lecture de la phrase dans la file", err);
        if (item.provider === 'google-free' || item.provider === 'openai-tts') {
          // Repli automatique transparent sur la voix locale hors-ligne pour ce segment précis en cas de défaillance
          try {
            await new Promise<void>((resolve, reject) => {
              if (!this.ttsSynth) { reject('TTS non supporté'); return; }
              const u = this._makeUtterance(item.text, item.voiceName, item.rate, item.pitch);
              u.onend = () => resolve();
              u.onerror = (e: any) => {
                if (e && (e.error === 'interrupted' || e.error === 'canceled')) {
                  reject(new Error("playback_stopped"));
                } else {
                  reject(new Error("Erreur de diction système"));
                }
              };
              this.ttsSynth.speak(u);
            });
          } catch (fallbackErr: any) {
            if (fallbackErr?.message === 'playback_stopped') {
              break;
            }
            this.logError("AudioService", "Échec également du repli système", fallbackErr);
          }
        }
      }
    }

    this.isPlayingQueue = false;
  }

  // Synthèse Vocale complète (annule et relit tout le texte)
  public async speak(
    text: string, 
    voiceName?: string, 
    rate: number = 1.0, 
    pitch: number = 1.1,
    provider: 'system' | 'google-free' | 'openai-tts' = 'google-free'
  ): Promise<void> {
    this.stopSpeaking();
    this.queueSentence(text, voiceName, rate, pitch, provider);
    
    // Attendre la fin complète de la lecture pour résoudre la promesse
    while (this.isPlayingQueue || this.audioQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  // Ajoute une phrase à la file de lecture vocale pour un enchaînement fluide en temps réel (streaming)
  public queueSentence(
    text: string, 
    voiceName?: string, 
    rate: number = 1.0, 
    pitch: number = 1.1,
    provider: 'system' | 'google-free' | 'openai-tts' = 'google-free'
  ): void {
    const clean = text.trim();
    if (!clean) return;
    this.audioQueue.push({ text: clean, voiceName, rate, pitch, provider });
    this.processQueue();
  }

  // Vide la file TTS (fin du streaming ou interruption utilisateur)
  public flushQueue(): void {
    this.audioQueue = [];
    this.isPlayingQueue = false;
    if (this.ttsSynth) this.ttsSynth.cancel();
    if (this.currentAudioElement) {
      this.currentAudioElement.pause();
      this.currentAudioElement = null;
    }
    if (this.activeReject) {
      this.activeReject(new Error("playback_stopped"));
      this.activeReject = null;
    }
  }

  // Arrêter immédiatement de parler et vider la file
  public stopSpeaking() {
    this.audioQueue = [];
    this.isPlayingQueue = false;
    if (this.ttsSynth) {
      this.ttsSynth.cancel();
    }
    if (this.currentAudioElement) {
      this.currentAudioElement.pause();
      this.currentAudioElement = null;
    }
    if (this.activeReject) {
      this.activeReject(new Error("playback_stopped"));
      this.activeReject = null;
    }
  }

  // Démarrer l'écoute vocale API via MediaRecorder
  private async startListeningAPI(
    onResult: (text: string) => void,
    onStart: () => void,
    onEnd: () => void,
    onError: (err: string) => void,
    lang: string
  ) {
    if (this.isListeningActive) {
      this.stopListening();
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];

      let options = {};
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        options = { mimeType: 'audio/webm;codecs=opus' };
      } else if (MediaRecorder.isTypeSupported('audio/webm')) {
        options = { mimeType: 'audio/webm' };
      }

      this.mediaRecorder = new MediaRecorder(stream, options);
      this.isListeningActive = true;

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstart = () => {
        onStart();
      };

      this.mediaRecorder.onstop = async () => {
        this.isListeningActive = false;
        onEnd();

        // Stopper toutes les pistes pour éteindre le voyant du microphone
        stream.getTracks().forEach(track => track.stop());

        if (this.audioChunks.length === 0) {
          onError("Aucune donnée audio capturée");
          return;
        }

        const audioBlob = new Blob(this.audioChunks, { type: this.mediaRecorder?.mimeType || 'audio/webm' });

        try {
          const text = await this.transcribeAudioWithAPI(audioBlob, lang);
          onResult(text);
        } catch (err: any) {
          onError(err.message || "Erreur de transcription de l'API");
        }
      };

      this.mediaRecorder.start();
    } catch (err: any) {
      this.isListeningActive = false;
      onError(err.message || "Impossible d'accéder au microphone.");
    }
  }

  // Requête API Speech-To-Text compatible OpenAI /v1/audio/transcriptions
  private async transcribeAudioWithAPI(audioBlob: Blob, lang: string): Promise<string> {
    if (!this.sttApiUrl) {
      throw new Error("L'URL de l'API STT n'est pas configurée.");
    }

    const base = this.sttApiUrl.replace(/\/$/, '');
    let endpoint: string;
    if (base.endsWith('/transcriptions')) {
      endpoint = base;
    } else if (base.endsWith('/v1')) {
      endpoint = `${base}/audio/transcriptions`;
    } else {
      endpoint = `${base}/v1/audio/transcriptions`;
    }

    const formData = new FormData();
    const ext = audioBlob.type.includes('wav') ? 'wav' : 'webm';
    formData.append('file', audioBlob, `audio.${ext}`);
    formData.append('model', this.sttModel || 'qwen3-asr');

    if (lang) {
      const isoLang = lang.split('-')[0];
      formData.append('language', isoLang);
    }

    const headers: Record<string, string> = {};
    if (this.sttApiKey) {
      headers['Authorization'] = `Bearer ${this.sttApiKey.trim()}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: formData
    });

    if (!response.ok) {
      const rawErr = await response.text().catch(() => '(no body)');
      let errMsg = `Erreur STT API: ${response.status}`;
      try {
        const parsed = JSON.parse(rawErr);
        errMsg = parsed.error?.message || parsed.message || rawErr;
      } catch {}
      throw new Error(errMsg);
    }

    const data = await response.json();
    if (data && typeof data.text === 'string') {
      return data.text;
    }

    throw new Error("Format de réponse de l'API STT invalide.");
  }

  // Lancer l'écoute vocale (STT - Speech-To-Text)
  public startListening(
    onResult: (text: string) => void,
    onStart: () => void,
    onEnd: () => void,
    onError: (err: string) => void,
    lang: string = 'fr-FR'
  ) {
    if (this.sttProvider === 'qwen3-asr') {
      this.startListeningAPI(onResult, onStart, onEnd, onError, lang);
    } else {
      if (!this.recognition) {
        onError("STT non supporté par ce navigateur");
        return;
      }

      if (this.isListeningActive) {
        this.recognition.stop();
      }

      this.recognition.lang = lang;
      this.isListeningActive = true;

      this.recognition.onstart = () => {
        onStart();
      };

      this.recognition.onresult = (event: any) => {
        const resultText = event.results[0][0].transcript;
        onResult(resultText);
      };

      this.recognition.onerror = (event: any) => {
        onError(event.error);
      };

      this.recognition.onend = () => {
        this.isListeningActive = false;
        onEnd();
      };

      try {
        this.recognition.start();
      } catch (e: any) {
        onError(e.message || "Erreur de démarrage de l'écoute");
      }
    }
  }

  // Arrêter l'écoute vocale
  public stopListening() {
    if (this.sttProvider === 'qwen3-asr') {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
        this.isListeningActive = false;
      }
    } else {
      if (this.recognition && this.isListeningActive) {
        this.recognition.stop();
        this.isListeningActive = false;
      }
    }
  }
}
