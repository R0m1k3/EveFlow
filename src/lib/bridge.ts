import type { EveFlowBridge } from '../../shared/bridge';

/** Returns the Electron bridge, or null when running in a plain browser (Vite dev without Electron). */
export function bridge(): EveFlowBridge | null {
  return typeof window !== 'undefined' && window.eveflow ? window.eveflow : null;
}

export const isElectron = (): boolean => bridge() !== null;
