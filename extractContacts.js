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
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-component-update',
    '--no-default-browser-check',
    '--js-flags="--max-old-space-size=128"',
    '--renderer-process-limit=1',
    '--disable-site-isolation-trials',
    '--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess',
    '--enable-low-end-device-mode',
    '--memory-pressure-off',
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
      type: 'local'
    },
    authTimeoutMs: 300000,
    qrMaxRetries: 30,
    takeoverTimeoutMs: 300000,
    takeoverOnConflict: false,
    puppeteer: puppeteerConfig
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

async function getGroupsWithRetry(targetClient, maxAttempts = 5, intervalMs = 1500) {
  if (!targetClient) return [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let groupChats = [];

      // 1. Direct In-Browser Store Evaluation (Fastest & Most Complete)
      if (targetClient.pupPage) {
        try {
          const evaluated = await safeEvaluate(targetClient, () => {
            let models = [];
            if (window.Store && window.Store.Chat) {
              models = typeof window.Store.Chat.getModelsArray === 'function'
                ? window.Store.Chat.getModelsArray()
                : Array.from(window.Store.Chat.models || window.Store.Chat._models || []);
            }
            if ((!models || models.length === 0) && window.require) {
              try {
                const collections = window.require('WAWebCollections');
                if (collections && collections.Chat && typeof collections.Chat.getModelsArray === 'function') {
                  models = collections.Chat.getModelsArray();
                }
              } catch(e) {}
            }

            return (models || []).map(c => {
              const rawId = c.id ? (typeof c.id === 'string' ? c.id : (c.id._serialized || c.id.$1 || c.id.user || '')) : '';
              const isGroup = Boolean(c.isGroup || (c.id && c.id.server === 'g.us') || (rawId && rawId.includes('@g.us')));
              
              let pCount = 0;
              const pColl = (c.groupMetadata && c.groupMetadata.participants) || c.participants;
              if (pColl) {
                pCount = Array.isArray(pColl) ? pColl.length : (typeof pColl.getModelsArray === 'function' ? pColl.getModelsArray().length : (pColl.models ? pColl.models.length : 0));
              }
              return {
                id: rawId,
                groupJid: rawId,
                isGroup: isGroup,
                name: c.formattedTitle || c.name || c.title || 'WhatsApp Group',
                memberCount: pCount,
                count: pCount
              };
            }).filter(g => g.isGroup || (g.id && g.id.includes('@g.us')));

            return evaluated;
          }).catch(() => []);

          if (evaluated && evaluated.length > 0) {
            groupChats = evaluated;
          }
        } catch(e) {}
      }

      // 2. Standard whatsapp-web.js API call fallback
      if ((!groupChats || groupChats.length === 0) && targetClient.getChats) {
        try {
          const chats = await targetClient.getChats().catch(() => []);
          if (chats && chats.length > 0) {
            groupChats = chats.filter(c => {
              const jid = c.id ? (typeof c.id === 'string' ? c.id : (c.id._serialized || c._serialized || '')) : '';
              return Boolean(c.isGroup || (c.id && c.id.server === 'g.us') || (jid && jid.includes('@g.us')));
            }).map(c => {
              const jid = c.id ? (typeof c.id === 'string' ? c.id : (c.id._serialized || c._serialized || '')) : '';
              const pCount = c.participantsCount !== undefined ? c.participantsCount : (c.participants ? c.participants.length : 0);
              return {
                id: jid,
                groupJid: jid,
                name: c.name || c.formattedTitle || 'WhatsApp Group',
                memberCount: pCount,
                count: pCount
              };
            });
          }
        } catch(e) {}
      }

      if (groupChats && groupChats.length > 0) {
        console.log(`[Groups Sync] Success! Found ${groupChats.length} group chats on attempt ${attempt}.`);
        return groupChats;
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
  return getGroupsWithRetry(targetClient, maxRetries, 1500);
}

async function getGroupListForClient(targetClient) {
  return getGroupsWithRetry(targetClient, 5, 1500);
}

async function exportGroupContactsForClient(targetClient, targetGroup) {
  const targetJid = (typeof targetGroup === 'string')
    ? targetGroup
    : (targetGroup.groupJid || targetGroup.id || (targetGroup.id && targetGroup.id._serialized ? targetGroup.id._serialized : ''));

  if (!targetJid) {
    throw new Error('Invalid Group JID provided');
  }

  let groupTitle = (targetGroup && targetGroup.name) || 'WhatsApp Group';
  let participantsRaw = [];

  // 1. Primary Pass: Deep In-Browser Store Evaluation with WAWebGroupQueryJob & LID Resolution
  if (targetClient && targetClient.pupPage) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const evalResult = await safeEvaluate(targetClient, async (gJid) => {
          let title = '';

          // Module getters helper
          const getModule = (name) => {
            try { return window.require ? window.require(name) : null; } catch(e) { return null; }
          };

          const widFactory = getModule('WAWebWidFactory');
          let wid = gJid;
          if (widFactory && typeof widFactory.createWid === 'function') {
            try { wid = widFactory.createWid(gJid); } catch(e) {}
          }
          const serializedJid = typeof wid === 'string' ? wid : (wid._serialized || gJid);

          // 1. Direct cache lookup for GroupMetadata
          let groupMeta = null;
          const collections = getModule('WAWebCollections') || window.Store;

          if (collections && collections.GroupMetadata) {
            try {
              if (typeof collections.GroupMetadata.get === 'function') {
                groupMeta = collections.GroupMetadata.get(wid) || collections.GroupMetadata.get(serializedJid);
              }
              if (!groupMeta && typeof collections.GroupMetadata.find === 'function') {
                groupMeta = await collections.GroupMetadata.find(wid) || await collections.GroupMetadata.find(serializedJid);
              }
            } catch(e) {}
          }

          // 2. Query Job fetcher fallback if not cached
          if (!groupMeta || !groupMeta.participants) {
            const groupQueryJob = getModule('WAWebGroupQueryJob');
            if (groupQueryJob && typeof groupQueryJob.queryAndUpdateGroupMetadataById === 'function') {
              try {
                await Promise.race([
                  groupQueryJob.queryAndUpdateGroupMetadataById({ id: serializedJid }),
                  groupQueryJob.queryAndUpdateGroupMetadataById({ id: wid }),
                  groupQueryJob.queryAndUpdateGroupMetadataById(serializedJid),
                  groupQueryJob.queryAndUpdateGroupMetadataById(wid),
                  new Promise(r => setTimeout(r, 4000))
                ]).catch(() => {});
              } catch(e) {}
            }

            // 3. Re-read GroupMetadata after server query
            if (collections && collections.GroupMetadata) {
              try {
                if (typeof collections.GroupMetadata.find === 'function') {
                  groupMeta = await collections.GroupMetadata.find(wid) || await collections.GroupMetadata.find(serializedJid);
                }
                if (!groupMeta && typeof collections.GroupMetadata.get === 'function') {
                  groupMeta = collections.GroupMetadata.get(wid) || collections.GroupMetadata.get(serializedJid);
                }
                if (!groupMeta && (collections.GroupMetadata.models || collections.GroupMetadata._models)) {
                  const models = Array.from(collections.GroupMetadata.models || collections.GroupMetadata._models);
                  const targetUser = serializedJid.split('@')[0];
                  groupMeta = models.find(m => {
                    const mid = m.id ? (typeof m.id === 'string' ? m.id : (m.id._serialized || m.id.user || '')) : '';
                    return mid === serializedJid || (targetUser && mid.includes(targetUser));
                  });
                }
              } catch(e) {}
            }
          }

          // Search Chat Model
          let chatModel = null;
          if (collections && collections.Chat) {
            try {
              chatModel = typeof collections.Chat.get === 'function'
                ? (collections.Chat.get(wid) || collections.Chat.get(serializedJid))
                : null;
              if (!chatModel && (collections.Chat.models || collections.Chat._models)) {
                const models = Array.from(collections.Chat.models || collections.Chat._models);
                chatModel = models.find(m => {
                  const mid = m.id ? (typeof m.id === 'string' ? m.id : (m.id._serialized || m.id.user || '')) : '';
                  return mid === serializedJid || mid.includes(serializedJid) || serializedJid.includes(mid);
                });
              }
            } catch(e) {}
          }

          if (chatModel) {
            title = chatModel.formattedTitle || chatModel.name || chatModel.title || title;
            if (!groupMeta && chatModel.groupMetadata) {
              groupMeta = chatModel.groupMetadata;
            }
          }

          if (groupMeta) {
            title = groupMeta.subject || groupMeta.name || title;
          }

          // Retrieve Participants Collection / Array
          let rawPartsColl = null;
          if (groupMeta) {
            if (groupMeta.participants) {
              rawPartsColl = groupMeta.participants;
            } else if (typeof groupMeta.serialize === 'function') {
              const serialized = groupMeta.serialize();
              if (serialized && serialized.participants) rawPartsColl = serialized.participants;
            }
          }

          if ((!rawPartsColl || rawPartsColl.length === 0) && chatModel) {
            const pColl = (chatModel.groupMetadata && chatModel.groupMetadata.participants) || chatModel.participants;
            if (pColl) rawPartsColl = pColl;
          }

          let partsArray = [];
          if (rawPartsColl) {
            if (Array.isArray(rawPartsColl)) {
              partsArray = rawPartsColl;
            } else if (typeof rawPartsColl.getModelsArray === 'function') {
              partsArray = rawPartsColl.getModelsArray();
            } else if (rawPartsColl.models || rawPartsColl._models) {
              partsArray = Array.from(rawPartsColl.models || rawPartsColl._models);
            } else if (typeof rawPartsColl[Symbol.iterator] === 'function') {
              partsArray = Array.from(rawPartsColl);
            }
          }

          // Helper for LID resolution
          const lidUtils = getModule('WAWebLidMigrationUtils');
          const toPn = (lidUtils && typeof lidUtils.toPn === 'function') ? lidUtils.toPn : (id => id);

          const contactColl = (collections && collections.Contact) ? collections.Contact : null;

          const mappedParticipants = partsArray.map(p => {
            if (!p) return null;

            let pId = p.id;
            let pPn = p.pn || p.pnJid;

            let convertedId = toPn(pId);
            if (convertedId) pId = convertedId;

            const rawId = pId ? (typeof pId === 'string' ? pId : (pId._serialized || pId.user || '')) : '';
            const rawPn = pPn ? (typeof pPn === 'string' ? pPn : (pPn._serialized || pPn.user || '')) : '';

            let extractedPhone = '';
            if (rawPn && (rawPn.endsWith('@c.us') || rawPn.endsWith('@s.whatsapp.net'))) {
              extractedPhone = rawPn.split('@')[0].replace(/[^0-9]/g, '');
            }
            if (!extractedPhone && rawId && (rawId.endsWith('@c.us') || rawId.endsWith('@s.whatsapp.net'))) {
              extractedPhone = rawId.split('@')[0].replace(/[^0-9]/g, '');
            }
            if (!extractedPhone && pId && pId.user && /^\d{7,15}$/.test(pId.user)) {
              extractedPhone = pId.user;
            }

            let cModel = null;
            if (contactColl) {
              try {
                if (typeof contactColl.get === 'function') {
                  cModel = contactColl.get(rawId) || (rawPn ? contactColl.get(rawPn) : null) || (extractedPhone ? contactColl.get(extractedPhone + '@c.us') : null);
                }
                if (!cModel && (contactColl.models || contactColl._models)) {
                  const cArr = Array.from(contactColl.models || contactColl._models);
                  cModel = cArr.find(c => {
                    const cid = c.id ? (typeof c.id === 'string' ? c.id : (c.id._serialized || '')) : '';
                    return cid === rawId || cid === rawPn || (extractedPhone && cid.includes(extractedPhone));
                  });
                }
              } catch(e) {}
            }

            if (!extractedPhone && cModel) {
              if (cModel.phoneNumber) extractedPhone = String(cModel.phoneNumber).replace(/[^0-9]/g, '');
              if (!extractedPhone && cModel.number) extractedPhone = String(cModel.number).replace(/[^0-9]/g, '');
              if (!extractedPhone && cModel.userid) extractedPhone = String(cModel.userid).replace(/[^0-9]/g, '');
            }

            let pushname = p.pushname || p.notifyName || (cModel ? (cModel.pushname || cModel.notifyName) : '') || '';
            let savedName = p.name || p.formattedName || (cModel ? (cModel.name || cModel.formattedName || cModel.displayName || cModel.shortName || cModel.verifiedName) : '') || '';

            const cleanSavedDigits = String(savedName || '').replace(/[^0-9]/g, '');
            if (String(savedName || '').trim().startsWith('+') || (cleanSavedDigits.length >= 10 && cleanSavedDigits.length <= 15 && !/[a-zA-Z]/.test(savedName))) {
              if (!extractedPhone) extractedPhone = cleanSavedDigits;
              savedName = '';
            }

            const cleanPushDigits = String(pushname || '').replace(/[^0-9]/g, '');
            if (String(pushname || '').trim().startsWith('+') || (cleanPushDigits.length >= 10 && cleanPushDigits.length <= 15 && !/[a-zA-Z]/.test(pushname))) {
              if (!extractedPhone) extractedPhone = cleanPushDigits;
              pushname = '';
            }

            let finalName = savedName || (pushname ? ('~' + pushname.replace(/^~/, '')) : '');

            return {
              id: rawId || (extractedPhone ? extractedPhone + '@c.us' : ''),
              user: extractedPhone || (rawId.endsWith('@lid') ? '' : rawId.split('@')[0]),
              phoneNum: extractedPhone,
              isAdmin: Boolean(p.isAdmin || p.isSuperAdmin || p.role === 'admin' || p.role === 'superadmin'),
              name: finalName,
              pushname: pushname,
              savedName: savedName
            };
          }).filter(Boolean);

          return {
            title: title,
            participants: mappedParticipants
          };
        }, targetJid).catch(() => null);

        if (evalResult) {
          if (evalResult.title && evalResult.title !== 'WhatsApp Group') groupTitle = evalResult.title;
          if (evalResult.participants && evalResult.participants.length > 0) {
            participantsRaw = evalResult.participants;
            break;
          }
        }
      } catch(e) {
        console.warn(`[Group Contacts Sync] Attempt ${attempt} evaluation notice:`, e.message);
      }
    }
  }

  // 2. Secondary Pass: Standard whatsapp-web.js API Fallback
  if ((!participantsRaw || participantsRaw.length === 0) && targetClient && targetClient.getChatById) {
    try {
      const chat = await targetClient.getChatById(targetJid).catch(() => null);
      if (chat) {
        if (chat.name) groupTitle = chat.name;

        // Force fetch group metadata if native methods exist
        if (typeof chat.fetchGroupMetadata === 'function') {
          try { await chat.fetchGroupMetadata(); } catch(e) {}
        } else if (chat.groupMetadata && typeof chat.groupMetadata.fetch === 'function') {
          try { await chat.groupMetadata.fetch(); } catch(e) {}
        }

        const partsColl = (chat.groupMetadata && chat.groupMetadata.participants) || chat.participants;
        if (partsColl && partsColl.length > 0) {
          participantsRaw = partsColl.map(p => {
            const pIdObj = p.id || {};
            const sId = typeof pIdObj === 'string' ? pIdObj : (pIdObj._serialized || (pIdObj.user ? pIdObj.user + '@c.us' : ''));
            const userNum = pIdObj.user || (typeof sId === 'string' ? sId.split('@')[0] : '');
            return {
              id: sId,
              user: userNum,
              phoneNum: /^\d{7,15}$/.test(userNum) ? userNum : '',
              isAdmin: Boolean(p.isAdmin || p.isSuperAdmin),
              name: p.name || p.pushname || ''
            };
          });
        }
      }
    } catch(e) {}
  }

  if (!participantsRaw) participantsRaw = [];

  // Fast Node.js Level Contact Enrichment for missing pushnames (Max 30 contacts to stay super fast)
  if (participantsRaw && participantsRaw.length > 0 && targetClient && targetClient.getContactById) {
    try {
      const needy = participantsRaw.filter(p => !p.name || p.name === '~WhatsApp User').slice(0, 30);
      if (needy.length > 0) {
        const enrichPromises = needy.map(async (p) => {
          const pJid = p.id ? (typeof p.id === 'string' ? p.id : (p.id._serialized || '')) : '';
          if (pJid) {
            try {
              const contact = await targetClient.getContactById(pJid).catch(() => null);
              if (contact) {
                const cPush = contact.pushname || contact.notifyName || '';
                const cName = contact.name || contact.shortName || contact.formattedName || '';

                const cleanSaved = String(cName).replace(/[^0-9]/g, '');
                const isSavedPhone = String(cName).trim().startsWith('+') || (cleanSaved.length >= 10 && cleanSaved.length <= 15 && !/[a-zA-Z]/.test(cName));

                const cleanPush = String(cPush).replace(/[^0-9]/g, '');
                const isPushPhone = String(cPush).trim().startsWith('+') || (cleanPush.length >= 10 && cleanPush.length <= 15 && !/[a-zA-Z]/.test(cPush));

                const validSaved = isSavedPhone ? '' : cName;
                const validPush = isPushPhone ? '' : cPush;

                if (validSaved) {
                  p.savedName = validSaved;
                  p.name = validSaved;
                } else if (validPush) {
                  p.pushname = validPush;
                  if (!p.savedName) p.name = '~' + validPush.replace(/^~/, '');
                }
              }
            } catch(e) {}
          }
        });

        await Promise.race([
          Promise.all(enrichPromises),
          new Promise(r => setTimeout(r, 1000))
        ]);
      }
    } catch(e) {}
  }

  const finalRecords = participantsRaw.map((p, idx) => {
    const sId = p.id ? (typeof p.id === 'string' ? p.id : (p.id._serialized || p.id)) : '';
    
    let rawNum = p.phoneNum || p.user || '';
    if (!rawNum && sId && !sId.includes('@lid')) {
      rawNum = typeof sId === 'string' ? sId.split('@')[0] : '';
    }

    if (!p.phoneNum && (sId.includes('@lid') || (rawNum && rawNum.length > 13))) {
      const nameDigits = String(p.name || '').replace(/[^0-9]/g, '');
      if (nameDigits.length >= 10 && nameDigits.length <= 15) {
        rawNum = nameDigits;
      } else {
        rawNum = '';
      }
    }

    const cleanDigits = rawNum.replace(/[^0-9]/g, '');
    const formattedPhone = cleanDigits.length >= 7 ? '+' + cleanDigits : 'N/A';

    const isAdminRole = Boolean(p.isAdmin || p.isSuperAdmin || p.role === 'admin' || p.role === 'superadmin');

    const pushNameStr = (p.pushname || '').replace(/^~/, '').trim();
    const savedNameStr = (p.savedName || '').trim();

    let displayName = p.name || savedNameStr || (pushNameStr ? ('~' + pushNameStr) : '');
    
    if (!displayName || displayName === formattedPhone || displayName === cleanDigits || String(displayName).replace(/[^0-9]/g, '') === cleanDigits) {
      displayName = pushNameStr ? ('~' + pushNameStr) : '~WhatsApp User';
    }

    return {
      index: idx + 1,
      id: sId,
      userJid: sId,
      phone: formattedPhone,
      phoneNumber: formattedPhone,
      name: displayName,
      pushname: pushNameStr || 'N/A',
      savedName: savedNameStr || 'N/A',
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

let client = null;
if (require.main === module) {
  client = createWhatsAppClient('default');
}

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
async function safeEvaluate(targetClient, fn, ...args) {
  let activeClient = targetClient;
  let evaluateFn = fn;
  let evalArgs = args;

  if (typeof targetClient === 'function') {
    evalArgs = [fn, ...args];
    evaluateFn = targetClient;
    activeClient = client;
  }

  if (!activeClient || !activeClient.pupPage || activeClient.pupPage.isClosed()) return null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!activeClient.pupPage || activeClient.pupPage.isClosed()) return null;
      return await activeClient.pupPage.evaluate(evaluateFn, ...evalArgs);
    } catch (err) {
      if (err.message && (err.message.includes('Execution context was destroyed') || err.message.includes('navigating') || err.message.includes('Target closed'))) {
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
  console.log(`⏳ Extracting contacts for group: "${targetGroup.name || 'WhatsApp Group'}"...`);

  const groupJid = targetGroup.groupJid || (targetGroup.id && targetGroup.id._serialized ? targetGroup.id._serialized : targetGroup.userJid);
  console.log(`🔗 Target Group JID: ${groupJid}`);

  const myUserNum = (client && client.info && client.info.wid) ? (client.info.wid.user || client.info.wid._serialized.split('@')[0]) : '';
  console.log(`👤 Logged-in user account: ${myUserNum || 'N/A'}`);

  const { groupName, finalRecords } = await exportGroupContactsForClient(client, targetGroup);

  console.log(`📋 Found ${finalRecords ? finalRecords.length : 0} group contact records.`);

  const safeName = sanitizeFilename(targetGroup.name || groupName);
  const timestamp = Date.now();
  const excelFilename = `whatsapp_${safeName}_contacts_${timestamp}.xlsx`;
  const excelFilePath = path.join(__dirname, excelFilename);

  // Build Excel (.xlsx) Worksheet with Headers & Auto Column Widths
  const excelHeaders = ['PHONE_NUMBER', 'NAME', 'WHATSAPP_PROFILE_NAME', 'IS_ADMIN', 'USER_JID'];
  const excelData = [
    excelHeaders,
    ...finalRecords.map(r => [r.phoneNumber || 'N/A', r.name || 'N/A', r.pushname || 'N/A', r.isAdmin || 'No', r.userJid || ''])
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

  if (client) {
    client.on('auth_failure', msg => {
      console.error('❌ Authentication failed:', msg);
    });

    client.initialize();
  }
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
