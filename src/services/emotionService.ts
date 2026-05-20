export type EveEmotion = 'neutral' | 'happy' | 'sad' | 'surprised' | 'thinking' | 'angry';
export type EveAvatar = 'eve' | 'nova' | 'aegis';

export class EmotionService {
  // Analyser le sentiment d'une phrase pour en déduire l'émotion d'Eve
  public static analyzeSentiment(text: string): EveEmotion {
    const cleanText = text.toLowerCase().trim();

    // Mots-clés pour la joie / l'excitation
    const happyKeywords = [
      'génial', 'super', 'ravi', 'heureux', 'joie', 'plaisir', 'gagné', 'haha', 'cool', 'géniale', 
      'merci', 'adore', 'excellent', 'parfait', 'extraordinaire', 'bravo', 'sourire', 'heureuse',
      'magnifique', 'awesome', 'great', 'happy', 'love', 'smile'
    ];

    // Mots-clés pour la tristesse / la déception
    const sadKeywords = [
      'désolé', 'triste', 'dommage', 'regret', 'malheureusement', 'pleurer', 'hélas', 'malheur', 
      'perdu', 'sombre', 'erreur', 'échec', 'souffrir', 'bad', 'sorry', 'sad', 'unfortunately'
    ];

    // Mots-clés pour la colère / le mécontentement
    const angryKeywords = [
      'non', 'colère', 'énervé', 'fâché', 'nul', 'inacceptable', 'mauvais', 'déteste', 'pire', 
      'irritant', 'frustré', 'stupide', 'ridicule', 'assez', 'stop', 'angry', 'no', 'hate'
    ];

    // Mots-clés pour la surprise / l'émerveillement
    const surprisedKeywords = [
      'wow', 'quoi', 'incroyable', 'vraiment', 'surprise', 'surpris', 'soudain', 'extraordinaire', 
      'inattendu', 'magique', 'oh', 'ah', 'bizarre', 'étrange', 'wow', 'incredible', 'surprise'
    ];

    // Mots-clés pour la réflexion / l'analyse
    const thinkingKeywords = [
      'réfléchir', 'analyse', 'calcul', 'comprendre', 'hmm', 'euh', 'peut-être', 'probablement', 
      'possible', 'hypothèse', 'cherche', 'étudie', 'question', 'pourquoi', 'comment', 'pense',
      'thinking', 'ponder', 'analyze', 'search', 'perhaps', 'maybe'
    ];

    // 1. Analyse par présence de mots-clés prioritaires
    if (this.containsAny(cleanText, angryKeywords)) return 'angry';
    if (this.containsAny(cleanText, sadKeywords)) return 'sad';
    if (this.containsAny(cleanText, surprisedKeywords)) return 'surprised';
    if (this.containsAny(cleanText, happyKeywords)) return 'happy';
    if (this.containsAny(cleanText, thinkingKeywords)) return 'thinking';

    // 2. Analyse par ponctuation si aucun mot-clé n'est saillant
    if (cleanText.includes('!!!') || cleanText.includes('wow')) return 'surprised';
    if (cleanText.includes('?') && cleanText.length < 50) return 'thinking'; // Petite question rapide
    if (cleanText.includes('...')) return 'thinking';

    // Émotion par défaut
    return 'neutral';
  }

  // Vérifier si le texte contient au moins un des mots-clés
  private static containsAny(text: string, keywords: string[]): boolean {
    return keywords.some(keyword => {
      // Expression régulière pour rechercher le mot exact (évite les correspondances partielles fausses)
      const regex = new RegExp(`\\b${keyword}\\b|${keyword}`, 'i');
      return regex.test(text);
    });
  }

  // Renvoie les paramètres graphiques (couleur des yeux, intensité, forme) pour chaque émotion et avatar
  // Utile pour la 3D ou les shaders
  public static getEmotionStyle(emotion: EveEmotion, avatarId: EveAvatar = 'eve') {
    // Spectre de couleurs par défaut selon l'avatar sélectionné
    let eyeColor = '#00f2ff'; // Eve par défaut
    
    if (avatarId === 'nova') {
      switch (emotion) {
        case 'happy': eyeColor = '#ff0077'; break; // Luminous hot pink
        case 'sad': eyeColor = '#ff88dd'; break; // Melancholic soft pink
        case 'angry': eyeColor = '#9900ff'; break; // Furious deep purple
        case 'surprised': eyeColor = '#ffc8ff'; break; // Electric light pink
        case 'thinking': eyeColor = '#c300ff'; break; // Luminous neon violet
        case 'neutral':
        default:
          eyeColor = '#ff00ea'; // Vibrant magenta
          break;
      }
    } else if (avatarId === 'aegis') {
      switch (emotion) {
        case 'happy': eyeColor = '#ffaa00'; break; // Luminous warm gold
        case 'sad': eyeColor = '#ffa677'; break; // Melancholic dusty orange
        case 'angry': eyeColor = '#ff3300'; break; // Furious Nixie warning red
        case 'surprised': eyeColor = '#ffe4cc'; break; // Electric light amber
        case 'thinking': eyeColor = '#ff8800'; break; // Luminous bright orange
        case 'neutral':
        default:
          eyeColor = '#ff6a00'; // Vintage Nixie amber
          break;
      }
    } else {
      // 'eve' original (Cyan spectrum)
      switch (emotion) {
        case 'happy': eyeColor = '#00ffff'; break; // Luminous turquoise cyan
        case 'sad': eyeColor = '#3de7ff'; break; // Melancholic luminous soft cyan
        case 'angry': eyeColor = '#00a2ff'; break; // Furious electric cyan-blue
        case 'surprised': eyeColor = '#99f2ff'; break; // Electric light ice blue
        case 'thinking': eyeColor = '#00c3ff'; break; // Luminous sky blue
        case 'neutral':
        default:
          eyeColor = '#00f2ff'; // Signature vibrant cyan blue
          break;
      }
    }

    switch (emotion) {
      case 'happy':
        return {
          eyeColor,
          eyeScaleY: 0.6,
          eyeRotation: 0.1, // Joyous rotation
          pulseSpeed: 3.5,
          lightIntensity: 2.0
        };
      case 'sad':
        return {
          eyeColor,
          eyeScaleY: 0.45,
          eyeRotation: -0.15, // Drooping eyes
          pulseSpeed: 1.0,
          lightIntensity: 1.0
        };
      case 'angry':
        return {
          eyeColor,
          eyeScaleY: 0.3,
          eyeRotation: 0.25, // Angry angled eyes
          pulseSpeed: 4.0,
          lightIntensity: 1.8
        };
      case 'surprised':
        return {
          eyeColor,
          eyeScaleY: 1.0, // Fully open round eyes
          eyeRotation: 0,
          pulseSpeed: 5.0,
          lightIntensity: 2.5
        };
      case 'thinking':
        return {
          eyeColor,
          eyeScaleY: 0.5, // Half closed thinking eyes
          eyeRotation: -0.05,
          pulseSpeed: 1.8,
          lightIntensity: 1.3
        };
      case 'neutral':
      default:
        return {
          eyeColor,
          eyeScaleY: 0.65, // Standard oblong shape
          eyeRotation: 0,
          pulseSpeed: 2.0,
          lightIntensity: 1.5
        };
    }
  }
}
