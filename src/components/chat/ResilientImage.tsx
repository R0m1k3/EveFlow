import { useEffect, useState } from 'react';
import { bridge } from '../../lib/bridge';
import { httpFetch } from '../../lib/transport';
import { useSettings } from '../../state/settings';
import { hermesBaseUrl } from '../../services/hermes/client';

const cache = new Map<string, string>();
const failures = new Map<string, string>();

interface Props {
  src?: string;
  alt?: string;
  onOpen?: (src: string) => void;
}

/**
 * Renders images coming from Hermes: data URLs, http(s), Windows/file paths (read through the
 * main process) and server-side absolute paths (fetched from the Hermes host with auth).
 */
export function ResilientImage({ src = '', alt, onOpen }: Props) {
  const [resolved, setResolved] = useState<string>(() => cache.get(src) ?? '');
  const [error, setError] = useState<string>(() => failures.get(src) ?? '');
  const hermes = useSettings((s) => s.settings.hermes);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const ok = (value: string) => {
      cache.set(src, value);
      if (!cancelled) {
        setResolved(value);
        setError('');
      }
    };
    const fail = (message: string) => {
      failures.set(src, message);
      if (!cancelled) setError(message);
    };
    if (cache.has(src)) {
      setResolved(cache.get(src)!);
      return;
    }
    if (failures.has(src)) {
      setError(failures.get(src)!);
      return;
    }
    if (src.startsWith('data:') || src.startsWith('blob:') || /^https?:\/\//i.test(src)) {
      ok(src);
      return;
    }
    const api = bridge();
    const isLocal = src.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(src);
    const fromHermes = async () => {
      if (!hermes.url) throw new Error('chemin local inaccessible');
      const base = hermesBaseUrl(hermes.url);
      const path = src.replace(/^file:\/\//, '').replace(/\\/g, '/');
      const headers: Record<string, string> = {};
      if (hermes.apiKey) headers.Authorization = `Bearer ${hermes.apiKey}`;
      const res = await httpFetch({ url: `${base}/${path.replace(/^\//, '')}`, headers, responseType: 'binary', timeoutMs: 15_000 });
      if (!res.ok || !res.binary) throw new Error(`HTTP ${res.status}`);
      const type = res.headers['content-type'] || 'image/png';
      const bytes = new Uint8Array(res.binary);
      return URL.createObjectURL(new Blob([bytes], { type }));
    };
    const task = isLocal && api ? api.files.readLocal(src).catch(fromHermes) : fromHermes();
    task.then(ok).catch((err: Error) => fail(err.message || 'image inaccessible'));
    return () => {
      cancelled = true;
    };
  }, [src, hermes.url, hermes.apiKey]);

  if (error && !resolved) {
    return (
      <span className="img-error" title={src}>
        Image inaccessible ({error})
      </span>
    );
  }
  if (!resolved) return <span className="img-error pulse">chargement…</span>;
  return <img src={resolved} alt={alt ?? 'image'} loading="lazy" onClick={() => onOpen?.(resolved)} />;
}
