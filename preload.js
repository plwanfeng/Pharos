const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config management
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  
  // Proxies management
  importProxies: () => ipcRenderer.invoke('import-proxies'),
  
  // Wallet utilities
  checkWalletBalance: (privateKey) => ipcRenderer.invoke('check-wallet-balance', privateKey),
  
  // Bot control
  startBot: (config) => ipcRenderer.invoke('start-bot', config),
  stopBot: () => ipcRenderer.invoke('stop-bot'),
  getActivityLog: () => ipcRenderer.invoke('get-activity-log'),
  
  // Account status
  getAccountStatus: () => ipcRenderer.invoke('get-account-status'),
  
  // Faucet claim
  claimFaucet: (privateKeys, inviteCode, useProxy, requestInterval) => 
    ipcRenderer.invoke('claim-faucet', privateKeys, inviteCode, useProxy, requestInterval),
  
  // 资金归集功能
  collectFunds: (config) => ipcRenderer.invoke('collect-funds', config),
  
  // 窗口控制功能
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  
  // Log updates listener
  onLogUpdate: (callback) => {
    ipcRenderer.on('log-update', (_, log) => callback(log));
    return () => {
      ipcRenderer.removeAllListeners('log-update');
    };
  },
  
  // Account status updates listener
  onAccountStatusUpdate: (callback) => {
    ipcRenderer.on('account-status-update', (_, accountStatus) => callback(accountStatus));
    return () => {
      ipcRenderer.removeAllListeners('account-status-update');
    };
  }
}); 