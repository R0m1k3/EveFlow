# Feuille de route : vers un vrai JARVIS

État au 3 septembre 2026, après la revue complète du code (trois audits : processus principal, services/état, interface) et le test de bout en bout de l'application Electron sous Xvfb avec les vrais modèles.

## Ce qui existe déjà

| Capacité | État | Notes |
|---|---|---|
| HUD arc-reactor réactif au son | Fait | Canvas 2D optimisé (pas d'ombres, couleurs en cache, 30 fps en veille, arrêt fenêtre masquée) |
| Reconnaissance vocale locale | Fait | Whisper base/small/turbo via sherpa-onnx dans un processus utilitaire |
| Synthèse vocale locale | Fait (2.5.0) | Supertonic 3 (31 langues, 5 voix masculines + 5 féminines, 44 kHz), Kokoro v1.0 (anglais ; français féminin avec accent) et Piper fr |
| Synthèse vocale en ligne | Fait (2.5.0) | Voix neuronales Microsoft Edge (Henri, Denise, Rémy, Vivienne…), gratuites, sans clé, via WebSocket signé dans le processus principal |
| Mot d'activation permanent | Fait (2.2.0) | Keyword spotting sherpa-onnx en continu ; mot-clé libre encodé en BPE ; validé sur audio réel (détection, zéro faux positif sur le test anglais) |
| Mot d'activation après transcription | Fait | Filtre « Jarvis … » en mains libres, tolérant aux erreurs de transcription |
| Détection de fin de phrase | Fait (2.3.0) | Silero VAD neuronal dans le worker (segment renvoyé au renderer), repli sur le VAD énergétique si le modèle manque |
| Vision d'écran | Fait (2.3.0) | Capture `desktopCapturer` jointe à la requête Hermes (bouton, ou « regarde mon écran ») |
| Serveur MCP local (outils du PC pour Hermes) | Fait (2.4.0) | `/mcp` sur le serveur webhook, JSON-RPC Streamable HTTP, 14 outils dont la capture d'écran renvoyée en image |
| Heures calmes, priorités, résumé vocal | Fait (2.4.0) | Paramètres → Notifications ; thème nuit automatique ; badge non-lus |
| Mode mission (second modèle) | Fait (2.4.0) | Bouton dans la barre de commande ; modèle dédié aux tâches longues |
| Widget compact glanceable | Fait (2.4.0) | État, dernière phrase, non-lus, indicateurs |
| Barge-in | Fait (2.4.0) | Coupe la voix dès que l'utilisateur parle ; seuil relevé pendant la synthèse (à valider avec l'annulation d'écho Windows) |
| Actions système locales | Fait (2.3.0) | Verrouillage, volume et touches média, ouvrir une application ou une URL, presse-papiers, recherche de fichiers ; intentions courtes exécutées sans passer par Hermes |
| Hermes : runs, sessions, chat completions | Fait | Transport choisi selon `/v1/capabilities` |
| Approbations, steer, stop | Fait | Modales, injection de consigne en cours de run |
| Crons, skills, toolsets, sessions | Fait | Panneau Hermes Ops |
| Webhook local (Telegram, crons) | Fait | Loopback par défaut, secret pour le LAN |
| Télémétrie réelle | Fait | CPU, RAM, fréquence, FPS, uptime |

## Ce que les meilleurs projets « Jarvis » de 2026 font en plus

Sources : [jarvis-desktop-ai](https://github.com/ccarloshenri/jarvis-desktop-ai), [JarvisAi](https://github.com/PanPenek/JarvisAi), [bertrandmbanwi/Jarvis](https://github.com/bertrandmbanwi/Jarvis), [InterGenJLU/jarvis](https://github.com/InterGenJLU/jarvis), [livekit-wakeword](https://livekit.com/blog/livekit-wakeword), [sherpa-onnx keyword spotting](https://k2-fsa.github.io/sherpa/onnx/kws/index.html), [Hermes Agent features](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview).

1. **Mot d'activation permanent, quasi gratuit en CPU.** Les projets de référence utilisent openWakeWord (« hey jarvis ») ou un modèle de keyword spotting qui écoute en continu, au lieu de transcrire chaque phrase. sherpa-onnx fournit un modèle KWS anglais de 3,3 Mo qui accepte n'importe quel mot-clé sans réentraînement ; « JARVIS » s'encode `▁JA R VI S` avec son modèle BPE (vérifié). Livré en 2.2.0 (voir l'étape 1 ci-dessous).
2. **VAD neuronal (Silero) au lieu du seuil d'énergie.** Fin de phrase plus nette (environ 500 ms gagnés) et beaucoup moins de faux départs sur le bruit ambiant. Silero est déjà livré dans sherpa-onnx (`silero_vad.onnx`, 0,6 Mo). Livré en 2.3.0.
3. **Latence perçue sous la seconde.** Les références visent 1 s entre la fin de parole et le premier mot prononcé : STT rapide, premier token en streaming, TTS phrase par phrase (déjà en place), et un modèle Hermes rapide pour la conversation courante.
4. **Vision d'écran.** Capture d'écran à la demande (« Jarvis, qu'est-ce que je regarde ? ») envoyée à Hermes comme image, ou lecture d'une fenêtre. Hermes accepte déjà les images inline. Livré en 2.3.0 (transport chat completions pour les images).
5. **Actions système locales.** Ouvrir une application, régler le volume, verrouiller la session, chercher un fichier. Livré en 2.3.0 sous forme d'intentions courtes exécutées localement avant Hermes ; reste à exposer les mêmes actions à Hermes via un serveur MCP local.
6. **Proactivité.** Notifications parlées à l'arrivée d'un cron, rappel, événement webhook, avec un résumé plutôt que la lecture intégrale ; c'est en partie fait via le webhook, à enrichir avec des règles (heures calmes, priorité).
7. **Mémoire et personnalisation.** Hermes gère la mémoire longue durée (`X-Hermes-Session-Key`) ; côté EveFlow, un profil (nom, préférences de voix, style de réponse) déjà transmis dans les instructions.

## Plan proposé

### Étape 1 : écoute permanente — livrée en 2.2.0
- Le renderer garde un seul flux micro (AudioWorklet 16 kHz) et envoie des blocs de 256 ms au processus principal, qui alimente le `KeywordSpotter` sherpa-onnx dans le worker.
- Mots-clés encodés en BPE (table SentencePiece pour les mots courants, repli glouton sur le vocabulaire du modèle), sensibilité réglable (seuil 0,45 → 0,12).
- À la détection : chime, capture de la commande sur le même flux (VAD énergétique, pré-roll 400 ms), transcription locale ou API, envoi à Hermes ; retour automatique à l'écoute.
- Fin de phrase Silero livrée en 2.3.0 : le renderer envoie des trames de 128 ms au worker pendant la commande, le worker renvoie le segment WAV complet ; VAD énergétique en repli.

### Étape 2 : vision et actions locales — livrée en 2.3.0
- Capture d'écran (`desktopCapturer`, JPEG 1600 px) jointe à la requête Hermes : bouton dans la barre de commande, ou phrase « regarde mon écran… » à l'oral comme à l'écrit.
- Actions locales (processus principal, liste blanche) : verrouiller, volume/mute/lecture/piste, ouvrir une application connue ou une URL http(s), presse-papiers, recherche de fichiers dans Documents/Bureau/Téléchargements/Images.
- Routeur d'intentions FR/EN (`src/services/localCommands.ts`) exécuté avant l'envoi à Hermes ; désactivable dans Paramètres → Micro. Les phrases composées (« ouvre X puis… ») partent à Hermes.
- Exposition à Hermes via le serveur MCP local livrée en 2.4.0.

### Étape 3 : conversation plus naturelle — livrée en 2.4.0
- Barge-in : l'utilisateur qui parle par-dessus coupe la voix ; seuil d'énergie relevé pendant la synthèse pour ignorer l'écho (à valider sur Windows avec l'annulation d'écho du micro).
- Mode mission : second modèle Hermes choisi d'un clic pour les tâches longues.
- Serveur MCP local : Hermes enchaîne lui-même les actions du PC dans ses runs.

### Étape 4 : présence — livrée en 2.4.0
- Widget compact glanceable : état, dernière phrase, non-lus, indicateurs heures calmes / mission.
- Heures calmes, mots prioritaires, résumé vocal des messages entrants, thème nuit.

### Pistes suivantes
- Voix différente par contexte (nuit, travail) et profils de réponse.
- Mémoire locale des préférences transmise à Hermes (`X-Hermes-Session-Key` déjà en place).
- Validation du barge-in et des touches média sur Windows réel (retours utilisateurs).

## Résultats du test de bout en bout (Linux, Xvfb, 4 cœurs lents)

| Étape | Résultat |
|---|---|
| Pont Electron, télémétrie, webhook | OK |
| Conversation via runs (streaming, outils, sous-agent) | OK |
| Kokoro (fr) → Whisper base, phrase courte de 2 s | synthèse 2,9 s, transcription 2,5 s, texte approximatif |
| Kokoro (fr) → Whisper base, phrase de 7 s | transcription correcte à un mot près |
| Piper (fr) → Whisper base | transcription exacte |
| Silero VAD sur phrase Kokoro de 2,3 s (2.3.0) | un seul segment, début et fin détectés, 6,7 s d'audio traités en 190 ms |
| Capture d'écran → Hermes (2.3.0) | JPEG de 107 ko reçu côté Hermes (mock chat completions) |
| Intention locale « coupe le son » (2.3.0) | traitée sans Hermes, résultat affiché dans le fil |
| Voix JARVIS et Parakeet (2.4.1) | timbre JARVIS (Web Audio : pitch, EQ, compression, réverbération courte), préréglage voix masculine française, Parakeet TDT v3 pour le français, worklets audio livrés en fichiers statiques (l'écoute permanente échouait sous la CSP stricte en version installée), rembourrage de silence avant la reconnaissance |
| Correctif 2.4.0.3 | un portail qui laisse passer /health mais renvoie une page web sur /v1 est traité comme une liaison en échec et déclenche la recherche de l'API (sondes /v1/capabilities, /v1/models) |
| Correctif 2.4.0.2 | une page web (portail de connexion) reçue à la place de l'API Hermes est reconnue et expliquée ; l'API est recherchée automatiquement sur le même hôte (port 8642, /api, hermes.…) et l'URL corrigée |
| Correctifs 2.4.0.1 | réponse vide en chat completions désormais expliquée (JSON non streamé ou erreur HTTP 200), la liaison ne passe plus en « dégradé » quand seule l'API des crons échoue, transcriptions parasites (« (cliquant) », « *Claire* ») ignorées, préférence de voix masculine/féminine |
| Parakeet v3 vs Whisper base sur trois phrases Piper (fr) (2.4.1) | Parakeet : 3/3 exactes avec ponctuation, 0,4 à 0,5 s à chaud (6,7 s au premier appel) ; Whisper base : erreurs sur « Jarvis », « Peux-tu », 0,7 à 0,9 s |
| Worklets audio sous CSP stricte (2.4.1) | chargement des modules statiques OK dans l'application empaquetée |
| Voix françaises (2.5.0) | Edge Henri : MP3 reçu de bout en bout (32 ko pour 4 s). Supertonic 3 en français : 10 voix, RTF 0,14 sur 4 cœurs (8,7 s d'audio en 1,3 s), genres déterminés par mesure de la fréquence fondamentale (voix 0-4 : 170-210 Hz, voix 5-9 : 92-137 Hz) ; le worker compilé accepte `language` et bascule sur l'anglais pour une langue inconnue |
| Reconnaissance française : Parakeet v3 vs Qwen3-ASR 0.6B int8 (2.5.0) | Six phrases Supertonic (3,8 s) : Parakeet WER 8,5 % (erreurs surtout de forme : « 14h30 »), 384 ms par phrase ; Qwen3-ASR WER 15,3 % (« mémoires vivres »), 1 477 ms, 940 Mo. Qwen3-ASR n'est pas ajouté au catalogue |
| Serveur MCP (2.4.0) | initialize, tools/list (14 outils), tools/call côté principal (presse-papiers, capture image) et côté renderer (état, message dans le fil) |

Sur un PC à 28 cœurs les temps sont nettement plus courts. Whisper small est maintenant recommandé pour le français.
