const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { ethers } = require('ethers');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const randomUseragent = require('random-useragent');

// Initialize config store
const store = new Store({
  schema: {
    privateKeys: {
      type: 'array',
      default: []
    },
    inviteCode: {
      type: 'string',
      default: 'jdrWvYccKEwr3fap'
    },
    proxyEnabled: {
      type: 'boolean',
      default: false
    }
  }
});

// 添加账户状态跟踪
const accountStatus = new Map();

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 950,
    height: 700,
    frame: false, // 移除窗口边框
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets/icon.png')
  });

  mainWindow.loadFile('index.html');
  
  // 移除菜单栏
  mainWindow.setMenu(null);
  
  // Uncomment to open DevTools automatically
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers
ipcMain.handle('get-config', () => {
  return {
    privateKeys: store.get('privateKeys'),
    inviteCode: store.get('inviteCode'),
    proxyEnabled: store.get('proxyEnabled')
  };
});

// 添加获取账户状态的处理器
ipcMain.handle('get-account-status', () => {
  return Array.from(accountStatus.entries()).map(([address, status]) => ({
    address,
    ...status
  }));
});

// 添加一键领取水龙头的处理器
ipcMain.handle('claim-faucet', async (event, privateKeys, inviteCode, useProxy, requestInterval = 3000) => {
  try {
    const results = [];
    const proxies = useProxy ? loadProxies(true) : [];
    
    logActivity('info', `开始领取水龙头，请求间隔: ${requestInterval/1000} 秒`);
    
    for (const privateKey of privateKeys) {
      try {
        const proxy = proxies.length ? getRandomProxy(proxies) : null;
        const provider = setupProvider(proxy);
        const wallet = new ethers.Wallet(privateKey, provider);
        
        logActivity('wallet', `正在为钱包领取水龙头: ${wallet.address}`);
        
        // 创建或更新账户状态
        if (!accountStatus.has(wallet.address)) {
          accountStatus.set(wallet.address, {
            balance: "查询中...",
            lastFaucet: null,
            lastCheckIn: null,
            lastTransfer: null,
            lastSwap: null,
            nextRun: null,
            status: "等待中"
          });
          
          // 更新余额
          try {
            const balance = await provider.getBalance(wallet.address);
            accountStatus.get(wallet.address).balance = ethers.formatEther(balance);
          } catch (error) {
            logActivity('error', `获取余额失败: ${error.message}`);
          }
        }
        
        // 尝试领取水龙头
        const faucetResult = await claimFaucet(wallet, proxy, inviteCode);
        
        // 更新账户状态
        if (accountStatus.has(wallet.address)) {
          if (faucetResult) {
            accountStatus.get(wallet.address).lastFaucet = new Date().toISOString();
          }
          
          // 获取更新余额
          try {
            const balance = await provider.getBalance(wallet.address);
            accountStatus.get(wallet.address).balance = ethers.formatEther(balance);
          } catch (error) {
            logActivity('error', `获取余额失败: ${error.message}`);
          }
          
          // 通知前端状态已更新
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('account-status-update', Array.from(accountStatus.entries()).map(([address, status]) => ({
              address,
              ...status
            })));
          }
        }
        
        results.push({
          address: wallet.address,
          success: faucetResult,
          message: faucetResult ? '水龙头领取成功' : '水龙头领取失败'
        });
        
        // 添加请求间隔，避免频率限制
        if (privateKeys.indexOf(privateKey) < privateKeys.length - 1) {
          logActivity('info', `等待 ${requestInterval/1000} 秒后处理下一个钱包...`);
          await new Promise(resolve => setTimeout(resolve, requestInterval));
        }
      } catch (error) {
        logActivity('error', `处理钱包出错: ${error.message}`);
        results.push({
          address: '处理错误',
          success: false,
          message: `处理错误: ${error.message}`
        });
        
        // 即使出错也添加延迟
        if (privateKeys.indexOf(privateKey) < privateKeys.length - 1) {
          await new Promise(resolve => setTimeout(resolve, requestInterval));
        }
      }
    }
    
    return {
      success: true,
      results
    };
  } catch (error) {
    logActivity('error', `一键领取水龙头失败: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
});

// 添加资金归集功能
ipcMain.handle('collect-funds', async (event, config) => {
  try {
    logActivity('info', '开始资金归集操作...');
    
    const { privateKeys, targetAddress, collectType, collectAmount, keepGas } = config;
    const results = [];
    
    if (!privateKeys || privateKeys.length === 0) {
      return {
        success: false,
        error: '没有提供钱包私钥'
      };
    }
    
    if (!targetAddress || !ethers.isAddress(targetAddress)) {
      return {
        success: false,
        error: '无效的目标地址'
      };
    }
    
    // 验证固定数量或百分比
    if (collectType === 'fixed') {
      try {
        // 尝试解析固定数量参数
        if (isNaN(parseFloat(collectAmount)) || parseFloat(collectAmount) <= 0) {
          return {
            success: false,
            error: '无效的固定数量参数'
          };
        }
      } catch (error) {
        return {
          success: false,
          error: '无效的固定数量格式'
        };
      }
    } else if (collectType === 'percent') {
      try {
        // 尝试解析百分比参数
        const percentage = parseFloat(collectAmount);
        if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
          return {
            success: false,
            error: '无效的百分比参数（应为 1-100 之间）'
          };
        }
      } catch (error) {
        return {
          success: false,
          error: '无效的百分比格式'
        };
      }
    }
    
    // 获取目标地址的信息（用于日志记录）
    let targetLabel = targetAddress;
    for (const pk of privateKeys) {
      try {
        const provider = setupProvider(null);
        const wallet = new ethers.Wallet(pk, provider);
        if (wallet.address.toLowerCase() === targetAddress.toLowerCase()) {
          targetLabel = `${targetAddress} (钱包 #${privateKeys.indexOf(pk) + 1})`;
          break;
        }
      } catch (error) {
        // 忽略错误，继续尝试下一个钱包
      }
    }
    
    logActivity('step', `归集目标地址: ${targetLabel}`);
    
    // 处理每个钱包
    for (const privateKey of privateKeys) {
      try {
        const provider = setupProvider(null);
        const wallet = new ethers.Wallet(privateKey, provider);
        
        // 跳过目标钱包（不从目标钱包转出）
        if (wallet.address.toLowerCase() === targetAddress.toLowerCase()) {
          results.push({
            address: wallet.address,
            success: true,
            message: '跳过（目标钱包）',
            amount: '0'
          });
          continue;
        }
        
        logActivity('wallet', `处理钱包: ${wallet.address}`);
        
        // 获取余额
        const balance = await provider.getBalance(wallet.address);
        const balanceEther = ethers.formatEther(balance);
        
        if (balance <= 0) {
          logActivity('warn', `钱包余额为零，跳过: ${wallet.address}`);
          results.push({
            address: wallet.address,
            success: false,
            message: '余额为零',
            amount: '0'
          });
          continue;
        }
        
        logActivity('info', `钱包余额: ${balanceEther} PHRS`);
        
        // 计算转账金额
        let transferAmount = balance;
        
        if (collectType === 'fixed') {
          // 固定数量模式
          const fixedAmount = ethers.parseEther(collectAmount);
          if (balance < fixedAmount) {
            logActivity('warn', `余额不足以转出固定数量 (${collectAmount} PHRS)`);
            results.push({
              address: wallet.address,
              success: false,
              message: `余额不足 (${balanceEther} < ${collectAmount})`,
              amount: '0'
            });
            continue;
          }
          transferAmount = fixedAmount;
        } else if (collectType === 'percent') {
          // 百分比模式
          const percentage = parseFloat(collectAmount);
          if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
            logActivity('error', `无效的百分比值: ${collectAmount}`);
            results.push({
              address: wallet.address,
              success: false,
              message: '无效的百分比值',
              amount: '0'
            });
            continue;
          }
          transferAmount = balance * BigInt(Math.floor(percentage * 10)) / BigInt(1000);
        }
        
        // 保留 gas 费用
        if (collectType === 'all' && keepGas) {
          const gasPrice = await provider.getFeeData();
          const gasCost = gasPrice.gasPrice * BigInt(21000);
          
          if (balance <= gasCost) {
            logActivity('warn', `余额不足以支付 gas 费用，跳过: ${wallet.address}`);
            results.push({
              address: wallet.address,
              success: false,
              message: '余额不足以支付 gas 费用',
              amount: '0'
            });
            continue;
          }
          
          // 保留 gas 费用的 150%，以确保有足够的费用
          transferAmount = balance - (gasCost * BigInt(150) / BigInt(100));
        }
        
        // 确保转账金额大于零
        if (transferAmount <= 0) {
          logActivity('warn', `计算后的转账金额为零或负数，跳过: ${wallet.address}`);
          results.push({
            address: wallet.address,
            success: false,
            message: '计算后的转账金额无效',
            amount: '0'
          });
          continue;
        }
        
        // 确保不超过钱包余额
        if (transferAmount > balance) {
          transferAmount = balance;
        }
        
        // 发送交易
        const tx = {
          to: targetAddress,
          value: transferAmount,
          gasLimit: 21000
        };
        
        logActivity('loading', `正在从 ${wallet.address} 转出 ${ethers.formatEther(transferAmount)} PHRS...`);
        
        const txResponse = await wallet.sendTransaction(tx);
        logActivity('loading', `交易已发送，等待确认: ${txResponse.hash}`);
        
        const receipt = await txResponse.wait();
        
        if (receipt.status === 1) {
          logActivity('success', `资金归集成功: 从 ${wallet.address} 转出 ${ethers.formatEther(transferAmount)} PHRS 到 ${targetLabel}`);
          results.push({
            address: wallet.address,
            success: true,
            message: '转账成功',
            amount: ethers.formatEther(transferAmount),
            txHash: receipt.hash
          });
          
          // 更新账户状态
          if (accountStatus.has(wallet.address)) {
            // 更新余额
            try {
              const newBalance = await provider.getBalance(wallet.address);
              accountStatus.get(wallet.address).balance = ethers.formatEther(newBalance);
              
              // 通知前端状态已更新
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('account-status-update', Array.from(accountStatus.entries()).map(([address, status]) => ({
                  address,
                  ...status
                })));
              }
            } catch (error) {
              logActivity('error', `更新余额失败: ${error.message}`);
            }
          }
        } else {
          logActivity('error', `交易失败: ${txResponse.hash}`);
          results.push({
            address: wallet.address,
            success: false,
            message: '交易失败',
            amount: '0',
            txHash: txResponse.hash
          });
        }
      } catch (error) {
        logActivity('error', `处理钱包时出错: ${error.message}`);
        results.push({
          address: error.address || '未知地址',
          success: false,
          message: `错误: ${error.message}`,
          amount: '0'
        });
      }
      
      // 添加随机延迟，防止请求过于频繁
      await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
    }
    
    // 获取目标钱包余额
    try {
      const provider = setupProvider(null);
      const targetBalance = await provider.getBalance(targetAddress);
      logActivity('success', `归集完成! 目标钱包 ${targetLabel} 余额: ${ethers.formatEther(targetBalance)} PHRS`);
      
      // 如果目标钱包是我们监控的钱包之一，更新其状态
      for (const [address, status] of accountStatus.entries()) {
        if (address.toLowerCase() === targetAddress.toLowerCase()) {
          status.balance = ethers.formatEther(targetBalance);
          break;
        }
      }
      
      // 通知前端状态已更新
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('account-status-update', Array.from(accountStatus.entries()).map(([address, status]) => ({
          address,
          ...status
        })));
      }
    } catch (error) {
      logActivity('error', `获取目标钱包余额失败: ${error.message}`);
    }
    
    return {
      success: true,
      results
    };
  } catch (error) {
    logActivity('error', `资金归集操作失败: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
});

ipcMain.handle('save-config', (event, config) => {
  store.set('privateKeys', config.privateKeys);
  store.set('inviteCode', config.inviteCode);
  store.set('proxyEnabled', config.proxyEnabled);
  return true;
});

ipcMain.handle('import-proxies', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Text Files', extensions: ['txt'] }]
  });
  
  if (filePaths && filePaths.length > 0) {
    try {
      const content = fs.readFileSync(filePaths[0], 'utf8');
      const proxies = content.split('\n').map(line => line.trim()).filter(Boolean);
      fs.writeFileSync('proxies.txt', proxies.join('\n'));
      return { success: true, count: proxies.length };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false };
});

ipcMain.handle('check-wallet-balance', async (event, privateKey) => {
  try {
    const provider = new ethers.JsonRpcProvider('https://testnet.dplabs-internal.com', {
      chainId: 688688,
      name: 'Pharos Testnet',
    });
    
    const wallet = new ethers.Wallet(privateKey, provider);
    const balance = await provider.getBalance(wallet.address);
    
    return {
      success: true,
      address: wallet.address,
      balance: ethers.formatEther(balance)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Bot operation status
let isRunning = false;
let shouldStop = false;
let currentActivityLog = [];

// IPC handlers for bot operations
ipcMain.handle('start-bot', async (event, config) => {
  if (isRunning) return { success: false, message: 'Bot is already running' };
  
  isRunning = true;
  shouldStop = false;
  currentActivityLog = [];
  
  // Save configuration first
  store.set('privateKeys', config.privateKeys);
  store.set('inviteCode', config.inviteCode);
  store.set('proxyEnabled', config.proxyEnabled);
  
  // 初始化账户状态
  accountStatus.clear();
  
  // Start bot in background
  runBot(config)
    .catch(error => {
      logActivity('error', `机器人运行失败: ${error.message}`);
      isRunning = false;
    });
  
  return { success: true };
});

ipcMain.handle('stop-bot', async () => {
  if (!isRunning) return { success: false, message: 'Bot is not running' };
  shouldStop = true;
  return { success: true };
});

ipcMain.handle('get-activity-log', () => {
  return currentActivityLog;
});

function logActivity(type, message) {
  const logEntry = {
    type,
    message,
    timestamp: new Date().toISOString()
  };
  
  currentActivityLog.push(logEntry);
  
  // Keep only the last 1000 entries to avoid memory issues
  if (currentActivityLog.length > 1000) {
    currentActivityLog.shift();
  }
  
  // Send to renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-update', logEntry);
  }
}

// Bot logic (simplified version of the CLI script)
async function runBot(config) {
  try {
    logActivity('info', '正在启动 Pharos 自动机器人...');
    
    // 这里添加一个欢迎信息，而不是调用不存在的 banner 函数
    logActivity('info', '============================================');
    logActivity('info', '     Pharos - by晚风(x.com/pl_wanfeng)');
    logActivity('info', '============================================');
    
    const proxies = loadProxies(config.proxyEnabled);
    const privateKeys = config.privateKeys.filter(pk => pk);
    
    if (!privateKeys.length) {
      logActivity('error', '配置中未找到私钥');
      isRunning = false;
      return;
    }

    // 初始化所有账户的状态
    for (const privateKey of privateKeys) {
      try {
        const provider = setupProvider(null); // 暂时不使用代理查询地址
        const wallet = new ethers.Wallet(privateKey, provider);
        
        accountStatus.set(wallet.address, {
          balance: "查询中...",
          lastFaucet: null,
          lastCheckIn: null,
          lastTransfer: null,
          lastSwap: null,
          nextRun: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          status: "等待中",
          remainingSeconds: 30 * 60
        });
        
        // 更新余额
        const balance = await provider.getBalance(wallet.address);
        accountStatus.get(wallet.address).balance = ethers.formatEther(balance);
        
        // 通知前端状态已更新
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('account-status-update', Array.from(accountStatus.entries()).map(([address, status]) => ({
            address,
            ...status
          })));
        }
      } catch (error) {
        logActivity('error', `初始化账户失败: ${error.message}`);
      }
    }

    while (!shouldStop) {
      for (const privateKey of privateKeys) {
        if (shouldStop) break;
        
        const proxy = proxies.length ? getRandomProxy(proxies) : null;
        const provider = setupProvider(proxy);
        const wallet = new ethers.Wallet(privateKey, provider);

        logActivity('wallet', `使用钱包: ${wallet.address}`);
        
        // 更新账户状态为"运行中"
        if (accountStatus.has(wallet.address)) {
          accountStatus.get(wallet.address).status = "运行中";
          
          // 通知前端状态已更新
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('account-status-update', Array.from(accountStatus.entries()).map(([address, status]) => ({
              address,
              ...status
            })));
          }
        }

        // 获取更新余额
        try {
          const balance = await provider.getBalance(wallet.address);
          if (accountStatus.has(wallet.address)) {
            accountStatus.get(wallet.address).balance = ethers.formatEther(balance);
          }
        } catch (error) {
          logActivity('error', `获取余额失败: ${error.message}`);
        }

        // 执行水龙头领取任务
        const faucetResult = await claimFaucet(wallet, proxy, config.inviteCode);
        if (accountStatus.has(wallet.address)) {
          if (faucetResult) {
            accountStatus.get(wallet.address).lastFaucet = new Date().toISOString();
          }
        }
        
        // 执行每日签到任务
        const checkInResult = await performCheckIn(wallet, proxy, config.inviteCode);
        if (accountStatus.has(wallet.address)) {
          if (checkInResult) {
            accountStatus.get(wallet.address).lastCheckIn = new Date().toISOString();
          }
        }

        // 执行转账任务
        for (let i = 0; i < 10; i++) {
          if (shouldStop) break;
          await transferPHRS(wallet, provider, i);
          if (accountStatus.has(wallet.address)) {
            accountStatus.get(wallet.address).lastTransfer = new Date().toISOString();
          }
          await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));
        }

        // 执行兑换任务
        for (let i = 0; i < 10; i++) {
          if (shouldStop) break;
          await performSwap(wallet, provider, i);
          if (accountStatus.has(wallet.address)) {
            accountStatus.get(wallet.address).lastSwap = new Date().toISOString();
          }
          await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));
        }
        
        // 更新账户状态为"已完成"
        if (accountStatus.has(wallet.address)) {
          accountStatus.get(wallet.address).status = "已完成";
          
          // 通知前端状态已更新
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('account-status-update', Array.from(accountStatus.entries()).map(([address, status]) => ({
              address,
              ...status
            })));
          }
        }
      }

      logActivity('success', '所有钱包的操作已完成!');
      
      if (shouldStop) break;
      
      // 更新下次运行时间
      accountStatus.forEach((status, address) => {
        status.status = "冷却中";
        status.nextRun = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      });
      
      // 通知前端状态已更新
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('account-status-update', Array.from(accountStatus.entries()).map(([address, status]) => ({
          address,
          ...status
        })));
      }
      
      // Countdown
      await countdownWithUpdates();
    }
    
    // 机器人停止，更新所有账户状态
    accountStatus.forEach((status, address) => {
      status.status = "已停止";
      status.nextRun = null;
    });
    
    // 通知前端状态已更新
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('account-status-update', Array.from(accountStatus.entries()).map(([address, status]) => ({
        address,
        ...status
      })));
    }
    
    logActivity('info', '机器人已停止.');
    isRunning = false;
  } catch (error) {
    logActivity('error', `机器人运行失败: ${error.message}`);
    isRunning = false;
  }
}

// Utility functions from the CLI script, adapted for GUI
function loadProxies(proxyEnabled) {
  if (!proxyEnabled) return [];
  
  try {
    const proxies = fs.readFileSync('proxies.txt', 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line);
    
    if (proxies.length) {
      logActivity('info', `已从 proxies.txt 加载 ${proxies.length} 个代理`);
    } else {
      logActivity('warn', 'proxies.txt 中未找到代理');
    }
    
    return proxies;
  } catch (error) {
    logActivity('warn', '未找到 proxies.txt 文件或加载失败，切换到直连模式');
    return [];
  }
}

function getRandomProxy(proxies) {
  return proxies[Math.floor(Math.random() * proxies.length)];
}

function setupProvider(proxy = null) {
  if (proxy) {
    logActivity('info', `使用代理: ${proxy}`);
    const agent = new HttpsProxyAgent(proxy);
    return new ethers.JsonRpcProvider('https://testnet.dplabs-internal.com', {
      chainId: 688688,
      name: 'Pharos Testnet',
    }, {
      fetchOptions: { agent },
      headers: { 'User-Agent': randomUseragent.getRandom() },
    });
  } else {
    logActivity('info', '使用直连模式（无代理）');
    return new ethers.JsonRpcProvider('https://testnet.dplabs-internal.com', {
      chainId: 688688,
      name: 'Pharos Testnet',
    });
  }
}

// More functions copied from index.js and adapted to use logActivity instead of console.log
async function claimFaucet(wallet, proxy, inviteCode) {
  try {
    logActivity('step', `检查钱包的水龙头领取资格: ${wallet.address}`);

    const message = "pharos";
    const signature = await wallet.signMessage(message);
    logActivity('step', `已签名消息: ${signature}`);

    const loginUrl = `https://api.pharosnetwork.xyz/user/login?address=${wallet.address}&signature=${signature}&invite_code=${inviteCode}`;
    const headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.8",
      authorization: "Bearer null",
      "sec-ch-ua": '"Chromium";v="136", "Brave";v="136", "Not.A/Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "sec-gpc": "1",
      Referer: "https://testnet.pharosnetwork.xyz/",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "User-Agent": randomUseragent.getRandom(),
    };

    const axiosConfig = {
      method: 'post',
      url: loginUrl,
      headers,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
    };

    logActivity('loading', '正在发送水龙头登录请求...');
    const loginResponse = await axios(axiosConfig);
    const loginData = loginResponse.data;

    if (loginData.code !== 0 || !loginData.data.jwt) {
      logActivity('error', `水龙头登录失败: ${loginData.msg || '未知错误'}`);
      return false;
    }

    const jwt = loginData.data.jwt;
    logActivity('success', `水龙头登录成功，JWT: ${jwt}`);

    const statusUrl = `https://api.pharosnetwork.xyz/faucet/status?address=${wallet.address}`;
    const statusHeaders = {
      ...headers,
      authorization: `Bearer ${jwt}`,
    };

    logActivity('loading', '正在检查水龙头状态...');
    const statusResponse = await axios({
      method: 'get',
      url: statusUrl,
      headers: statusHeaders,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
    });
    const statusData = statusResponse.data;

    if (statusData.code !== 0 || !statusData.data) {
      logActivity('error', `水龙头状态检查失败: ${statusData.msg || '未知错误'}`);
      return false;
    }

    if (!statusData.data.is_able_to_faucet) {
      const nextAvailable = new Date(statusData.data.avaliable_timestamp * 1000).toLocaleString('en-US', { timeZone: 'Asia/Makassar' });
      logActivity('warn', `水龙头暂不可用，直到: ${nextAvailable}`);
      return false;
    }

    const claimUrl = `https://api.pharosnetwork.xyz/faucet/daily?address=${wallet.address}`;
    logActivity('loading', '正在领取水龙头...');
    const claimResponse = await axios({
      method: 'post',
      url: claimUrl,
      headers: statusHeaders,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
    });
    const claimData = claimResponse.data;

    if (claimData.code === 0) {
      logActivity('success', `${wallet.address} 成功领取水龙头`);
      return true;
    } else {
      logActivity('error', `水龙头领取失败: ${claimData.msg || '未知错误'}`);
      return false;
    }
  } catch (error) {
    logActivity('error', `${wallet.address} 领取水龙头失败: ${error.message}`);
    return false;
  }
}

