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

  constructor() {
    this.ttsSynth = window.speechSynthesis;
    this.initSTT();
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
    // 1. Améliorer la ponctuation Markdown pour forcer des pauses de diction naturelles
    // Remplacer les puces de liste (ex: - item, * item) par une pause douce (virgule)
    let formatted = raw.replace(/(?:\r?\n)\s*[-*+]\s+/g, ', ');
    
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

  // Synthèse Vocale complète (annule et relit tout le texte)
  public speak(text: string, voiceName?: string, rate: number = 1.0, pitch: number = 1.1): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ttsSynth) { reject('TTS non supporté'); return; }
      this.ttsSynth.cancel();
      const u = this._makeUtterance(text, voiceName, rate, pitch);
      u.onend = () => resolve();
      u.onerror = (e) => reject(e);
      this.ttsSynth.speak(u);
    });
  }

  // Ajoute une phrase à la file TTS sans annuler la lecture en cours
  // Utilisé pour le streaming phrase par phrase (démarre l'audio dès la 1ère phrase)
  public queueSentence(text: string, voiceName?: string, rate: number = 1.0, pitch: number = 1.1): void {
    if (!this.ttsSynth) return;
    const clean = text.trim();
    if (!clean) return;
    const u = this._makeUtterance(clean, voiceName, rate, pitch);
    if (u.text.trim()) {
      this.ttsSynth.speak(u); // s'enchaîne automatiquement à la file SpeechSynthesis
    }
  }

  // Vide la file TTS (fin du streaming ou interruption utilisateur)
  public flushQueue(): void {
    if (this.ttsSynth) this.ttsSynth.cancel();
  }

  // Arrêter immédiatement de parler
  public stopSpeaking() {
    if (this.ttsSynth) {
      this.ttsSynth.cancel();
    }
  }

  // Lancer l'écoute vocale (STT - Speech-To-Text)
  public startListening(
    onResult: (text: string) => void,
    onStart: () => void,
    onEnd: () => void,
    onError: (err: string) => void,
    lang: string = 'fr-FR'
  ) {
    if (!this.recognition) {
      onError("STT non supporté");
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

  // Arrêter l'écoute vocale
  public stopListening() {
    if (this.recognition && this.isListeningActive) {
      this.recognition.stop();
      this.isListeningActive = false;
    }
  }
}
