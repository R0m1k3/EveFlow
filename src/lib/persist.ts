import { bridge } from './bridge';

/**
 * Persistent key/value storage: Electron userData JSON file when available,
 * localStorage otherwise. Values are JSON-serialisable objects.
 */
export async function persistGet<T>(key: string): Promise<T | null> {
  const api = bridge();
  if (api) {
    try {
      const value = await api.store.get<T>(key);
      if (value !== null && value !== undefined) return value;
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function persistSet(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or unavailable */
  }
  void bridge()?.store.set(key, value).catch(() => undefined);
}
