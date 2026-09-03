import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { WindowMode } from '../shared/ipc';
import { bridge } from './lib/bridge';
import { Log } from './lib/log';
import { handlePush, stopGeneration } from './services/conversation';
import { speech } from './services/voice/speech';
import { voiceController } from './services/voice/voiceController';
import { useChat } from './state/chat';
import { useHermes } from './state/hermes';
import { useSettings } from './state/settings';
import { useVoice } from './state/voice';
import { useVoiceModels } from './state/voiceModels';
import { ChatPanel } from './components/chat/ChatPanel';
import { PendingRequests } from './components/chat/PendingRequests';
import { CompactWidget } from './components/compact/CompactWidget';
import { CoreStage } from './components/hud/CoreStage';
import { TopBar } from './components/hud/TopBar';
import { OpsPanel } from './components/panels/OpsPanel';
import { Telemetry } from './components/panels/Telemetry';
import { SettingsDrawer } from './components/settings/SettingsDrawer';

function useBoot(): boolean {
  const loaded = useSettings((s) => s.loaded);
  useEffect(() => {
    let disposed = false;
    const disposers: Array<() => void> = [];
    (async () => {
      await useSettings.getState().load();
      if (disposed) return;
      const settings = useSettings.getState().settings;
      speech.init();
      voiceController.init();
      useVoice.getState().setHandsFree(settings.voice.handsFree);
      await useHermes.getState().loadCache();
      void useHermes.getState().connect();
      void useHermes.getState().refreshWebhook();

      const api = bridge();
      if (!api && /Electron/i.test(navigator.userAgent)) {
        useChat.getState().setError("Pont Electron indisponible : le script preload n'a pas été chargé. Réinstallez EveFlow ou consultez eveflow.log.");
        Log.error('app', 'window.eveflow missing inside Electron');
      }
      if (api) {
        disposers.push(useVoiceModels.getState().subscribe());
        void useVoiceModels.getState().refresh();
        disposers.push(api.hermes.onPush(handlePush));
        disposers.push(
          api.hotkeys.on((event) => {
            if (event === 'ptt-toggle') voiceController.toggle();
            else if (event === 'stop-speaking') {
              speech.stop();
              if (useChat.getState().isSending) stopGeneration();
            }
          })
        );
      }
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => undefined);
      }
      Log.info('app', 'renderer ready', { transport: useHermes.getState().transport });
    })().catch((err) => Log.error('app', `boot failed: ${(err as Error).message}`));

    const jobsTimer = setInterval(() => {
      if (useHermes.getState().link !== 'offline') void useHermes.getState().refreshJobs();
    }, 45_000);
    const linkTimer = setInterval(() => {
      const h = useHermes.getState();
      if (h.link === 'offline' || h.link === 'unknown') void h.connect();
    }, 30_000);

    return () => {
      disposed = true;
      clearInterval(jobsTimer);
      clearInterval(linkTimer);
      for (const d of disposers) d();
      voiceController.dispose();
    };
  }, []);
  return loaded;
}

function useThemeSync(): void {
  const theme = useSettings((s) => s.settings.theme);
  const reduce = useSettings((s) => s.settings.ui.reduceMotion);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.motion = reduce ? 'reduce' : 'full';
  }, [theme, reduce]);
}

function useWindowMode(): WindowMode {
  const [mode, setMode] = useState<WindowMode>(() => (new URLSearchParams(window.location.search).get('mode') === 'compact' ? 'compact' : 'hud'));
  useEffect(() => {
    const api = bridge();
    if (!api) return;
    return api.window.onModeChanged(setMode);
  }, []);
  return mode;
}

function ErrorBanner() {
  const error = useChat((s) => s.error);
  const setError = useChat((s) => s.setError);
  if (!error) return null;
  return (
    <div className="error-banner">
      <AlertTriangle size={16} />
      <span>{error}</span>
      <button className="icon-btn" onClick={() => setError(null)}><X size={14} /></button>
    </div>
  );
}

export default function App() {
  const loaded = useBoot();
  useThemeSync();
  const mode = useWindowMode();
  const showTelemetry = useSettings((s) => s.settings.ui.showTelemetry);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showSettings) setShowSettings(false);
      if (e.key === ',' && (e.ctrlKey || e.metaKey)) setShowSettings((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSettings]);

  if (!loaded) {
    return (
      <div className="boot-screen">
        <span className="pulse">INITIALISATION</span>
      </div>
    );
  }

  if (mode === 'compact') {
    return (
      <>
        <CompactWidget />
        <PendingRequests />
      </>
    );
  }

  return (
    <div className="hud-root">
      <TopBar onOpenSettings={() => setShowSettings(true)} />
      <div className="hud-body">
        <div className="hud-column">
          <ChatPanel />
        </div>
        <div className="hud-column">
          <ErrorBanner />
          <section className="panel bracket" style={{ flex: 1 }}>
            <CoreStage />
          </section>
        </div>
        <div className="hud-column ops-column">
          <OpsPanel />
          {showTelemetry && <Telemetry />}
        </div>
      </div>
      {showSettings && <SettingsDrawer onClose={() => setShowSettings(false)} />}
      <PendingRequests />
    </div>
  );
}
