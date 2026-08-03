const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const ExcelJS = require('exceljs');
const {
  createWhatsAppClient,
  destroyWhatsAppSession,
  getGroupListForClient,
  fetchUserGroups,
  getGroupsWithRetry,
  exportGroupContactsForClient
} = require('./extractContacts');

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
const MAX_ACTIVE_SESSIONS = parseInt(process.env.MAX_ACTIVE_SESSIONS || '5', 10);
const IDLE_SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes idle cleanup

app.use(express.json());
app.use(express.static(__dirname));

// Persistent Multi-Tenant Session Storage
const activeSessions = new Map();

function getSession(req) {
  const sessionId = req.headers['x-session-id'] || (req.query && req.query.sessionId) || (req.body && req.body.sessionId) || req.headers['x-socket-id'];
  if (sessionId && activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    session.lastActiveTime = Date.now();
    return session;
  }
  if (activeSessions.size > 0) {
    const session = activeSessions.values().next().value;
    session.lastActiveTime = Date.now();
    return session;
  }
  return null;
}

// Socket Connection Listener - Prevents duplicate client initialization & handles reconnects
io.on('connection', (socket) => {
  const sessionId = (socket.handshake.auth && socket.handshake.auth.sessionId) ||
                    (socket.handshake.query && socket.handshake.query.sessionId) ||
                    socket.id;

  console.log(`🔌 Socket connected ID: ${socket.id} (Session ID: ${sessionId})`);

  let sessionObj = activeSessions.get(sessionId);

  if (sessionObj) {
    if (sessionObj.disconnectTimeout) {
      console.log(`⏱️ Cleared 10-minute idle disconnect timer for reconnected session: ${sessionId}`);
      clearTimeout(sessionObj.disconnectTimeout);
      sessionObj.disconnectTimeout = null;
    }
    sessionObj.lastActiveTime = Date.now();
    sessionObj.socket = socket;

    socket.emit('status', {
      status: sessionObj.statusState,
      authenticated: sessionObj.statusState === 'connected',
      userPhone: sessionObj.userPhone
    });

    if (sessionObj.statusState === 'waiting_for_scan' && sessionObj.qrCodeDataUrl) {
      socket.emit('qr', sessionObj.qrCodeDataUrl);
      socket.emit('whatsapp_qr', { qr: sessionObj.qrCodeDataUrl });
    }

    if (sessionObj.statusState === 'connected') {
      socket.emit('ready', { userPhone: sessionObj.userPhone, status: 'ready' });
      socket.emit('whatsapp_ready', { status: 'ready', userPhone: sessionObj.userPhone });
      if (sessionObj.groups && sessionObj.groups.length > 0) {
        socket.emit('groups', sessionObj.groups);
        socket.emit('whatsapp_groups', { groups: sessionObj.groups });
        socket.emit('groups_loaded', { groups: sessionObj.groups });
      }
    }
  } else {
    // RAM Guard: Enforce maximum active session cap
    if (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
      console.warn(`⚠️ [RAM Guard] Max active sessions limit reached (${MAX_ACTIVE_SESSIONS}). Rejecting new session: ${sessionId}`);
      socket.emit('server_busy', {
        message: 'Server resource limit reached. Please try again in a few minutes.'
      });
      return;
    }

    sessionObj = {
      sessionId: sessionId,
      socket: socket,
      client: null,
      groups: [],
      statusState: 'initializing',
      qrCodeDataUrl: null,
      userPhone: '',
      lastActiveTime: Date.now(),
      disconnectTimeout: null,
      isInitializing: true
    };
    activeSessions.set(sessionId, sessionObj);

    console.log(`🚀 Spawning single WhatsApp client for session: ${sessionId}`);
    const client = createWhatsAppClient(sessionId);
    sessionObj.client = client;

    client.on('qr', async (qr) => {
      console.log(`📱 [${sessionId}] New QR code generated!`);
      sessionObj.isInitializing = false;
      sessionObj.qrCodeDataUrl = await QRCode.toDataURL(qr);
      sessionObj.statusState = 'waiting_for_scan';
      sessionObj.lastActiveTime = Date.now();

      if (sessionObj.socket) {
        sessionObj.socket.emit('qr', sessionObj.qrCodeDataUrl);
        sessionObj.socket.emit('whatsapp_qr', { qr: sessionObj.qrCodeDataUrl });
        sessionObj.socket.emit('status', { status: sessionObj.statusState, message: 'Waiting for QR scan...' });
      }
    });

    client.on('authenticated', () => {
      console.log(`🔒 [${sessionId}] Client authenticated!`);
      sessionObj.isInitializing = false;
      sessionObj.statusState = 'authenticating';
      sessionObj.lastActiveTime = Date.now();

      const userPhone = (client.info && client.info.wid) ? client.info.wid.user : '';
      sessionObj.userPhone = userPhone;
      if (sessionObj.socket) {
        sessionObj.socket.emit('authenticated', { status: 'authenticated', userPhone, message: 'Authenticating...' });
        sessionObj.socket.emit('status', { status: sessionObj.statusState, message: 'Authenticating...' });
      }
    });

    client.on('ready', async () => {
      console.log(`🚀 [${sessionId}] WhatsApp Client is authenticated & ready!`);
      sessionObj.isInitializing = false;
      sessionObj.statusState = 'connected';
      sessionObj.qrCodeDataUrl = null;
      sessionObj.lastActiveTime = Date.now();

      const userPhone = (client.info && client.info.wid) ? client.info.wid.user : '';
      sessionObj.userPhone = userPhone;

      if (sessionObj.socket) {
        sessionObj.socket.emit('ready', { userPhone, status: 'ready', message: 'Connected!' });
        sessionObj.socket.emit('whatsapp_ready', { status: 'ready', userPhone });
        sessionObj.socket.emit('status', { status: sessionObj.statusState, userPhone, message: 'Connected!' });
      }

      try {
        sessionObj.groups = await getGroupsWithRetry(client, 5, 3000);
        console.log(`📋 [${sessionId}] IndexedDB Sync complete! Found ${sessionObj.groups.length} group chats.`);
        if (sessionObj.socket) {
          sessionObj.socket.emit('whatsapp_groups', { groups: sessionObj.groups });
          sessionObj.socket.emit('groups', sessionObj.groups);
          sessionObj.socket.emit('groups_loaded', { groups: sessionObj.groups });
        }
      } catch(e) {
        console.warn(`⚠️ [${sessionId}] Error fetching groups on ready:`, e.message);
      }
    });

    client.on('disconnected', async (reason) => {
      console.log(`❌ [${sessionId}] Client disconnected:`, reason);
      sessionObj.statusState = 'disconnected';
      sessionObj.isInitializing = false;
      if (sessionObj.socket) {
        sessionObj.socket.emit('disconnected', { reason, message: 'Session disconnected' });
      }
      if (sessionObj.disconnectTimeout) clearTimeout(sessionObj.disconnectTimeout);

      // Delay 5s before destroying to prevent rapid crash-loops
      setTimeout(async () => {
        await destroyWhatsAppSession(sessionId, client);
        activeSessions.delete(sessionId);
      }, 5000);
    });

    client.on('auth_failure', (msg) => {
      console.error(`❌ [${sessionId}] Auth Failure:`, msg);
      sessionObj.statusState = 'auth_failure';
      sessionObj.isInitializing = false;
      if (sessionObj.socket) {
        sessionObj.socket.emit('status', { status: sessionObj.statusState, message: 'Authentication failed. Please rescan.' });
      }
    });

    client.initialize().catch(err => {
      console.error(`⚠️ [${sessionId}] client.initialize() error:`, err ? (err.message || err) : 'Unknown error');
      sessionObj.isInitializing = false;
    });
  }

  socket.on('disconnect', () => {
    console.log(`🔌 Socket disconnected ID: ${socket.id} (Session ID: ${sessionId}). Starting 10-minute idle timer...`);
    if (sessionObj.socket && sessionObj.socket.id === socket.id) {
      sessionObj.socket = null;
    }

    sessionObj.lastActiveTime = Date.now();

    if (sessionObj.disconnectTimeout) clearTimeout(sessionObj.disconnectTimeout);

    sessionObj.disconnectTimeout = setTimeout(async () => {
      console.log(`🗑️ [Garbage Collector] Session ${sessionId} idle for 10 minutes. Destroying Chrome & purging storage...`);
      await destroyWhatsAppSession(sessionId, sessionObj.client);
      activeSessions.delete(sessionId);
    }, IDLE_SESSION_TIMEOUT_MS);
  });
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ Server Uncaught Exception (safely caught):', err.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Server Unhandled Rejection (safely caught):', reason);
});