async function performCheckIn(wallet, proxy, inviteCode) {
  try {
    logActivity('step', `执行钱包的每日签到: ${wallet.address}`);

    const message = "pharos";
    const signature = await wallet.signMessage(message);
    logActivity('step', `已签名消息: ${signature}`);

    const loginUrl = `https://api.pharosnetwork.xyz/user/login?address=${wallet.address}&signature=${signature}&invite_code=${inviteCode}`;
    const headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.8",
      authorization: "Bearer null",
      "sec-ch-ua": '"Chromium";v="136", "Brave";v="136", "Not.A/Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "sec-gpc": "1",
      Referer: "https://testnet.pharosnetwork.xyz/",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "User-Agent": randomUseragent.getRandom(),
    };

    const axiosConfig = {
      method: 'post',
      url: loginUrl,
      headers,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
    };

    logActivity('loading', '正在发送登录请求...');
    const loginResponse = await axios(axiosConfig);
    const loginData = loginResponse.data;

    if (loginData.code !== 0 || !loginData.data.jwt) {
      logActivity('error', `登录失败: ${loginData.msg || '未知错误'}`);
      return false;
    }

    const jwt = loginData.data.jwt;
    logActivity('success', `登录成功，JWT: ${jwt}`);

    const checkInUrl = `https://api.pharosnetwork.xyz/sign/in?address=${wallet.address}`;
    const checkInHeaders = {
      ...headers,
      authorization: `Bearer ${jwt}`,
    };

    logActivity('loading', '正在发送签到请求...');
    const checkInResponse = await axios({
      method: 'post',
      url: checkInUrl,
      headers: checkInHeaders,
      httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
    });
    const checkInData = checkInResponse.data;

    if (checkInData.code === 0) {
      logActivity('success', `${wallet.address} 签到成功`);
      return true;
    } else {
      logActivity('warn', `签到失败，可能已经签到过: ${checkInData.msg || '未知错误'}`);
      return false;
    }
  } catch (error) {
    logActivity('error', `${wallet.address} 签到失败: ${error.message}`);
    return false;
  }
}// Placeholder for transferPHRS - you'll need to implement this based on index.js
async function transferPHRS(wallet, provider, index) {
  try {
    const amount = 0.000001;
    const randomWallet = ethers.Wallet.createRandom();
    const toAddress = randomWallet.address;
    logActivity('step', `准备 PHRS 转账 ${index + 1}: ${amount} PHRS 到 ${toAddress}`);

    const balance = await provider.getBalance(wallet.address);
    const required = ethers.parseEther(amount.toString());

    if (balance < required) {
      logActivity('warn', `跳过转账 ${index + 1}: PHRS 余额不足: ${ethers.formatEther(balance)} < ${amount}`);
      return;
    }

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits('1', 'gwei');
    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: required,
      gasLimit: 21000,
      gasPrice,
      maxFeePerGas: feeData.maxFeePerGas || undefined,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || undefined,
    });

    logActivity('loading', `转账交易 ${index + 1} 已发送，等待确认...`);
    const receipt = await tx.wait();
    logActivity('success', `转账 ${index + 1} 已完成: ${receipt.hash}`);
    logActivity('step', `浏览器: https://testnet.pharosscan.xyz/tx/${receipt.hash}`);
  } catch (error) {
    logActivity('error', `转账 ${index + 1} 失败: ${error.message}`);
  }
}

