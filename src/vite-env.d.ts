/// <reference types="vite/client" />

interface Window {
  electronAPI?: {
    windowControl: (action: 'minimize' | 'maximize' | 'close') => void;
    setWindowMode: (mode: 'floating' | 'normal') => void;
    setCockpitMode: (isOpen: boolean) => void;
    onWindowModeChanged: (callback: (mode: 'floating' | 'normal') => void) => () => void;
    onHermesPush: (callback: (event: any) => void) => () => void;
    writeLog: (entry: any) => void;
    storeGet: (key: string) => Promise<string | null>;
    storeSet: (key: string, value: string) => Promise<boolean>;
  };
}
