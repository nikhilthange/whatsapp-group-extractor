const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Prevent EBUSY crash on Windows when LocalAuth attempts to remove locked session files
if (LocalAuth && LocalAuth.prototype) {
  LocalAuth.prototype.logout = async function () {
    if (this.userDataDir && fs.existsSync(this.userDataDir)) {
      try {
        await fs.promises.rm(this.userDataDir, { recursive: true, force: true, maxRetries: 5 });
      } catch (err) {
        console.warn('⚠️ Non-fatal notice: Session folder cleanup skipped due to active file lock.');
      }
    }
  };
}

// Helper to auto-detect installed Chrome or Edge executable on Windows/OS
function getChromeExecutablePath() {
  if (process.platform !== 'win32') return undefined; // Let puppeteer use bundled chromium on Linux/Mac Cloud

  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];

  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      console.log(`ℹ️ Auto-detected local browser: ${p}`);
      return p;
    }
  }
  return undefined; // Fallback to puppeteer bundled chromium
}

const chromePath = getChromeExecutablePath();
const isHeadless = process.env.HEADLESS === 'false' ? false : true;

// Initialize WhatsApp Web client configuration (Cloud & Local Ready)
const puppeteerConfig = {
  headless: isHeadless,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-component-update',
    '--no-default-browser-check',
    '--js-flags="--max-old-space-size=256"',
    '--renderer-process-limit=1',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--safebrowsing-disable-auto-update'
  ]
};

if (chromePath || process.env.PUPPETEER_EXECUTABLE_PATH) {
  puppeteerConfig.executablePath = chromePath || process.env.PUPPETEER_EXECUTABLE_PATH;
}

function createWhatsAppClient(sessionId) {
  const cleanSessionId = sessionId || 'default';
  const sessionDataPath = path.join(__dirname, '.wwebjs_auth', `session-${cleanSessionId}`);

  try {
    ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'].forEach(f => {
      const p = path.join(sessionDataPath, f);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch(e) {}
      }
    });

    ['Cache', 'Code Cache', 'GPUCache'].forEach(folder => {
      const p = path.join(sessionDataPath, folder);
      if (fs.existsSync(p)) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch(e) {}
      }
    });
  } catch(e) {}

  const newClient = new Client({
    authStrategy: new LocalAuth({
      clientId: `session-${cleanSessionId}`,
      dataPath: sessionDataPath
    }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    },
    authTimeoutMs: 300000,
    qrMaxRetries: 30,
    takeoverTimeoutMs: 300000,
    takeoverOnConflict: false,
    puppeteer: puppeteerConfig
  });

  newClient.on('loading_screen', async (percent, message) => {
    if (newClient.pupPage) {
      try {
        await newClient.pupPage.setRequestInterception(true);
        newClient.pupPage.removeAllListeners('request');
        newClient.pupPage.on('request', (req) => {
          const resourceType = req.resourceType();
          if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            req.abort();
          } else {
            req.continue();
          }
        });
      } catch(e) {}
    }
  });

  return newClient;
}

async function destroyWhatsAppSession(sessionId, targetClient) {
  if (targetClient) {
    try { await targetClient.logout(); } catch(e) {}
    try { await targetClient.destroy(); } catch(e) {}
  }
  const cleanSessionId = sessionId || 'default';
  const sessionDataPath = path.join(__dirname, '.wwebjs_auth', `session-${cleanSessionId}`);
  if (fs.existsSync(sessionDataPath)) {
    try {
      await fs.promises.rm(sessionDataPath, { recursive: true, force: true }).catch(() => {});
    } catch(e) {}
  }
}

