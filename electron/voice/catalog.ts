import type { VoiceModelSpec, VoiceSpeaker } from '../../shared/voice';

const ASR = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const KWS = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models';
const TTS = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models';

const KOKORO_SPEAKERS: VoiceSpeaker[] = [
  { id: 30, name: 'Siwis (femme, français)', lang: 'fr' },
  { id: 3, name: 'Heart (femme, anglais US)', lang: 'en' },
  { id: 2, name: 'Bella (femme, anglais US)', lang: 'en' },
  { id: 7, name: 'Nova (femme, anglais US)', lang: 'en' },
  { id: 11, name: 'Adam (homme, anglais US)', lang: 'en' },
  { id: 16, name: 'Michael (homme, anglais US)', lang: 'en' },
  { id: 17, name: 'Onyx (homme, anglais US)', lang: 'en' },
  { id: 21, name: 'Emma (femme, anglais UK)', lang: 'en' },
  { id: 24, name: 'Daniel (homme, anglais UK)', lang: 'en' },
  { id: 26, name: 'George (homme, anglais UK)', lang: 'en' }
];

export const VOICE_CATALOG: VoiceModelSpec[] = [
  {
    id: 'whisper-base',
    kind: 'stt',
    engine: 'whisper',
    name: 'Whisper base (multilingue)',
    description: 'Le plus rapide sur CPU ; précision moyenne en français, suffisante pour des commandes courtes.',
    languages: ['fr', 'en', 'multi'],
    sizeMb: 208,
    url: `${ASR}/sherpa-onnx-whisper-base.tar.bz2`,
    dir: 'sherpa-onnx-whisper-base',
    files: ['base-encoder.int8.onnx', 'base-decoder.int8.onnx', 'base-tokens.txt'],
    recommended: true
  },
  {
    id: 'whisper-small',
    kind: 'stt',
    engine: 'whisper',
    name: 'Whisper small (multilingue)',
    description: 'Recommandé pour le français : nettement plus précis que base, environ trois fois plus lent.',
    languages: ['fr', 'en', 'multi'],
    sizeMb: 640,
    url: `${ASR}/sherpa-onnx-whisper-small.tar.bz2`,
    dir: 'sherpa-onnx-whisper-small',
    files: ['small-encoder.int8.onnx', 'small-decoder.int8.onnx', 'small-tokens.txt'],
    recommended: true
  },
  {
    id: 'whisper-turbo',
    kind: 'stt',
    engine: 'whisper',
    name: 'Whisper large-v3 turbo (multilingue)',
    description: 'La meilleure précision ; demande un processeur puissant.',
    languages: ['fr', 'en', 'multi'],
    sizeMb: 564,
    url: `${ASR}/sherpa-onnx-whisper-turbo.tar.bz2`,
    dir: 'sherpa-onnx-whisper-turbo',
    files: ['turbo-encoder.int8.onnx', 'turbo-decoder.int8.onnx', 'turbo-tokens.txt']
  },
  {
    id: 'sense-voice',
    kind: 'stt',
    engine: 'sense-voice',
    name: 'SenseVoice small (zh / en / ja / ko)',
    description: 'Très rapide, mais ne comprend pas le français.',
    languages: ['en', 'zh', 'ja', 'ko'],
    sizeMb: 163,
    url: `${ASR}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`,
    dir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
    files: ['model.int8.onnx', 'tokens.txt']
  },
  {
    id: 'kws-en',
    kind: 'kws',
    engine: 'kws-transducer',
    name: 'Détecteur de mot-clé (zipformer, 3 Mo)',
    description: 'Écoute permanente du mot d’activation, quasi gratuite en CPU. Mot-clé libre (« jarvis », « hey jarvis »…).',
    languages: ['en', 'fr'],
    sizeMb: 4,
    url: `${KWS}/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2`,
    dir: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
    files: [
      'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      'tokens.txt'
    ],
    recommended: true
  },
  {
    id: 'silero-vad',
    kind: 'vad',
    engine: 'silero',
    name: 'Silero VAD (fin de phrase neuronale, 0,6 Mo)',
    description: 'Détecte précisément le début et la fin de la parole pendant l’écoute permanente ; moins de faux départs sur le bruit.',
    languages: ['multi'],
    sizeMb: 1,
    url: `${ASR}/silero_vad.onnx`,
    dir: 'silero-vad',
    files: ['silero_vad.onnx'],
    recommended: true
  },
  {
    id: 'kokoro-v1',
    kind: 'tts',
    engine: 'kokoro',
    name: 'Kokoro v1.0 multilingue',
    description: 'Voix très naturelle, une voix française (Siwis) et de nombreuses voix anglaises. 24 kHz.',
    languages: ['fr', 'en', 'multi'],
    sizeMb: 349,
    url: `${TTS}/kokoro-multi-lang-v1_0.tar.bz2`,
    dir: 'kokoro-multi-lang-v1_0',
    files: ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'espeak-ng-data/phontab'],
    speakers: KOKORO_SPEAKERS,
    sampleRate: 24000,
    recommended: true
  },
  {
    id: 'piper-fr-siwis',
    kind: 'tts',
    engine: 'piper',
    name: 'Piper Siwis (femme, français)',
    description: 'Léger et instantané, rendu un peu plus mécanique que Kokoro. 22 kHz.',
    languages: ['fr'],
    sizeMb: 67,
    url: `${TTS}/vits-piper-fr_FR-siwis-medium.tar.bz2`,
    dir: 'vits-piper-fr_FR-siwis-medium',
    files: ['fr_FR-siwis-medium.onnx', 'tokens.txt', 'espeak-ng-data/phontab'],
    speakers: [{ id: 0, name: 'Siwis', lang: 'fr' }],
    sampleRate: 22050
  },
  {
    id: 'piper-fr-tom',
    kind: 'tts',
    engine: 'piper',
    name: 'Piper Tom (homme, français)',
    description: 'Voix masculine légère et instantanée. 22 kHz.',
    languages: ['fr'],
    sizeMb: 67,
    url: `${TTS}/vits-piper-fr_FR-tom-medium.tar.bz2`,
    dir: 'vits-piper-fr_FR-tom-medium',
    files: ['fr_FR-tom-medium.onnx', 'tokens.txt', 'espeak-ng-data/phontab'],
    speakers: [{ id: 0, name: 'Tom', lang: 'fr' }],
    sampleRate: 22050
  },
  {
    id: 'piper-fr-upmc',
    kind: 'tts',
    engine: 'piper',
    name: 'Piper UPMC (Jessica et Pierre, français)',
    description: 'Deux voix françaises, une féminine et une masculine. 22 kHz.',
    languages: ['fr'],
    sizeMb: 80,
    url: `${TTS}/vits-piper-fr_FR-upmc-medium.tar.bz2`,
    dir: 'vits-piper-fr_FR-upmc-medium',
    files: ['fr_FR-upmc-medium.onnx', 'tokens.txt', 'espeak-ng-data/phontab'],
    speakers: [
      { id: 0, name: 'Jessica (femme)', lang: 'fr' },
      { id: 1, name: 'Pierre (homme)', lang: 'fr' }
    ],
    sampleRate: 22050
  }
];

export function findModel(id: string): VoiceModelSpec | undefined {
  return VOICE_CATALOG.find((m) => m.id === id);
}
