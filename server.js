const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const ExcelJS = require('exceljs');
const { client, exportGroupContacts } = require('./extractContacts');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

let qrCodeDataUrl = null;
let isAuthenticated = false;
let groupList = [];
let statusState = 'initializing'; // initializing | waiting_for_scan | authenticating | connected | disconnected

// Helper: Fetch all group chats with id, name, memberCount
async function getGroupList() {
  let chats = [];
  try {
    chats = await client.getChats();
  } catch (e) {
    console.warn('⚠️ Standard client.getChats() encountered an issue, executing Store evaluation fallback...');
  }

  if ((!chats || chats.length === 0) && client.pupPage) {
    try {
      chats = await client.pupPage.evaluate(async () => {
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
          const pCount = (c.groupMetadata && c.groupMetadata.participants) ? c.groupMetadata.participants.length : (c.participantsCount || 0);

          return {
            id: serializedId,
            groupJid: serializedId,
            isGroup: isGroupChat,
            name: c.formattedTitle || c.name || c.title || 'Unnamed Group',
            memberCount: pCount
          };
        });
      });
    } catch(e) {}
  }

  return (chats || [])
    .filter(c => Boolean(c.isGroup || (c.id && c.id.server === 'g.us') || (c.id && c.id._serialized && c.id._serialized.endsWith('@g.us')) || (c.groupJid && c.groupJid.endsWith('@g.us'))))
    .map(g => {
      const jid = g.id ? (typeof g.id === 'string' ? g.id : (g.id._serialized || g.groupJid || '')) : (g.groupJid || '');
      const pCount = (g.participants ? g.participants.length : 0) || (g.groupMetadata ? (g.groupMetadata.participants ? g.groupMetadata.participants.length : 0) : 0) || g.memberCount || 0;
      return {
        id: jid,
        name: g.name || g.formattedTitle || 'Unnamed Group',
        memberCount: pCount
      };
    })
    .filter(g => Boolean(g.id && g.id.endsWith('@g.us')));
}

// WhatsApp Client Event Listeners
client.on('qr', async (qr) => {
  console.log('📱 New QR code generated!');
  qrCodeDataUrl = await QRCode.toDataURL(qr);
  isAuthenticated = false;
  statusState = 'waiting_for_scan';

  io.emit('qr', qrCodeDataUrl);
  io.emit('whatsapp_qr', { qr: qrCodeDataUrl });
  io.emit('status', { status: statusState, message: 'Waiting for QR scan...' });
});

client.on('authenticated', () => {
  console.log('🔒 Client authenticated!');
  isAuthenticated = true;
  statusState = 'authenticating';

  const userPhone = (client.info && client.info.wid) ? client.info.wid.user : '';
  io.emit('authenticated', { status: 'authenticated', userPhone, message: 'Authenticating...' });
  io.emit('status', { status: statusState, message: 'Authenticating...' });
});

client.on('ready', async () => {
  console.log('🚀 WhatsApp Client is authenticated & ready!');
  isAuthenticated = true;
  statusState = 'connected';
  qrCodeDataUrl = null;

  const userPhone = (client.info && client.info.wid) ? client.info.wid.user : '';
  io.emit('ready', { userPhone, status: 'ready', message: 'Connected!' });
  io.emit('whatsapp_ready', { status: 'ready', userPhone });
  io.emit('status', { status: statusState, userPhone, message: 'Connected!' });

  try {
    groupList = await getGroupList();
    console.log(`📋 Found ${groupList.length} group chats!`);
    io.emit('whatsapp_groups', { groups: groupList });
    io.emit('groups', groupList);
  } catch(e) {
    console.warn('⚠️ Error fetching groups on ready:', e.message);
  }
});

client.on('disconnected', (reason) => {
  console.log('❌ WhatsApp Client disconnected:', reason);
  isAuthenticated = false;
  statusState = 'disconnected';
  qrCodeDataUrl = null;
  groupList = [];

  io.emit('disconnected', { reason, message: 'Session disconnected' });
  io.emit('status', { status: statusState, message: 'Disconnected' });
});

client.on('auth_failure', (msg) => {
  console.error('❌ Auth Failure:', msg);
  isAuthenticated = false;
  statusState = 'auth_failure';
  io.emit('status', { status: statusState, message: 'Authentication failed. Please rescan.' });
});

// Socket Connection Listener
io.on('connection', (socket) => {
  const userPhone = (client.info && client.info.wid) ? client.info.wid.user : '';
  socket.emit('status', { status: statusState, authenticated: isAuthenticated, userPhone });

  if (qrCodeDataUrl && !isAuthenticated) {
    socket.emit('qr', qrCodeDataUrl);
    socket.emit('whatsapp_qr', { qr: qrCodeDataUrl });
  }

  if (isAuthenticated) {
    socket.emit('ready', { userPhone, status: 'ready' });
    socket.emit('whatsapp_ready', { status: 'ready', userPhone });
    socket.emit('groups', groupList);
    socket.emit('whatsapp_groups', { groups: groupList });
  }
});