async function getGroupsWithRetry(targetClient, maxAttempts = 6, intervalMs = 2500) {
  if (!targetClient) return [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[Groups Sync] Fetching chats (Attempt ${attempt}/${maxAttempts})...`);
      // Attempt 1: Standard API call
      let chats = await targetClient.getChats().catch(() => []);

      // Attempt 2: Direct In-Browser Store Evaluation Fallback
      if ((!chats || chats.length === 0) && targetClient.pupPage) {
        chats = await targetClient.pupPage.evaluate(() => {
          let models = [];
          try {
            if (window.require) {
              const collections = window.require('WAWebCollections');
              if (collections && collections.Chat && typeof collections.Chat.getModelsArray === 'function') {
                models = collections.Chat.getModelsArray();
              }
            }
          } catch (e) {}

          if (!models || models.length === 0) {
            try {
              if (window.Store && window.Store.Chat) {
                models = typeof window.Store.Chat.getModelsArray === 'function'
                  ? window.Store.Chat.getModelsArray()
                  : Array.from(window.Store.Chat.models || window.Store.Chat._models || []);
              }
            } catch (e) {}
          }

          return (models || []).map(c => {
            const rawId = c.id ? (typeof c.id === 'string' ? c.id : (c.id._serialized || c.id.$1 || c.id.user || '')) : '';
            const isGroup = Boolean(c.isGroup || (c.id && c.id.server === 'g.us') || (rawId && rawId.includes('@g.us')));
            return {
              id: rawId,
              isGroup: isGroup,
              name: c.formattedTitle || c.name || c.title || 'WhatsApp Group',
              participantsCount: c.groupMetadata && c.groupMetadata.participants ? c.groupMetadata.participants.length : (c.participants ? c.participants.length : 0)
            };
          });
        }).catch(() => []);
      }

      // Filter for group chats
      const groupChats = (chats || []).filter(c => {
        const jid = c.id ? (typeof c.id === 'string' ? c.id : (c.id._serialized || c._serialized || '')) : '';
        return Boolean(c.isGroup || (jid && (jid.endsWith('@g.us') || jid.includes('@g.us'))));
      });

      if (groupChats.length > 0) {
        console.log(`[Groups Sync] Success! Found ${groupChats.length} group chats on attempt ${attempt}.`);
        return groupChats.map(c => {
          const jid = c.id ? (typeof c.id === 'string' ? c.id : (c.id._serialized || c._serialized || '')) : '';
          const pCount = c.participantsCount !== undefined ? c.participantsCount : (c.participants ? c.participants.length : (c.groupMetadata ? (c.groupMetadata.participants ? c.groupMetadata.participants.length : 0) : 0));
          return {
            id: jid,
            groupJid: jid,
            name: c.name || c.formattedTitle || 'WhatsApp Group',
            memberCount: pCount,
            count: pCount
          };
        });
      }
    } catch (err) {
      console.error(`Attempt ${attempt} group fetch error:`, err.message);
    }

    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  return [];
}

async function fetchUserGroups(targetClient, maxRetries = 5) {
  return getGroupsWithRetry(targetClient, maxRetries, 3000);
}

async function getGroupListForClient(targetClient) {
  return getGroupsWithRetry(targetClient, 5, 3000);
}

async function exportGroupContactsForClient(targetClient, targetGroup) {
  const targetJid = (typeof targetGroup === 'string')
    ? targetGroup
    : (targetGroup.groupJid || targetGroup.id || (targetGroup.id && targetGroup.id._serialized ? targetGroup.id._serialized : ''));

  if (!targetJid) {
    throw new Error('Invalid Group JID provided');
  }

  let participantsRaw = [];
  let groupTitle = (targetGroup && targetGroup.name) || 'WhatsApp Group';

  for (let attempt = 1; attempt <= 4; attempt++) {
    // Attempt A: Standard client.getChatById()
    try {
      const chat = await targetClient.getChatById(targetJid).catch(() => null);
      if (chat) {
        if (chat.name) groupTitle = chat.name;
        if (chat.participants && chat.participants.length > 0) {
          participantsRaw = chat.participants;
        }
      }
    } catch(e) {}

    // Attempt B: In-Browser Page Evaluation querying WAWebCollections, Store.Chat, and Store.GroupMetadata
    if ((!participantsRaw || participantsRaw.length === 0) && targetClient.pupPage) {
      try {
        const evalResult = await targetClient.pupPage.evaluate((gJid) => {
          let title = 'WhatsApp Group';
          let parts = [];

          // Helper 1: Query Chat Collection / Store
          let chatModel = null;
          try {
            if (window.require) {
              const collections = window.require('WAWebCollections');
              if (collections && collections.Chat && typeof collections.Chat.get === 'function') {
                chatModel = collections.Chat.get(gJid);
              }
            }
          } catch(e) {}

          if (!chatModel && window.Store && window.Store.Chat) {
            try {
              if (typeof window.Store.Chat.get === 'function') {
                chatModel = window.Store.Chat.get(gJid);
              } else {
                const models = Array.from(window.Store.Chat.models || window.Store.Chat._models || []);
                chatModel = models.find(m => {
                  const mid = m.id ? (typeof m.id === 'string' ? m.id : (m.id._serialized || m.id.$1 || m.id.user || '')) : '';
                  return mid === gJid || mid.includes(gJid) || gJid.includes(mid);
                });
              }
            } catch(e) {}
          }

          if (chatModel) {
            title = chatModel.formattedTitle || chatModel.name || chatModel.title || title;
            if (chatModel.groupMetadata && chatModel.groupMetadata.participants) {
              parts = Array.from(chatModel.groupMetadata.participants);
            } else if (chatModel.participants) {
              parts = Array.from(chatModel.participants);
            }
          }

          // Helper 2: Query GroupMetadata Collection / Store if participants empty
          if (!parts || parts.length === 0) {
            try {
              let metaModel = null;
              if (window.Store && window.Store.GroupMetadata) {
                if (typeof window.Store.GroupMetadata.get === 'function') {
                  metaModel = window.Store.GroupMetadata.get(gJid);
                }
                if (!metaModel) {
                  const metaModels = Array.from(window.Store.GroupMetadata.models || window.Store.GroupMetadata._models || []);
                  metaModel = metaModels.find(m => {
                    const mid = m.id ? (typeof m.id === 'string' ? m.id : (m.id._serialized || m.id.$1 || m.id.user || '')) : '';
                    return mid === gJid || mid.includes(gJid) || gJid.includes(mid);
                  });
                }
              }
              if (metaModel && metaModel.participants) {
                parts = Array.from(metaModel.participants);
              }
            } catch(e) {}
          }

          // Helper 3: Search all Chat models by partial or numeric JID matching
          if (!parts || parts.length === 0) {
            try {
              const cleanNum = gJid.replace(/[^0-9]/g, '');
              const allModels = Array.from((window.Store && window.Store.Chat && (window.Store.Chat.models || window.Store.Chat._models)) || []);
              for (const m of allModels) {
                const mid = m.id ? (typeof m.id === 'string' ? m.id : (m.id._serialized || m.id.$1 || m.id.user || '')) : '';
                if (mid.includes(cleanNum) || (m.formattedTitle && gJid.includes(m.formattedTitle))) {
                  title = m.formattedTitle || m.name || title;
                  if (m.groupMetadata && m.groupMetadata.participants) {
                    parts = Array.from(m.groupMetadata.participants);
                    break;
                  } else if (m.participants) {
                    parts = Array.from(m.participants);
                    break;
                  }
                }
              }
            } catch(e) {}
          }

          return {
            title: title,
            participants: (parts || []).map(p => ({
              id: p.id ? (typeof p.id === 'string' ? p.id : (p.id._serialized || p.id.$1 || p.id.user || '')) : '',
              user: p.id ? (typeof p.id === 'string' ? p.id.split('@')[0] : (p.id.user || '')) : '',
              isAdmin: Boolean(p.isAdmin || p.isSuperAdmin || p.role === 'admin' || p.role === 'superadmin'),
              name: p.name || p.pushname || (p.contact ? (p.contact.name || p.contact.pushname) : '')
            }))
          };
        }, targetJid).catch(() => null);

        if (evalResult) {
          if (evalResult.title && evalResult.title !== 'WhatsApp Group') groupTitle = evalResult.title;
          if (evalResult.participants && evalResult.participants.length > 0) {
            participantsRaw = evalResult.participants;
          }
        }
      } catch(e) {
        console.warn(`[Group Contacts Sync] Page eval error on attempt ${attempt}:`, e.message);
      }
    }

    if (participantsRaw && participantsRaw.length > 0) break;

    if (attempt < 4) {
      console.log(`[Group Contacts Sync] Attempt ${attempt}/4: Participants not yet loaded for group "${groupTitle}" (${targetJid}). Retrying in 1.5s...`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (!participantsRaw || participantsRaw.length === 0) {
    throw new Error(`Group chat (${groupTitle}) participants could not be loaded from WhatsApp Web.`);
  }

  const finalRecords = participantsRaw.map((p, idx) => {
    const sId = p.id ? (typeof p.id === 'string' ? p.id : (p.id._serialized || p.id)) : '';
    const userNum = p.user || (p.id ? (typeof p.id === 'string' ? p.id.split('@')[0] : (p.id.user || String(sId).split('@')[0])) : '');
    const isAdminRole = Boolean(p.isAdmin || p.isSuperAdmin || p.role === 'admin' || p.role === 'superadmin');

    return {
      index: idx + 1,
      id: sId,
      userJid: sId,
      phone: userNum ? '+' + userNum : 'N/A',
      phoneNumber: userNum ? '+' + userNum : 'N/A',
      name: p.name || p.pushname || (p.contact ? (p.contact.name || p.contact.pushname) : 'N/A') || (userNum ? '+' + userNum : 'N/A'),
      isAdmin: isAdminRole ? 'Yes' : 'No',
      role: isAdminRole ? 'Group Admin' : 'Member',
      groupName: groupTitle
    };
  });

  return {
    groupName: groupTitle,
    finalRecords: finalRecords
  };
}

const client = createWhatsAppClient('default');

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(query, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim().replace(/\s+/g, '_') || 'group';
}

// Resilient evaluation wrapper that retries upon execution context destruction
async function safeEvaluate(fn, ...args) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!client.pupPage || client.pupPage.isClosed()) return null;
      return await client.pupPage.evaluate(fn, ...args);
    } catch (err) {
      if (err.message.includes('Execution context was destroyed') || err.message.includes('navigating') || err.message.includes('Target closed')) {
        console.warn(`⚠️ Execution context reset (attempt ${attempt}/3). Waiting 2s for page to stabilize...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw err;
      }
    }
  }
  return null;
}

