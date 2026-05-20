/**
 * ToolRegistry — Defines all functions exposed to Hermes Agent via OpenAI tool calling.
 *
 * Each tool has:
 *  - A JSON Schema definition sent to Hermes in the `tools[]` payload
 *  - A local executor that runs when Hermes invokes it
 *
 * AppCallbacks provides access to React state setters from AgentService (stateless).
 */

export interface AppCallbacks {
  /** Change the avatar's current emotion */
  setEmotion: (emotion: string) => void;
  /** Get the current application status snapshot */
  getStatus: () => AppStatus;
  /** Get the N most recent chat messages */
  getHistory: (n: number) => { role: string; content: string }[];
  /** Trigger TTS speech */
  speak: (text: string) => void;
}

export interface AppStatus {
  provider: string;
  avatar: string;
  emotion: string;
  isSpeaking: boolean;
  isMuted: boolean;
  messageCount: number;
}

/** OpenAI-compatible tool definition */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Result returned to Hermes after tool execution */
export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  content: string;
}

// ── Tool Definitions (sent to Hermes in request payload) ───────────────────

export const HERMES_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'set_avatar_emotion',
      description: "Change l'état émotionnel de l'avatar Eve visible par l'utilisateur. Appelle cet outil quand la réponse doit être accompagnée d'une expression visible.",
      parameters: {
        type: 'object',
        properties: {
          emotion: {
            type: 'string',
            enum: ['neutral', 'happy', 'thinking', 'excited', 'sad', 'angry', 'surprised'],
            description: "L'émotion à afficher sur l'avatar"
          }
        },
        required: ['emotion']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_app_status',
      description: "Retourne l'état actuel de l'application EveFlow : provider IA actif, avatar sélectionné, émotion courante, mode audio.",
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_conversation_history',
      description: 'Retourne les N derniers messages de la conversation en cours.',
      parameters: {
        type: 'object',
        properties: {
          n: {
            type: 'number',
            description: 'Nombre de messages à récupérer (max 20)',
            minimum: 1,
            maximum: 20
          }
        },
        required: ['n']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'speak_text',
      description: "Fait prononcer un texte par la synthèse vocale de l'avatar. Utile pour mettre en avant une information importante.",
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Le texte à prononcer (max 500 caractères)'
          }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_shared_file',
      description: "Sauvegarde un fichier (rapport, script python, javascript, données JSON, HTML) dans le dossier partagé EveFlow de l'utilisateur Windows et lui partage un lien d'accès. Utilise cet outil chaque fois que l'utilisateur te demande de générer, d'écrire ou de sauvegarder un fichier sur son ordinateur.",
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: "Le nom du fichier avec son extension (ex: rapport.txt, script.py, data.json, index.html)"
          },
          content: {
            type: 'string',
            description: "Le contenu textuel intégral à écrire dans le fichier"
          }
        },
        required: ['filename', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_shared_image',
      description: "Génère un schéma technique, un dessin vectoriel, ou une illustration de haute qualité au format SVG, l'enregistre sur le disque et l'affiche dans le chat. Utilise cet outil dès que l'utilisateur te demande d'afficher, de dessiner ou de générer un graphique, un diagramme ou une image.",
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: "Le nom du fichier SVG (ex: architecture.svg, graphique.svg)"
          },
          svgContent: {
            type: 'string',
            description: "Le code source SVG complet et valide (incluant les balises <svg>, viewBox, styles et éléments géométriques)"
          }
        },
        required: ['filename', 'svgContent']
      }
    }
  }
];

// ── Tool Dispatcher ─────────────────────────────────────────────────────────

/**
 * Executes a tool call requested by Hermes Agent and returns the stringified result.
 *
 * @param toolCallId  - The ID from Hermes tool_call (must be echoed back in role:tool message)
 * @param name        - Function name requested by Hermes
 * @param rawArgs     - JSON string of arguments from Hermes
 * @param callbacks   - App state accessors injected from the React layer
 * @returns           - ToolResult to append to the messages array
 */
export async function executeTool(
  toolCallId: string,
  name: string,
  rawArgs: string,
  callbacks: AppCallbacks
): Promise<ToolResult> {
  let result: string;

  try {
    const args = JSON.parse(rawArgs || '{}');

    switch (name) {
      case 'set_avatar_emotion': {
        const emotion = args.emotion as string;
        callbacks.setEmotion(emotion);
        result = JSON.stringify({ success: true, emotion_set: emotion });
        break;
      }

      case 'get_app_status': {
        const status = callbacks.getStatus();
        result = JSON.stringify(status);
        break;
      }

      case 'get_conversation_history': {
        const n = Math.min(Number(args.n) || 5, 20);
        const history = callbacks.getHistory(n);
        result = JSON.stringify({ messages: history, count: history.length });
        break;
      }

      case 'speak_text': {
        const text = String(args.text || '').slice(0, 500);
        callbacks.speak(text);
        result = JSON.stringify({ success: true, text_spoken: text });
        break;
      }

      case 'write_shared_file': {
        const filename = String(args.filename || '');
        const content = String(args.content || '');
        if ((window as any).electronAPI?.writeSharedFile) {
          const fileUrl = await (window as any).electronAPI.writeSharedFile(filename, content, false);
          result = JSON.stringify({ success: true, url: fileUrl, filename });
        } else {
          result = JSON.stringify({ error: "L'API d'écriture de fichier local n'est pas disponible (hors Electron)." });
        }
        break;
      }

      case 'generate_shared_image': {
        const filename = String(args.filename || '');
        const svgContent = String(args.svgContent || '');
        if ((window as any).electronAPI?.writeSharedFile) {
          const fileUrl = await (window as any).electronAPI.writeSharedFile(filename, svgContent, false);
          result = JSON.stringify({ success: true, url: fileUrl, filename });
        } else {
          result = JSON.stringify({ error: "L'API de génération d'image locale n'est pas disponible." });
        }
        break;
      }

      default:
        result = JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (e: any) {
    result = JSON.stringify({ error: `Tool execution failed: ${e.message}` });
  }

  return {
    tool_call_id: toolCallId,
    role: 'tool',
    content: result
  };
}