// REST API Endpoints
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    authenticated: isAuthenticated,
    service: 'WhatsApp Contact Extractor Backend',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/status', (req, res) => {
  const userPhone = (client.info && client.info.wid) ? client.info.wid.user : '';
  res.json({
    authenticated: isAuthenticated,
    status: statusState,
    qr: qrCodeDataUrl,
    userPhone,
    groupCount: groupList.length
  });
});

// 1. GET /api/groups Endpoint
app.get('/api/groups', async (req, res) => {
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'WhatsApp is not authenticated. Scan QR code first.' });
  }
  try {
    groupList = await getGroupList();
    res.json({ groups: groupList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. POST /api/export Endpoint - Streams downloadable CSV file attachment
app.post('/api/export', async (req, res) => {
  const { groupId, groupJid, name, exportAll } = req.body;
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'WhatsApp is not authenticated. Scan QR code first.' });
  }

  try {
    if (exportAll) {
      console.log(`🌐 API Request: Exporting ALL ${groupList.length} groups...`);
      io.emit('export_progress', { message: `Starting export for all ${groupList.length} groups...`, current: 0, total: groupList.length });

      let allRecords = [];
      const currentGroups = groupList.length > 0 ? groupList : await getGroupList();

      for (let i = 0; i < currentGroups.length; i++) {
        const g = currentGroups[i];
        io.emit('export_progress', { message: `Extracting "${g.name}" (${i + 1}/${currentGroups.length})...`, current: i + 1, total: currentGroups.length });
        const result = await exportGroupContacts({ groupJid: g.id || g.groupJid, name: g.name });
        if (result && result.finalRecords) {
          result.finalRecords.forEach(r => {
            allRecords.push({
              groupName: g.name,
              phoneNumber: r.phoneNumber || 'N/A',
              name: r.name || 'N/A',
              isAdmin: r.isAdmin || 'No',
              userJid: r.userJid || ''
            });
          });
        }
      }

      const timestamp = Date.now();
      const csvFilename = `whatsapp_all_groups_contacts_${timestamp}.csv`;
      const csvFilePath = path.join(__dirname, csvFilename);

      const csvWriter = createCsvWriter({
        path: csvFilePath,
        header: [
          { id: 'groupName', title: 'GROUP_NAME' },
          { id: 'phoneNumber', title: 'PHONE_NUMBER' },
          { id: 'name', title: 'NAME' },
          { id: 'isAdmin', title: 'IS_ADMIN' },
          { id: 'userJid', title: 'USER_JID' }
        ]
      });

      await csvWriter.writeRecords(allRecords);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${csvFilename}"`);
      return res.sendFile(csvFilePath);
    }

    const targetJid = groupId || groupJid;
    if (!targetJid) {
      return res.status(400).json({ error: 'Group ID (groupId or groupJid) is required.' });
    }

    const matchedGroup = groupList.find(g => g.id === targetJid) || { groupJid: targetJid, name: name || 'Group' };
    console.log(`🌐 API Request: Extracting contacts for group "${matchedGroup.name}" (${targetJid})`);
    
    io.emit('export_progress', { message: `Extracting "${matchedGroup.name}"...` });
    const result = await exportGroupContacts({ groupJid: targetJid, name: matchedGroup.name });
    
    const csvFilePath = path.join(__dirname, result.csvFilename);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${result.csvFilename}"`);
    return res.sendFile(csvFilePath);

  } catch (err) {
    console.error('❌ API Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. POST /api/export-excel Endpoint - Streams styled downloadable .xlsx file attachment
app.post('/api/export-excel', async (req, res) => {
  const { groupId, groupJid, name, exportAll } = req.body;
  if (!isAuthenticated) {
    return res.status(401).json({ error: 'WhatsApp is not authenticated. Scan QR code first.' });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'WhatsApp Contact Studio';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Contacts', {
      views: [{ showGridLines: true }]
    });

    worksheet.columns = [
      { header: '#', key: 'index', width: 8 },
      { header: 'Name', key: 'name', width: 28 },
      { header: 'Phone Number', key: 'phoneNumber', width: 22 },
      { header: 'Role', key: 'role', width: 14 },
      { header: 'Group Name', key: 'groupName', width: 30 }
    ];

    // Style Header Row
    const headerRow = worksheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF128C7E' } // WhatsApp Teal Green #128C7E
      };
      cell.font = {
        name: 'Arial',
        size: 11,
        bold: true,
        color: { argb: 'FFFFFFFF' } // White text
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF0D655B' } },
        left: { style: 'thin', color: { argb: 'FF0D655B' } },
        bottom: { style: 'medium', color: { argb: 'FF0D655B' } },
        right: { style: 'thin', color: { argb: 'FF0D655B' } }
      };
    });

    let recordsToExport = [];
    const targetJid = groupId || groupJid;

    if (exportAll) {
      console.log(`🌐 API Request (Excel): Exporting ALL ${groupList.length} groups...`);
      io.emit('export_progress', { message: `Starting Excel export for all ${groupList.length} groups...` });
      const currentGroups = groupList.length > 0 ? groupList : await getGroupList();

      for (let i = 0; i < currentGroups.length; i++) {
        const g = currentGroups[i];
        io.emit('export_progress', { message: `Extracting "${g.name}" (${i + 1}/${currentGroups.length})...`, current: i + 1, total: currentGroups.length });
        const result = await exportGroupContacts({ groupJid: g.id || g.groupJid, name: g.name });
        if (result && result.finalRecords) {
          result.finalRecords.forEach(r => {
            recordsToExport.push({
              name: r.name || 'N/A',
              phoneNumber: r.phoneNumber || 'N/A',
              role: r.isAdmin === 'Yes' ? 'Admin' : 'Member',
              groupName: g.name
            });
          });
        }
      }
    } else if (targetJid) {
      const matchedGroup = groupList.find(g => g.id === targetJid) || { groupJid: targetJid, name: name || 'Group' };
      console.log(`🌐 API Request (Excel): Extracting contacts for group "${matchedGroup.name}" (${targetJid})`);
      io.emit('export_progress', { message: `Extracting "${matchedGroup.name}" for Excel...` });

      const result = await exportGroupContacts({ groupJid: targetJid, name: matchedGroup.name });
      if (result && result.finalRecords) {
        result.finalRecords.forEach(r => {
          recordsToExport.push({
            name: r.name || 'N/A',
            phoneNumber: r.phoneNumber || 'N/A',
            role: r.isAdmin === 'Yes' ? 'Admin' : 'Member',
            groupName: matchedGroup.name
          });
        });
      }
    } else {
      return res.status(400).json({ error: 'Group ID or exportAll: true is required.' });
    }

    // Add Data Rows & Formatting
    recordsToExport.forEach((rec, idx) => {
      const row = worksheet.addRow({
        index: idx + 1,
        name: rec.name,
        phoneNumber: rec.phoneNumber,
        role: rec.role,
        groupName: rec.groupName
      });

      row.height = 22;
      row.eachCell((cell, colNumber) => {
        cell.font = { name: 'Arial', size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: colNumber === 1 || colNumber === 4 ? 'center' : 'left' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };

        if (colNumber === 4 && rec.role === 'Admin') {
          cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF10B981' } };
        }
      });
    });

    // Auto Column Width Calculation
    worksheet.columns.forEach(column => {
      let maxLen = 0;
      column.eachCell({ includeEmpty: true }, cell => {
        const val = cell.value ? String(cell.value) : '';
        if (val.length > maxLen) maxLen = val.length;
      });
      column.width = Math.max(maxLen + 4, 12);
    });

    const safeName = exportAll ? 'all_groups' : (recordsToExport[0]?.groupName ? recordsToExport[0].groupName.replace(/[^a-zA-Z0-9_\-]/g, '_') : 'group');
    const filename = `whatsapp_${safeName}_contacts_${Date.now()}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('❌ API Excel Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// JSON extraction endpoint for internal dashboard rendering
app.post('/api/extract', async (req, res) => {
  const { groupJid, groupId, name } = req.body;
  const targetJid = groupJid || groupId;

  if (!isAuthenticated) {
    return res.status(401).json({ error: 'WhatsApp is not authenticated. Scan QR code first.' });
  }
  if (!targetJid) {
    return res.status(400).json({ error: 'Group JID is required.' });
  }

  try {
    console.log(`🌐 API Request: Extracting contacts for group "${name}" (${targetJid})`);
    const targetGroup = { groupJid: targetJid, name: name || 'Group' };
    const result = await exportGroupContacts(targetGroup);
    
    res.json({
      success: true,
      count: result.finalRecords.length,
      contacts: result.finalRecords,
      excelFilename: result.excelFilename,
      csvFilename: result.csvFilename
    });
  } catch (err) {
    console.error('❌ API Extraction error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(__dirname, filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

function startServer(portToTry) {
  server.listen(portToTry, () => {
    console.log(`==================================================`);
    console.log(`🚀 WhatsApp Contact Studio running on port ${portToTry}`);
    console.log(`🌐 Open http://localhost:${portToTry} to access Web App`);
    console.log(`==================================================`);
    client.initialize();
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ Port ${portToTry} is occupied, trying port ${portToTry + 1}...`);
      startServer(portToTry + 1);
    } else {
      console.error('❌ Server error:', err);
    }
  });
}

startServer(PORT);
