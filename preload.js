const { contextBridge, ipcRenderer } = require('electron');

// Exposition sécurisée via contextBridge (Zéro Trust contextIsolation)
contextBridge.exposeInMainWorld('electronAPI', {
  windowControl: (action) => ipcRenderer.send('window-control', action),
  setWindowMode: (mode) => ipcRenderer.send('set-window-mode', mode),
  onWindowModeChanged: (callback) => {
    const subscription = (event, mode) => callback(mode);
    ipcRenderer.on('window-mode-changed', subscription);
    return () => ipcRenderer.removeListener('window-mode-changed', subscription);
  },
  // Logging : envoie une entrée structurée vers le processus principal pour écriture disque
  writeLog: (entry) => ipcRenderer.send('write-log', entry),
  // Webhook : abonnement aux events pushés par Hermes
  onHermesPush: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('hermes-push', subscription);
    return () => ipcRenderer.removeListener('hermes-push', subscription);
  },
  // Store persistant fichier — indépendant de l'origine HTTP/file://
  storeGet: (key) => ipcRenderer.invoke('store-get', key),
  storeSet: (key, value) => ipcRenderer.invoke('store-set', key, value),
  // Lecture de fichier local sécurisée
  readLocalFile: (filePath) => ipcRenderer.invoke('read-local-file', filePath),
  // Télémétrie réelle système
  getSystemMetrics: () => ipcRenderer.invoke('get-system-metrics'),
  // Écriture de fichier partagé
  writeSharedFile: (filename, content, isBase64) => ipcRenderer.invoke('write-shared-file', filename, content, isBase64),
  // Ouverture de fichier local
  openLocalFile: (filePath) => ipcRenderer.invoke('open-local-file', filePath),
  // Chargement d'une image distante via Node.js (contourne CORS \u2014 retourne une Data URL base64)
  fetchRemoteImage: (url, extraHeaders = {}) => ipcRenderer.invoke('fetch-remote-image', url, extraHeaders),
});
