export interface VoiceOption {
  name: string;
  lang: string;
  voice: SpeechSynthesisVoice;
}

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

  // Récupérer les voix françaises et globales disponibles
  public getVoices(): VoiceOption[] {
    if (!this.ttsSynth) return [];
    return this.ttsSynth.getVoices().map(v => ({
      name: v.name,
      lang: v.lang,
      voice: v
    }));
  }

  private _resolveVoice(voiceName?: string): SpeechSynthesisVoice | undefined {
    const voices = this.ttsSynth.getVoices();
    if (voiceName) return voices.find(v => v.name === voiceName);
    return voices.find(v => v.lang.startsWith('fr') && v.name.toLowerCase().includes('google'))
      || voices.find(v => v.lang.startsWith('fr'));
  }

  private _cleanForTTS(raw: string): string {
    // 1. Extraire le texte des liens Markdown [Texte](url). Gère aussi les parenthèses dans les URLs
    let cleaned = raw.replace(/\[([^\]]+)\]\((?:[^)(]+|\([^)(]*\))*\)/g, '$1');

    // 2. Supprimer toutes les URLs nues (http, https, ftp, file) complexes ou simples
    cleaned = cleaned.replace(/(?:https?|ftp|file):\/\/\S+/gi, '');

    // 3. Supprimer les adresses commençant par www.
    cleaned = cleaned.replace(/www\.\S+/gi, '');

    // 4. Supprimer tout mot technique contenant des chemins de fichiers, adresses IP ou segments techniques
    // (ex: C:\chemin, localhost:8080, v1/chat/completions)
    const words = cleaned.split(/\s+/);
    cleaned = words
      .filter(word => {
        // Exclure les mots qui ressemblent à des chemins ou contiennent des slashes / backslashes
        if (word.includes('/') || word.includes('\\')) {
          return false;
        }
        // Exclure les hôtes avec port (ex: localhost:8080, 127.0.0.1:8642)
        if (/(?:[a-zA-Z0-9-]+\.[a-zA-Z]{2,6}|localhost|[\d.]+):\d+/.test(word)) {
          return false;
        }
        // Exclure les adresses IP nues
        if (/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(word)) {
          return false;
        }
        return true;
      })
      .join(' ');

    return cleaned
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