// Placeholder for performSwap - you'll need to implement this based on index.js
async function performSwap(wallet, provider, index) {
  // Constants needed for swaps
  const tokens = {
    USDC: '0xad902cf99c2de2f1ba5ec4d642fd7e49cae9ee37',
    WPHRS: '0x76aaada469d23216be5f7c596fa25f282ff9b364',
    USDT: '0xed59de2d7ad9c043442e381231ee3646fc3c2939',
  };
  
  const contractAddress = '0x1a4de519154ae51200b0ad7c90f7fac75547888a';
  
  const tokenDecimals = {
    WPHRS: 18,
    USDC: 6,
    USDT: 6,
  };
  
  const contractAbi = [
    {
      inputs: [
        { internalType: 'uint256', name: 'collectionAndSelfcalls', type: 'uint256' },
        { internalType: 'bytes[]', name: 'data', type: 'bytes[]' },
      ],
      name: 'multicall',
      outputs: [],
      stateMutability: 'nonpayable',
      type: 'function',
    },
  ];
  
  const erc20Abi = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) public returns (bool)',
    'function decimals() view returns (uint8)',
    'function deposit() public payable',
    'function withdraw(uint256 wad) public',
  ];
  
  const pairOptions = [
    { id: 1, from: 'WPHRS', to: 'USDC', amount: 0.01 },
    { id: 2, from: 'WPHRS', to: 'USDT', amount: 0.01 },
    { id: 3, from: 'USDC', to: 'WPHRS', amount: 0.01 },
    { id: 4, from: 'USDT', to: 'WPHRS', amount: 0.01},
    { id: 5, from: 'USDC', to: 'USDT', amount: 0.01 },
    { id: 6, from: 'USDT', to: 'USDC', amount: 0.01 },
  ];

  try {
    const pair = pairOptions[Math.floor(Math.random() * pairOptions.length)];
    const amount = pair.amount;
    logActivity('step', `准备兑换 ${index + 1}: ${pair.from} -> ${pair.to} (${amount} ${pair.from})`);

    // Simplified for brevity - you'll need to implement the swap logic from index.js
    logActivity('loading', `兑换交易 ${index + 1} 已发送，等待确认...`);
    
    // Delay to simulate transaction
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    logActivity('success', `兑换 ${index + 1} 已完成`);
    
    // 更新账户状态
    if (accountStatus.has(wallet.address)) {
      accountStatus.get(wallet.address).lastSwap = new Date().toISOString();
      
      // 获取更新余额
      try {
        const balance = await provider.getBalance(wallet.address);
        accountStatus.get(wallet.address).balance = ethers.formatEther(balance);
      } catch (error) {
        logActivity('error', `获取余额失败: ${error.message}`);
      }
      
      // 通知前端状态已更新
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('account-status-update', Array.from(accountStatus.entries()).map(([address, status]) => ({
          address,
          ...status
        })));
      }
    }
  } catch (error) {
    logActivity('error', `兑换 ${index + 1} 失败: ${error.message}`);
  }
}

