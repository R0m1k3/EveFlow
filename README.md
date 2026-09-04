# EveFlow 2 — Interface vocale JARVIS pour Hermes Agent

[![Build](https://img.shields.io/github/actions/workflow/status/R0m1k3/EveFlow/windows-release.yml?style=flat-square)](https://github.com/R0m1k3/EveFlow/actions)
[![Version](https://img.shields.io/badge/version-2.4.1-brightgreen.svg?style=flat-square)](https://github.com/R0m1k3/EveFlow/releases)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg?style=flat-square)](LICENSE)

**EveFlow** est un compagnon de bureau Windows qui transforme [Hermes Agent](https://hermes-agent.nousresearch.com/) en assistant vocal à la JARVIS : un noyau holographique réactif au son, une conversation en streaming, les outils, sous-agents, approbations, crons, skills et sessions d'Hermes pilotés depuis un seul HUD.

La version 2 est une réécriture complète : plus de robot 3D, un pipeline vocal fiable (AudioWorklet + détection d'activité vocale), un client Hermes qui exploite l'API serveur complète (runs SSE, sessions, jobs, capabilities) et une architecture Electron sécurisée (sandbox, `webSecurity` actif, réseau proxifié par le processus principal).

---

## Fonctionnalités

### Noyau JARVIS
* Arc reactor rendu en Canvas 2D : anneaux gradués, arcs segmentés et spectre radial calculé sur le **vrai signal audio** (voix synthétisée ou microphone).
* États visuels : veille, écoute, analyse (outils en cours), transmission, attention (approbation), anomalie, succès.
* Quatre thèmes (arc cyan, gold, crimson, emerald), mode animations réduites.
* Mode compact flottant toujours au premier plan, opacité réglable.

### Voix
* **Capture micro** via AudioWorklet à 16 kHz, sans monitoring du micro dans les haut-parleurs, avec annulation d'écho et réduction de bruit.
* **Détection d'activité vocale** (seuil adaptatif, sensibilité et silence de fin réglables) : l'enregistrement s'arrête tout seul quand vous avez fini de parler.
* **Mains libres** : le micro se réactive après chaque réponse.
* **Modèles intégrés, hors ligne** (sherpa-onnx dans un processus séparé) : reconnaissance Whisper (base, small, large-v3 turbo) ou SenseVoice, synthèse Kokoro v1.0 (voix française Siwis et voix anglaises) ou Piper (Siwis, Tom, UPMC). Les modèles se téléchargent depuis **Paramètres → Modèles locaux** et tournent sur le processeur.
* **Fin de phrase neuronale** : en écoute permanente, Silero VAD (0,6 Mo, sherpa-onnx) décide du début et de la fin de la commande à la place du seuil d'énergie ; moins de faux départs sur le bruit, coupure plus nette. Repli automatique sur le VAD énergétique si le modèle n'est pas installé.
* **Vision d'écran** : « Jarvis, regarde mon écran » (ou le bouton de la barre de commande) joint une capture de l'écran principal à la question envoyée à Hermes.
* **Actions locales instantanées** : « verrouille la session », « monte le son », « coupe le son », « piste suivante », « ouvre Spotify », « ouvre github.com »… exécutées sur le PC sans passer par Hermes, résultat lu à voix haute. Liste blanche d'actions dans le processus principal, désactivable dans les paramètres.
* **Serveur MCP intégré** : Hermes se connecte à `http://<pc>:7842/mcp` et obtient les outils du PC (capture d'écran renvoyée en image, verrouillage, applications, URL, touches média, presse-papiers, recherche de fichiers, voix, notifications, état du HUD, affichage dans le fil). Même port et même secret que le webhook ; en mode chat completions, les mêmes outils sont proposés directement au modèle.
* **Heures calmes et priorités** : plage horaire pendant laquelle les messages poussés s'affichent sans être lus ni faire clignoter le noyau (badge « non lus » à la place), thème nuit automatique, mots prioritaires lus quand même, résumé vocal des rapports longs (les premières phrases seulement).
* **Mode mission** : un bouton dans la barre de commande bascule sur un second modèle Hermes (plus puissant) pour les tâches longues ; le modèle rapide reste utilisé pour la conversation courante.
* **Widget compact « glanceable »** : état (veille, écoute, réflexion, parle), dernière phrase de l'assistant, badge de non-lus, indicateurs heures calmes et mission.
* **Voix JARVIS** : préréglage en un clic (Paramètres → Voix) : voix française masculine locale (Piper Tom, téléchargée automatiquement), timbre « JARVIS » (légèrement plus grave et posé, chaleur, présence, courte réverbération d'intercom), débit calme. Kokoro n'a pas de voix française masculine.
* **Reconnaissance française de référence** : Parakeet TDT 0.6B v3 (NVIDIA NeMo, 25 langues européennes) dans le catalogue, plus précis et bien plus rapide que Whisper sur processeur, avec ponctuation. Whisper base/small/turbo restent disponibles.
* **Voix masculine ou féminine** : un réglage unique (Paramètres → Voix) appliqué à tous les moteurs. En local, Piper Tom ou Pierre (UPMC) pour le masculin, téléchargé automatiquement si aucune voix masculine n'est installée ; onyx / nova pour les API compatibles OpenAI ; Paul / Hortense pour les voix Windows.
* **Barge-in** : en mains libres, parler par-dessus l'assistant coupe sa voix ; le seuil est relevé pendant qu'il parle pour ignorer l'écho du haut-parleur.
* **Écoute permanente** : un détecteur de mot-clé de 3 Mo (sherpa-onnx, keyword spotting) tourne en continu sur le micro, quasi gratuit en CPU. « Jarvis » (ou n'importe quel mot-clé) ouvre l'écoute, « Jarvis, allume… » envoie directement la commande, et le mot coupe la voix en cours. Alternative : filtre du mot après transcription en mains libres.
* **STT externe** : n'importe quelle API `/v1/audio/transcriptions` compatible OpenAI (Qwen3-ASR, Whisper, Speaches, faster-whisper-server, LocalAI, OpenAI). Repli sur la reconnaissance Chromium.
* **TTS externe** : API `/v1/audio/speech` compatible OpenAI, voix système Windows ou Google Translate. Lecture phrase par phrase pendant le streaming, préchargement du segment suivant, coupure instantanée.
* Raccourcis globaux : `Ctrl+Shift+Espace` (micro), `Ctrl+Shift+J` (afficher/masquer), `Ctrl+Shift+Échap` (couper la voix).

### Hermes, toute la puissance
* Découverte automatique via `GET /v1/capabilities` et `GET /health/detailed`, choix du transport le plus riche :
  1. **Runs API** (`POST /v1/runs` + `GET /v1/runs/{id}/events`) : deltas, outils, sous-agents, `approval.request`, `run.completed`, arrêt (`/stop`) et injection de consignes en cours de run (`/steer`).
  2. **Sessions API** (`/api/sessions/{id}/chat/stream`) : mémoire côté serveur, fork, suppression, relecture de l'historique.
  3. **Chat completions** OpenAI (`/v1/chat/completions`) avec `hermes.tool.progress`, continuité de session (`X-Hermes-Session-Id`) et outils EveFlow côté client (état du HUD, fichiers partagés, notifications).
* Mémoire longue durée via `X-Hermes-Session-Key`.
* **Approbations** d'outils affichées dans le HUD : une fois, pour la session, toujours, refuser.
* **Crons** : création en langage naturel (`every 1h`, `weekdays at 9am`, `in 30m`, expression cron), pause/reprise, exécution immédiate, édition, historique des résultats lus à voix haute.
* **Skills et toolsets** exposés par le serveur, **sessions** navigables.
* **Webhook local** (`POST http://<pc>:7842/eveflow/hook`) pour recevoir les livraisons de crons, le miroir Telegram ou n'importe quel script, avec secret optionnel.
* Images inline (URL, data URL, fichiers du dossier partagé `Documents/EveFlow_Shared`).

### Système
* Télémétrie réelle : charge CPU, mémoire, fréquence, FPS, uptime.
* Journal sur disque (`%APPDATA%/eveflow/eveflow.log`), icône de zone de notification, instance unique.

---

## Stack

* Electron 44 (sandbox, contextIsolation, `webSecurity` actif, proxy HTTP en streaming dans le main process)
* React 19 + Vite 8 + TypeScript 5.9 + Zustand
* Canvas 2D, Web Audio (AudioWorklet, AnalyserNode)
* sherpa-onnx (ONNX Runtime) pour la voix locale, exécuté dans un `utilityProcess` Electron
* Vitest pour les tests unitaires (SSE, VAD, WAV, normalisation d'événements Hermes)

```
electron/        processus principal (fenêtre, tray, raccourcis, IPC, webhook, proxy HTTP)
electron/voice   catalogue de modèles, téléchargement, worker sherpa-onnx (STT/TTS)
shared/          contrat IPC + normalisation des pushs webhook (main + renderer)
src/lib          transport, SSE, persistance, utilitaires texte
src/services     hermes/ (client, événements, outils locaux)  voice/ (capture, VAD, STT, TTS)
src/state        stores Zustand (settings, chat, hermes, voice)
src/components   hud/ chat/ panels/ settings/ compact/
tests/           vitest
```

---

## Prérequis côté Hermes

Activez le serveur API dans la configuration Hermes (`~/.hermes/config.yaml`) ou via l'environnement :

```
API_SERVER_ENABLED=true
API_SERVER_PORT=8642
API_SERVER_KEY=<votre clé>
```

Puis lancez `hermes gateway`. Renseignez l'URL (`http://<hôte>:8642`) et la clé dans **Paramètres → Hermes** et cliquez **Tester la liaison**. Le transport choisi apparaît dans la barre supérieure.

Pour recevoir les résultats de crons ou le miroir d'autres canaux dans EveFlow, faites pointer une livraison Hermes (script, webhook, `deliver`) vers `http://<ip-du-pc>:7842/eveflow/hook` avec un JSON tel que :

```json
{ "role": "assistant", "text": "Rapport terminé", "source": "telegram" }
{ "event": "run.completed", "input": "question", "output": "réponse" }
{ "event": "job.completed", "job": { "name": "Rapport" }, "output": "…", "status": "ok" }
```

---

### Donner à Hermes les outils du PC (MCP)

Dans `~/.hermes/config.yaml` côté Hermes :

```yaml
mcp_servers:
  eveflow:
    url: "http://<ip-du-pc>:7842/mcp"
    headers:
      Authorization: "Bearer <secret du webhook EveFlow>"
```

Sans secret, EveFlow n'écoute qu'en local (`127.0.0.1`) ; définissez un secret dans Paramètres → Webhook pour un Hermes distant. Outils exposés : `capture_screen`, `lock_session`, `open_app`, `open_url`, `media_key`, `clipboard_get`, `clipboard_set`, `find_files`, `speak_text`, `notify_user`, `set_hud_state`, `get_app_status`, `get_conversation_history`, `show_message`.

### L'URL répond par une page web ?

Si « Tester la liaison » signale « Le serveur renvoie une page web … au lieu de l'API Hermes », l'URL saisie pointe vers un portail (page de connexion, tableau de bord) et non vers le serveur API. EveFlow cherche alors automatiquement l'API sur le même hôte (port 8642, chemins `/api` et `/v1`, sous-domaines `api.` ou `hermes.`) et corrige l'URL s'il la trouve. Sinon, ouvrez le port 8642 du serveur Hermes ou exposez-le sur un chemin dédié de votre proxy, sans authentification web devant lui (la clé `API_SERVER_KEY` suffit).

## Développement

```bash
npm install
npm start          # Vite + Electron (rechargement à chaud du renderer)
npm test           # tests unitaires
npm run typecheck  # renderer + main process
```

Sans Electron, `npm run dev` puis `http://127.0.0.1:5173/` (ou `?mode=compact`) permet de travailler l'interface dans un navigateur ; les appels réseau passent alors directement par `fetch` (CORS requis côté serveur).

## Packaging Windows et versions

```bash
npm run dist
```

L'installateur NSIS est produit dans `out/`. Le numéro de version publié est `releaseVersion` dans `package.json` (quatre chiffres, ex. `2.0.0.1` : le quatrième chiffre sert aux petits correctifs). `version` reste la base à trois chiffres exigée par electron-builder. À chaque fusion sur master, le workflow GitHub Actions crée le tag et la release Windows si ce numéro n'a pas encore été publié.

---

## Licence

MIT.