async function exportGroupContacts(targetGroup) {
  console.log(`\n--------------------------------------------------`);
  console.log(`⏳ Extracting contacts for group: "${targetGroup.name}"...`);

  const groupJid = targetGroup.groupJid || (targetGroup.id && targetGroup.id._serialized ? targetGroup.id._serialized : targetGroup.userJid);
  console.log(`🔗 Target Group JID: ${groupJid}`);

  const myUserNum = (client.info && client.info.wid) ? (client.info.wid.user || client.info.wid._serialized.split('@')[0]) : '';
  console.log(`👤 Logged-in user account: ${myUserNum || 'N/A'}`);

  let extractedContacts = [];

  // A. Type into Search Box via Puppeteer Keyboard to open chat
  if (client.pupPage && targetGroup.name) {
    try {
      const cleanName = targetGroup.name.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim() || targetGroup.name;
      const firstWord = cleanName.split(/\s+/)[0] || cleanName;

      const searchSelector = 'div[contenteditable="true"][data-tab="3"], div[contenteditable="true"], div[role="textbox"]';
      const searchBox = await client.pupPage.$(searchSelector);
      if (searchBox) {
        await searchBox.click();
        await client.pupPage.keyboard.down('Control');
        await client.pupPage.keyboard.press('A');
        await client.pupPage.keyboard.up('Control');
        await client.pupPage.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 300));
        await client.pupPage.keyboard.type(firstWord, { delay: 50 });
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch(e) {}
  }

  // B. DOM Drawer Extraction & Validation
  if (client.pupPage && groupJid) {
    try {
      const domContacts = await safeEvaluate(async (gJid, gName, myNum) => {
        const triggerClick = (el) => {
          if (!el) return;
          ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evtName => {
            try {
              el.dispatchEvent(new MouseEvent(evtName, {
                bubbles: true,
                cancelable: true,
                view: window
              }));
            } catch(e) {}
          });
        };

        const cleanName = gName.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim() || gName;
        const firstWord = cleanName.split(/\s+/)[0] || cleanName;

        // Step 1: Click Matching Chat Card
        const chatCards = Array.from(document.querySelectorAll('div[role="listitem"], div[role="row"]'));
        let chatCard = chatCards.find(c => {
          const t = (c.innerText || '').toLowerCase();
          return t.includes(gName.toLowerCase()) || t.includes(cleanName.toLowerCase()) || t.includes(firstWord.toLowerCase());
        });

        if (!chatCard) {
          const allSpans = Array.from(document.querySelectorAll('#pane-side span[title], #pane-side span[dir="auto"], span[title]'));
          const matchingSpan = allSpans.find(s => {
            const t = (s.getAttribute('title') || s.innerText || '').trim();
            return t === gName || t === cleanName || t.includes(cleanName) || (firstWord.length > 2 && t.includes(firstWord));
          });
          if (matchingSpan) {
            chatCard = matchingSpan.closest('div[role="listitem"]') || 
                       matchingSpan.closest('div[role="row"]') || 
                       matchingSpan.closest('div[tabindex="-1"]') || 
                       matchingSpan;
          }
        }

        if (chatCard) {
          triggerClick(chatCard);
          await new Promise(r => setTimeout(r, 2000));
        }

        const contactMap = new Map();

        // Step 1: Internal GroupMetadata Update & LID Resolution
        if (window.require) {
          try {
            let chatColl = null;
            try { chatColl = window.require('WAWebChatCollection').Chat; } catch(e) {}
            if (!chatColl) {
              try { chatColl = window.require('WAWebCollections').Chat; } catch(e) {}
            }
            if (!chatColl && window.Store && window.Store.Chat) {
              chatColl = window.Store.Chat;
            }

            let contactColl = null;
            try { contactColl = window.require('WAWebContactCollection').Contact; } catch(e) {}
            if (!contactColl) {
              try { contactColl = window.require('WAWebContactModel').Contact; } catch(e) {}
            }
            if (!contactColl && window.Store && window.Store.Contact) {
              contactColl = window.Store.Contact;
            }

            const targetChat = chatColl ? (chatColl.get(gJid) || chatColl.get(gJid.split('@')[0])) : null;

            if (targetChat) {
              let toPn = (id) => id;
              try {
                const lidUtils = window.require('WAWebLidMigrationUtils');
                if (lidUtils && lidUtils.toPn) toPn = lidUtils.toPn;
              } catch(e) {}

              const meta = targetChat.groupMetadata || targetChat.groupMetadataModel;
              if (meta) {
                const serialized = meta.serialize ? meta.serialize() : meta;
                const pList = serialized.participants || [];
                pList.forEach(p => {
                  const pId = toPn(p.id) ?? p.id;
                  const sId = typeof pId === 'string' ? pId : (pId._serialized || (pId.user ? pId.user + '@c.us' : ''));
                  const uPart = (pId && pId.user) ? pId.user : (typeof sId === 'string' ? sId.split('@')[0] : '');

                  if (sId && uPart && (myNum ? uPart !== myNum : true)) {
                    const phone = /^\d{10,15}$/.test(uPart) ? '+' + uPart : 'N/A';
                    const key = (phone !== 'N/A') ? phone : sId;

                    let name = 'N/A';
                    if (p.name || p.pushname) {
                      name = p.name || p.pushname;
                    }

                    if ((!name || name === 'N/A') && contactColl && typeof contactColl.get === 'function') {
                      const cObj = contactColl.get(sId) || contactColl.get(uPart + '@c.us') || contactColl.get(uPart + '@s.whatsapp.net');
                      if (cObj) {
                        name = cObj.name || cObj.pushname || cObj.verifiedName || (cObj.formattedName && !cObj.formattedName.includes('+') ? cObj.formattedName : 'N/A');
                      }
                    }

                    if ((!name || name === 'N/A') && p.contact) {
                      name = p.contact.name || p.contact.pushname || p.contact.verifiedName || 'N/A';
                    }

                    if (typeof name === 'string') {
                      name = name.trim().replace(/^~\s*/, '');
                      if (!name || name.includes('+') || /^\d+$/.test(name)) {
                        name = 'N/A';
                      }
                    } else {
                      name = 'N/A';
                    }

                    if (!contactMap.has(key)) {
                      contactMap.set(key, {
                        phoneNumber: phone,
                        name: name,
                        isAdmin: Boolean(p.isAdmin || p.isSuperAdmin) ? 'Yes' : 'No',
                        userJid: sId.endsWith('@c.us') || sId.endsWith('@s.whatsapp.net') ? sId : uPart + '@c.us'
                      });
                    } else {
                      const existing = contactMap.get(key);
                      if ((!existing.name || existing.name === 'N/A') && name !== 'N/A') {
                        existing.name = name;
                      }
                    }
                  }
                });
              }
            }
          } catch(e) {}
        }

        // Step 3: Open Right Drawer & Strict Container Isolation DOM Extraction
        let rightPanel = document.querySelector('div[role="dialog"]') ||
                         document.querySelector('div[role="region"]') || 
                         document.querySelector('aside');

        if (!rightPanel) {
          const mainHeader = document.querySelector('#main header') || document.querySelector('header');
          if (mainHeader) {
            const titleBtn = mainHeader.querySelector('span[title]') || mainHeader.querySelector('div[role="button"]') || mainHeader;
            if (titleBtn) triggerClick(titleBtn);
            await new Promise(r => setTimeout(r, 2500));
          }
          rightPanel = document.querySelector('div[role="dialog"]') ||
                       document.querySelector('div[role="region"]') || 
                       document.querySelector('aside');
        }

        if (rightPanel) {
          const buttons = Array.from(rightPanel.querySelectorAll('div[role="button"], span, div'));
          const viewAllBtn = buttons.find(b => {
            const txt = (b.innerText || '').toLowerCase();
            return (txt.includes('view all') || txt.includes('more members') || txt.includes('members')) && 
                   !b.closest('#pane-side') && 
                   !b.closest('#main');
          });

          if (viewAllBtn) {
            try {
              triggerClick(viewAllBtn);
              await new Promise(r => setTimeout(r, 1500));
              const dialog = document.querySelector('div[role="dialog"]');
              if (dialog) rightPanel = dialog;
            } catch(e) {}
          }

          const scrollContainer = rightPanel.querySelector('div[tabindex="-1"]') || 
                                  rightPanel;

          let lastScrollTop = -1;
          let sameCount = 0;

          const phoneRegex = /\+?\d[\d\s\-]{8,18}\d/;
          const ignoredLabels = ['Group Admin', 'Admin', 'You', 'Select All', 'Community', 'Media, links and docs', 'Community Admin', 'All', 'Unread', 'Favourites', 'Favorites', 'Groups', 'Groups in common', 'Mute notifications'];

          while (sameCount < 5) {
            let listItems = Array.from(rightPanel.querySelectorAll('div[role="listitem"], div[role="row"]'));
            if (listItems.length === 0) {
              listItems = Array.from(rightPanel.querySelectorAll('div[tabindex="-1"]'));
            }
            
            listItems.forEach((item) => {
              if (item.closest('#pane-side') || item.closest('#main')) return;
              const text = (item.innerText || '').trim();
              if (!text) return;
              if (text.includes('Media, links and docs') || text.includes('Groups in common') || text.includes('Mute notifications')) return;

              const match = text.match(phoneRegex);
              if (match) {
                const digits = match[0].replace(/[^0-9]/g, '');
                if (digits.length >= 10 && digits.length <= 15 && (myNum ? digits !== myNum : true)) {
                  const phone = '+' + digits;
                  let name = 'N/A';
                  const nameSpans = Array.from(item.querySelectorAll('span[title], span[dir="auto"]'));
                  for (const span of nameSpans) {
                    let val = (span.getAttribute('title') || span.innerText || '').trim();
                    if (val) {
                      val = val.replace(/^~\s*/, '').trim();
                      if (
                        val && 
                        !val.includes('+') && 
                        !/^\d+$/.test(val) && 
                        !ignoredLabels.includes(val)
                      ) {
                        name = val;
                        break;
                      }
                    }
                  }
                  const isAdmin = text.includes('Group Admin') || text.includes('Admin') ? 'Yes' : 'No';

                  if (!contactMap.has(phone)) {
                    contactMap.set(phone, {
                      phoneNumber: phone,
                      name: name,
                      isAdmin: isAdmin,
                      userJid: digits + '@c.us'
                    });
                  } else {
                    const existing = contactMap.get(phone);
                    if ((!existing.name || existing.name === 'N/A') && name !== 'N/A') {
                      existing.name = name;
                    }
                    if (isAdmin === 'Yes') {
                      existing.isAdmin = 'Yes';
                    }
                  }
                }
              }
            });

            scrollContainer.scrollTop += 400;
            try {
              scrollContainer.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true }));
            } catch(e) {}

            await new Promise((r) => setTimeout(r, 600));

            if (scrollContainer.scrollTop === lastScrollTop) {
              sameCount++;
            } else {
              sameCount = 0;
              lastScrollTop = scrollContainer.scrollTop;
            }
          }
        }

        return Array.from(contactMap.values());
      }, groupJid, targetGroup.name, myUserNum);

      if (domContacts && domContacts.length > 0) {
        extractedContacts = extractedContacts.concat(domContacts);
      }
    } catch (err) {
      console.warn('⚠️ Evaluate notice:', err.message);
    }
  }

  console.log(`📋 Found ${extractedContacts ? extractedContacts.length : 0} raw contact records.`);

  // 4. Secondary Pass & CSV Export
  if (extractedContacts && extractedContacts.length > 0) {
    console.log(`📋 Resolving contact details for ${extractedContacts.length} group members...`);

    // A. Fast in-browser evaluation batch pass to fetch names from WhatsApp internal store
    if (client.pupPage) {
      try {
        const resolvedNamesMap = await safeEvaluate(async (contacts) => {
          let contactColl = null;
          try { contactColl = window.require('WAWebContactCollection').Contact; } catch(e) {}
          if (!contactColl && window.Store && window.Store.Contact) {
            contactColl = window.Store.Contact;
          }

          const resultMap = {};
          if (!contactColl) return resultMap;

          for (const c of contacts) {
            if (c.userJid) {
              const cObj = (typeof contactColl.get === 'function') ? (contactColl.get(c.userJid) || contactColl.get(c.userJid.replace('@c.us', '@s.whatsapp.net')) || contactColl.get(c.userJid.split('@')[0] + '@c.us')) : null;
              if (cObj) {
                let n = cObj.name || cObj.pushname || cObj.verifiedName || cObj.shortName;
                if (!n && cObj.formattedName && !cObj.formattedName.includes('+') && !/^\d+$/.test(cObj.formattedName)) {
                  n = cObj.formattedName;
                }
                if (n && typeof n === 'string' && n.trim()) {
                  n = n.trim().replace(/^~\s*/, '');
                  if (n && n !== 'N/A' && !n.includes('+') && !/^\d+$/.test(n)) {
                    resultMap[c.userJid] = n;
                  }
                }
              }
            }
          }
          return resultMap;
        }, extractedContacts);

        if (resolvedNamesMap) {
          for (const c of extractedContacts) {
            if ((!c.name || c.name === 'N/A') && c.userJid && resolvedNamesMap[c.userJid]) {
              c.name = resolvedNamesMap[c.userJid];
            }
          }
        }
      } catch (e) {}
    }

    // B. Secondary fallback pass via client.getContactById for any contact still missing a name or phone
    for (const c of extractedContacts) {
      if ((!c.phoneNumber || c.phoneNumber === 'N/A') && c.userJid) {
        const userPart = c.userJid.split('@')[0];
        if (/^\d{10,14}$/.test(userPart) && (myUserNum ? userPart !== myUserNum : true)) {
          c.phoneNumber = '+' + userPart;
        }
      }

      if ((!c.name || c.name === 'N/A') && c.userJid) {
        try {
          const contactObj = await client.getContactById(c.userJid);
          if (contactObj) {
            if (contactObj.number && /^\d{10,15}$/.test(contactObj.number) && (myUserNum ? contactObj.number !== myUserNum : true)) {
              c.phoneNumber = '+' + contactObj.number;
            }
            const fetchedName = contactObj.name || contactObj.pushname || contactObj.formattedName || contactObj.shortName;
            if (fetchedName && typeof fetchedName === 'string' && fetchedName.trim()) {
              const cleanName = fetchedName.trim().replace(/^~\s*/, '');
              if (cleanName && cleanName !== 'N/A' && !cleanName.includes('+') && !/^\d+$/.test(cleanName)) {
                c.name = cleanName;
              }
            }
          }
        } catch (e) {}
      }
    }
  }

  // Deduplicate final records by phoneNumber or userJid
  const finalMap = new Map();
  if (extractedContacts && extractedContacts.length > 0) {
    extractedContacts.forEach(c => {
      const userPart = c.userJid ? c.userJid.split('@')[0] : '';
      if (myUserNum && userPart === myUserNum) return;

      const key = (c.phoneNumber && c.phoneNumber !== 'N/A') ? c.phoneNumber : c.userJid;
      if (key) {
        if (!finalMap.has(key)) {
          finalMap.set(key, c);
        } else {
          const existing = finalMap.get(key);
          if ((!existing.name || existing.name === 'N/A') && c.name && c.name !== 'N/A') {
            existing.name = c.name;
          }
          if (c.isAdmin === 'Yes') {
            existing.isAdmin = 'Yes';
          }
        }
      }
    });
  }

  const finalRecords = Array.from(finalMap.values());

  const safeName = sanitizeFilename(targetGroup.name);
  const timestamp = Date.now();
  const excelFilename = `whatsapp_${safeName}_contacts_${timestamp}.xlsx`;
  const excelFilePath = path.join(__dirname, excelFilename);

  // Build Excel (.xlsx) Worksheet with Headers & Auto Column Widths
  const excelHeaders = ['PHONE_NUMBER', 'NAME', 'IS_ADMIN', 'USER_JID'];
  const excelData = [
    excelHeaders,
    ...finalRecords.map(r => [r.phoneNumber || 'N/A', r.name || 'N/A', r.isAdmin || 'No', r.userJid || ''])
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(excelData);

  // Set professional column widths for Excel
  worksheet['!cols'] = [
    { wch: 18 }, // PHONE_NUMBER
    { wch: 28 }, // NAME
    { wch: 12 }, // IS_ADMIN
    { wch: 30 }  // USER_JID
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Group Contacts');
  XLSX.writeFile(workbook, excelFilePath);

  // Also write CSV for legacy compatibility
  const csvFilename = `whatsapp_${safeName}_contacts_${timestamp}.csv`;
  const csvFilePath = path.join(__dirname, csvFilename);
  const csvWriter = createCsvWriter({
    path: csvFilePath,
    header: [
      { id: 'phoneNumber', title: 'PHONE_NUMBER' },
      { id: 'name', title: 'NAME' },
      { id: 'isAdmin', title: 'IS_ADMIN' },
      { id: 'userJid', title: 'USER_JID' }
    ]
  });
  await csvWriter.writeRecords(finalRecords);

  console.log(`\n✅ Successfully extracted ${finalRecords.length} group contacts!`);
  console.log(`📊 Saved Excel Workbook: ./${excelFilename}`);
  console.log(`📁 Saved CSV File:     ./${csvFilename}`);
  return { finalRecords, excelFilename, csvFilename };
}

if (require.main === module) {
  // 1. Display QR Code for WhatsApp Pairing in CLI Mode
  client.on('qr', (qr) => {
    console.log('\n==================================================');
    console.log('📱 Scan the QR code below using WhatsApp on your phone:');
    console.log('   WhatsApp -> Settings / Linked Devices -> Link a Device');
    console.log('==================================================\n');
    qrcode.generate(qr, { small: true });
  });

  // 2. Client Authenticated & Ready in CLI Mode
  client.on('ready', async () => {
    console.log('\n==================================================');
    console.log('🚀 Client is authenticated and ready!');
    console.log('==================================================\n');

    try {
      console.log('⏳ Waiting 5 seconds for WhatsApp Web session to initialize...');
      await new Promise((resolve) => setTimeout(resolve, 5000));

      console.log('🔍 Fetching active group chats...');
      let chats = [];

      try {
        chats = await client.getChats();
      } catch (e) {
        console.warn('⚠️ Standard client.getChats() encountered an issue, executing Store evaluation fallback...');
      }

      if (!chats || chats.length === 0) {
        chats = await safeEvaluate(async () => {
          let chatModels = [];
          try {
            if (window.require) {
              const collections = window.require('WAWebCollections');
              if (collections && collections.Chat && typeof collections.Chat.getModelsArray === 'function') {
                chatModels = collections.Chat.getModelsArray();
              }
            }
          } catch (e) {}

          if (!chatModels || chatModels.length === 0) {
            try {
              if (window.Store && window.Store.Chat) {
                if (typeof window.Store.Chat.getModelsArray === 'function') {
                  chatModels = window.Store.Chat.getModelsArray();
                } else if (window.Store.Chat.models) {
                  chatModels = Array.from(window.Store.Chat.models);
                } else if (window.Store.Chat._models) {
                  chatModels = Array.from(window.Store.Chat._models);
                }
              }
            } catch (e) {}
          }

          if (!chatModels) chatModels = [];

          return chatModels.map(c => {
            const serializedId = (c.id && (c.id._serialized || (typeof c.id === 'string' ? c.id : ''))) || '';
            const isGroupChat = Boolean(c.isGroup || (c.id && c.id.server === 'g.us') || serializedId.endsWith('@g.us'));

            return {
              groupJid: serializedId,
              isGroup: isGroupChat,
              name: c.formattedTitle || c.name || c.title || 'Unnamed Group'
            };
          });
        });
      }

      const groupChats = (chats || []).filter(c => Boolean(c.isGroup || (c.id && c.id.server === 'g.us') || (c.id && c.id._serialized && c.id._serialized.endsWith('@g.us')) || (c.groupJid && c.groupJid.endsWith('@g.us'))));

      if (groupChats.length === 0) {
        console.log('⚠️ No group chats found on this WhatsApp account.');
        await client.destroy();
        process.exit(0);
      }

      console.log(`\n📋 Found ${groupChats.length} group chats:\n`);
      groupChats.forEach((group, index) => {
        const gName = group.name || group.formattedTitle || 'Unnamed Group';
        console.log(` [${index + 1}] ${gName}`);
      });

      console.log(` [A] Export ALL groups`);
      console.log(` [Q] Quit\n`);

      let choice = await askQuestion('👉 Enter group option number to export (e.g. 1), "A" for All, or press Enter for [1]: ');

      if (!choice) choice = '1';

      if (choice.toUpperCase() === 'Q') {
        console.log('Exiting...');
      } else if (choice.toUpperCase() === 'A') {
        console.log(`\n🚀 Exporting all ${groupChats.length} groups...`);
        for (const group of groupChats) {
          await exportGroupContacts(group);
        }
        console.log('\n🎉 All group exports complete!');
      } else {
        const selectedIndex = parseInt(choice, 10) - 1;
        if (!isNaN(selectedIndex) && selectedIndex >= 0 && selectedIndex < groupChats.length) {
          const targetGroup = groupChats[selectedIndex];
          await exportGroupContacts(targetGroup);
        } else {
          console.log('❌ Invalid selection. Defaulting to first group [1]...');
          await exportGroupContacts(groupChats[0]);
        }
      }

    } catch (error) {
      console.error('❌ Error extracting group contacts:', error);
    } finally {
      console.log('\nClosing WhatsApp session...');
      try {
        if (client && client.pupBrowser) {
          await client.pupBrowser.close().catch(() => {});
        }
        if (client) {
          await client.destroy().catch(() => {});
        }
      } catch(e) {}
      process.exit(0);
    }
  });

  client.on('auth_failure', msg => {
    console.error('❌ Authentication failed:', msg);
  });

  client.initialize();
}

module.exports = {
  client,
  exportGroupContacts,
  createWhatsAppClient,
  destroyWhatsAppSession,
  getGroupListForClient,
  fetchUserGroups,
  getGroupsWithRetry,
  exportGroupContactsForClient
};