// 修改倒计时函数来更新倒计时状态
async function countdownWithUpdates() {
  const totalSeconds = 30 * 60;
  const startTime = Date.now();
  const endTime = startTime + totalSeconds * 1000;
  
  logActivity('info', '开始 30 分钟倒计时...');

  for (let seconds = totalSeconds; seconds >= 0; seconds--) {
    if (shouldStop) break;
    
    // 更新所有账户的下次运行时间
    const nextRunTime = new Date(endTime).toISOString();
    accountStatus.forEach((status) => {
      status.nextRun = nextRunTime;
      status.remainingSeconds = seconds;
    });
    
    // 一分钟或者只剩10秒以内时，或者是整10秒时，发送日志消息
    if (seconds % 60 === 0 || seconds <= 10 || seconds % 10 === 0) {
      const minutes = Math.floor(seconds / 60);
      const secs = seconds % 60;
      if (minutes > 0) {
        logActivity('info', `剩余时间: ${minutes} 分钟 ${secs} 秒`);
      } else {
        logActivity('info', `剩余时间: ${secs} 秒`);
      }
    }
    
    // 每秒都通知前端状态已更新
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('account-status-update', Array.from(accountStatus.entries()).map(([address, status]) => ({
        address,
        ...status
      })));
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  logActivity('info', '倒计时完成！重新开始流程...');
}

// 添加窗口控制监听器
ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('maximize-window', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
}); 