// REST API Endpoints
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessionsCount: activeSessions.size,
    maxSessionsAllowed: MAX_ACTIVE_SESSIONS,
    service: 'WhatsApp Contact Extractor Persistent Multi-Tenant Backend',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/status', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(200).json({
      authenticated: false,
      status: 'waiting_for_scan',
      qr: null,
      userPhone: '',
      groupCount: 0
    });
  }
  const userPhone = session.userPhone || (session.client && session.client.info && session.client.info.wid ? session.client.info.wid.user : '');
  res.status(200).json({
    authenticated: session.statusState === 'connected',
    status: session.statusState,
    qr: session.qrCodeDataUrl,
    userPhone,
    groupCount: session.groups ? session.groups.length : 0
  });
});

app.post('/api/reset', async (req, res) => {
  const sessionId = req.headers['x-session-id'] || (req.body && req.body.sessionId) || req.headers['x-socket-id'];
  console.log(`🔄 Session reset API requested for sessionId: ${sessionId}`);

  if (sessionId && activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    if (session.disconnectTimeout) clearTimeout(session.disconnectTimeout);
    await destroyWhatsAppSession(sessionId, session.client);
    activeSessions.delete(sessionId);
  }
  res.json({ success: true, message: 'Session reset. Generating new QR code...' });
});

