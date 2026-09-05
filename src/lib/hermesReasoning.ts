/** Reasoning effort levels accepted by Hermes (`agent.reasoning_effort` / `model_options.reasoning_effort`). */
import type { HermesReasoningEffort } from '../services/hermes/types';

export const REASONING_EFFORTS: Array<{ value: HermesReasoningEffort; label: string }> = [
  { value: '', label: 'Défaut du serveur (medium)' },
  { value: 'none', label: 'none : pas de réflexion' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low : rapide' },
  { value: 'medium', label: 'medium : équilibré' },
  { value: 'high', label: 'high : réponses plus fouillées' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
  { value: 'ultra', label: 'ultra : le plus lent' }
];

export function isReasoningEffort(value: string): value is HermesReasoningEffort {
  return REASONING_EFFORTS.some((e) => e.value === value);
}
