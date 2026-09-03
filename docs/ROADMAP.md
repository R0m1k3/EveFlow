# Feuille de route : vers un vrai JARVIS

État au 3 septembre 2026, après la revue complète du code (trois audits : processus principal, services/état, interface) et le test de bout en bout de l'application Electron sous Xvfb avec les vrais modèles.

## Ce qui existe déjà

| Capacité | État | Notes |
|---|---|---|
| HUD arc-reactor réactif au son | Fait | Canvas 2D optimisé (pas d'ombres, couleurs en cache, 30 fps en veille, arrêt fenêtre masquée) |
| Reconnaissance vocale locale | Fait | Whisper base/small/turbo via sherpa-onnx dans un processus utilitaire |
| Synthèse vocale locale | Fait | Kokoro v1.0 (voix française Siwis) et Piper fr |
| Mot d'activation permanent | Fait (2.2.0) | Keyword spotting sherpa-onnx en continu ; mot-clé libre encodé en BPE ; validé sur audio réel (détection, zéro faux positif sur le test anglais) |
| Mot d'activation après transcription | Fait | Filtre « Jarvis … » en mains libres, tolérant aux erreurs de transcription |
| Détection de fin de phrase | Fait | VAD énergétique adaptatif, pré-roll 400 ms |
| Hermes : runs, sessions, chat completions | Fait | Transport choisi selon `/v1/capabilities` |
| Approbations, steer, stop | Fait | Modales, injection de consigne en cours de run |
| Crons, skills, toolsets, sessions | Fait | Panneau Hermes Ops |
| Webhook local (Telegram, crons) | Fait | Loopback par défaut, secret pour le LAN |
| Télémétrie réelle | Fait | CPU, RAM, fréquence, FPS, uptime |

## Ce que les meilleurs projets « Jarvis » de 2026 font en plus

Sources : [jarvis-desktop-ai](https://github.com/ccarloshenri/jarvis-desktop-ai), [JarvisAi](https://github.com/PanPenek/JarvisAi), [bertrandmbanwi/Jarvis](https://github.com/bertrandmbanwi/Jarvis), [InterGenJLU/jarvis](https://github.com/InterGenJLU/jarvis), [livekit-wakeword](https://livekit.com/blog/livekit-wakeword), [sherpa-onnx keyword spotting](https://k2-fsa.github.io/sherpa/onnx/kws/index.html), [Hermes Agent features](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview).

1. **Mot d'activation permanent, quasi gratuit en CPU.** Les projets de référence utilisent openWakeWord (« hey jarvis ») ou un modèle de keyword spotting qui écoute en continu, au lieu de transcrire chaque phrase. sherpa-onnx fournit un modèle KWS anglais de 3,3 Mo qui accepte n'importe quel mot-clé sans réentraînement ; « JARVIS » s'encode `▁JA R VI S` avec son modèle BPE (vérifié). Livré en 2.2.0 (voir l'étape 1 ci-dessous).
2. **VAD neuronal (Silero) au lieu du seuil d'énergie.** Fin de phrase plus nette (environ 500 ms gagnés) et beaucoup moins de faux départs sur le bruit ambiant. Silero est déjà livré dans sherpa-onnx (`silero_vad.onnx`, 0,6 Mo).
3. **Latence perçue sous la seconde.** Les références visent 1 s entre la fin de parole et le premier mot prononcé : STT rapide, premier token en streaming, TTS phrase par phrase (déjà en place), et un modèle Hermes rapide pour la conversation courante.
4. **Vision d'écran.** Capture d'écran à la demande (« Jarvis, qu'est-ce que je regarde ? ») envoyée à Hermes comme image, ou lecture d'une fenêtre. Hermes accepte déjà les images inline.
5. **Actions système locales.** Ouvrir une application, régler le volume, verrouiller la session, chercher un fichier ; ce sont des outils EveFlow côté client à exposer à Hermes (mode chat completions) ou un petit serveur MCP local que Hermes appelle.
6. **Proactivité.** Notifications parlées à l'arrivée d'un cron, rappel, événement webhook, avec un résumé plutôt que la lecture intégrale ; c'est en partie fait via le webhook, à enrichir avec des règles (heures calmes, priorité).
7. **Mémoire et personnalisation.** Hermes gère la mémoire longue durée (`X-Hermes-Session-Key`) ; côté EveFlow, un profil (nom, préférences de voix, style de réponse) déjà transmis dans les instructions.

## Plan proposé

### Étape 1 : écoute permanente — livrée en 2.2.0
- Le renderer garde un seul flux micro (AudioWorklet 16 kHz) et envoie des blocs de 256 ms au processus principal, qui alimente le `KeywordSpotter` sherpa-onnx dans le worker.
- Mots-clés encodés en BPE (table SentencePiece pour les mots courants, repli glouton sur le vocabulaire du modèle), sensibilité réglable (seuil 0,45 → 0,12).
- À la détection : chime, capture de la commande sur le même flux (VAD énergétique, pré-roll 400 ms), transcription locale ou API, envoi à Hermes ; retour automatique à l'écoute.
- Reste à faire : remplacer le VAD énergétique par Silero pour la fin de phrase.

### Étape 2 : vision et actions locales
- Outil `capture_screen` (Electron `desktopCapturer`) qui joint une capture à la requête Hermes.
- Outils système : `open_app`, `set_volume`, `lock_session`, `find_file`, `clipboard` ; exposés en chat completions et via un serveur MCP local pour les transports runs/sessions.

### Étape 3 : conversation plus naturelle
- Barge-in réel : couper la voix dès que l'utilisateur parle (déjà préparé, à valider avec l'annulation d'écho Windows).
- Réponses courtes à l'oral, détails à l'écran : instruction Hermes dédiée déjà en place, à affiner avec des consignes de format (« deux phrases à l'oral, détails en Markdown »).
- Modèle rapide pour le bavardage, modèle puissant pour les missions (choix par transport ou par mot-clé).

### Étape 4 : présence
- Widget compact « glanceable » : dernière phrase, état, badge d'alertes.
- Heures calmes, priorité des notifications, résumé vocal des crons.
- Thèmes et voix par contexte (nuit, travail).

## Résultats du test de bout en bout (Linux, Xvfb, 4 cœurs lents)

| Étape | Résultat |
|---|---|
| Pont Electron, télémétrie, webhook | OK |
| Conversation via runs (streaming, outils, sous-agent) | OK |
| Kokoro (fr) → Whisper base, phrase courte de 2 s | synthèse 2,9 s, transcription 2,5 s, texte approximatif |
| Kokoro (fr) → Whisper base, phrase de 7 s | transcription correcte à un mot près |
| Piper (fr) → Whisper base | transcription exacte |

Sur un PC à 28 cœurs les temps sont nettement plus courts. Whisper small est maintenant recommandé pour le français.