// 1. GET /api/groups Endpoint - Non-blocking status handler
app.get('/api/groups', async (req, res) => {
  const sessionId = req.headers['x-session-id'] || (req.query && req.query.sessionId) || (req.body && req.body.sessionId) || req.headers['x-socket-id'];

  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Session ID is required.' });
  }

  if (!activeSessions.has(sessionId)) {
    return res.status(404).json({ success: false, authenticated: false, message: 'Session not found. Please scan QR code.' });
  }

  const session = activeSessions.get(sessionId);
  session.lastActiveTime = Date.now();

  if (!session.client || session.statusState !== 'connected') {
    return res.status(200).json({
      success: false,
      loading: true,
      authenticated: session.statusState === 'authenticating',
      status: session.statusState,
      groups: []
    });
  }

  try {
    session.groups = await getGroupsWithRetry(session.client, 3, 2000);
    res.status(200).json({
      success: true,
      loading: false,
      authenticated: true,
      status: 'connected',
      groups: session.groups
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. POST /api/export Endpoint - CSV Export
app.post('/api/export', async (req, res) => {
  const { groupId, groupJid, name, exportAll } = req.body;
  const session = getSession(req);

  if (!session || !session.client || session.statusState !== 'connected') {
    return res.status(401).json({ error: 'WhatsApp is not authenticated. Scan QR code first.' });
  }

  try {
    let recordsToExport = [];

    if (exportAll) {
      const currentGroups = (session.groups && session.groups.length > 0) ? session.groups : await getGroupsWithRetry(session.client, 3, 2000);
      for (const g of currentGroups) {
        try {
          const resData = await exportGroupContactsForClient(session.client, g);
          recordsToExport.push(...resData.finalRecords);
        } catch(e) {}
      }
    } else {
      const targetJid = groupId || groupJid;
      const resData = await exportGroupContactsForClient(session.client, { groupJid: targetJid, name });
      recordsToExport = resData.finalRecords;
    }

    const safeName = exportAll ? 'all_groups' : (recordsToExport[0]?.groupName ? recordsToExport[0].groupName.replace(/[^a-zA-Z0-9_\-]/g, '_') : 'group');
    const filename = `whatsapp_${safeName}_contacts_${Date.now()}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const csvRows = ['#,Name,Phone Number,Role,Group Name'];
    recordsToExport.forEach(r => {
      csvRows.push(`${r.index},"${(r.name || '').replace(/"/g, '""')}","${r.phoneNumber || r.phone}","${r.role}","${(r.groupName || '').replace(/"/g, '""')}"`);
    });

    res.send(csvRows.join('\n'));
  } catch (err) {
    console.error('❌ CSV export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. POST /api/export-excel Endpoint - Excel Export
app.post('/api/export-excel', async (req, res) => {
  const { groupId, groupJid, name, exportAll } = req.body;
  const session = getSession(req);

  if (!session || !session.client || session.statusState !== 'connected') {
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
      { header: 'Role', key: 'role', width: 16 },
      { header: 'Group Name', key: 'groupName', width: 30 }
    ];

    const headerRow = worksheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF128C7E' }
      };
      cell.font = {
        name: 'Arial',
        size: 11,
        bold: true,
        color: { argb: 'FFFFFFFF' }
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
      const currentGroups = (session.groups && session.groups.length > 0) ? session.groups : await getGroupsWithRetry(session.client, 3, 2000);
      for (const g of currentGroups) {
        try {
          const resData = await exportGroupContactsForClient(session.client, g);
          recordsToExport.push(...resData.finalRecords);
        } catch(e) {}
      }
    } else if (targetJid) {
      const resData = await exportGroupContactsForClient(session.client, { groupJid: targetJid, name });
      recordsToExport = resData.finalRecords;
    } else {
      return res.status(400).json({ error: 'Group ID or exportAll: true is required.' });
    }

    recordsToExport.forEach((rec, idx) => {
      const row = worksheet.addRow({
        index: idx + 1,
        name: rec.name,
        phoneNumber: rec.phoneNumber || rec.phone,
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

        if (colNumber === 4 && (rec.role === 'Group Admin' || rec.role === 'Admin')) {
          cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF10B981' } };
        }
      });
    });

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
    console.error('❌ Excel export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// JSON extraction endpoint for in-dashboard table preview
app.post('/api/extract', async (req, res) => {
  const { groupJid, groupId, name } = req.body;
  const targetJid = groupId || groupJid;
  const session = getSession(req);

  if (!session || !session.client || session.statusState !== 'connected') {
    return res.status(401).json({ error: 'WhatsApp is not authenticated. Scan QR code first.' });
  }
  if (!targetJid) {
    return res.status(400).json({ error: 'Group ID is required.' });
  }

  try {
    console.log(`🌐 API Request [Session: ${session.sessionId}]: Extracting contacts for group "${name || targetJid}" (${targetJid})`);
    const result = await exportGroupContactsForClient(session.client, { groupJid: targetJid, name });

    res.json({
      success: true,
      groupName: result.groupName,
      totalMembers: result.finalRecords.length,
      count: result.finalRecords.length,
      contacts: result.finalRecords,
      participants: result.finalRecords
    });
  } catch (err) {
    console.error('❌ Group extraction error:', err);
    res.status(500).json({ error: err.message || 'Failed to extract contacts' });
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
  server.listen(portToTry, '0.0.0.0', () => {
    console.log(`==================================================`);
    console.log(`🚀 Hardened WhatsApp Studio running on 0.0.0.0:${portToTry}`);
    console.log(`🛡️ Single-Client Lock & Session Init Mutex Active`);
    console.log(`==================================================`);
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
