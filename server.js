const express = require('express');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache for fast legacy WebKit access
let sock = null;
let currentQR = null;
let isConnected = false;
let myJID = null;

const chatsMap = {};
const messagesMap = {};

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    auth: state,
    browser: ['iPad Safari', 'WebKit', '9.3.5'],
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        currentQR = await QRCode.toDataURL(qr);
        console.log('[*] New WhatsApp QR code generated.');
      } catch (err) {
        console.error('QR generation error:', err);
      }
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[!] Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      } else {
        console.log('[!] Device logged out. Please re-scan QR.');
        currentQR = null;
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      myJID = sock.user.id;
      console.log('[SUCCESS] WhatsApp connected as:', sock.user.name || sock.user.id);
    }
  });

  // Store incoming & outgoing messages
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify' && m.type !== 'append') return;

    for (const msg of m.messages) {
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;

      const fromMe = msg.key.fromMe || false;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        (msg.message.imageMessage ? '📷 [Photo]' : '') ||
        (msg.message.audioMessage ? '🎵 [Voice Note]' : '') ||
        (msg.message.videoMessage ? '📹 [Video]' : '') ||
        '[Message]';

      const time = Number(msg.messageTimestamp) * 1000 || Date.now();
      const pushName = msg.pushName || jid.split('@')[0];

      if (!chatsMap[jid]) {
        chatsMap[jid] = {
          id: jid,
          name: pushName,
          lastMsg: text,
          time: time,
          unread: 0
        };
      } else {
        chatsMap[jid].lastMsg = text;
        chatsMap[jid].time = time;
        if (!fromMe) chatsMap[jid].unread += 1;
        if (pushName && pushName !== jid.split('@')[0]) chatsMap[jid].name = pushName;
      }

      if (!messagesMap[jid]) messagesMap[jid] = [];
      messagesMap[jid].push({
        id: msg.key.id,
        fromMe: fromMe,
        text: text,
        time: time,
        sender: fromMe ? 'You' : pushName
      });

      // Keep last 100 messages per chat to save RAM
      if (messagesMap[jid].length > 100) {
        messagesMap[jid].shift();
      }
    }
  });
}

// REST API for iPad
app.get('/api/status', (req, res) => {
  res.json({
    connected: isConnected,
    qr: currentQR,
    user: myJID
  });
});

app.get('/api/chats', (req, res) => {
  const list = Object.values(chatsMap).sort((a, b) => b.time - a.time);
  res.json(list);
});

app.get('/api/messages', (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: 'Missing jid parameter' });

  if (chatsMap[jid]) chatsMap[jid].unread = 0;
  res.json(messagesMap[jid] || []);
});

app.post('/api/send', async (req, res) => {
  const { jid, text } = req.body;
  if (!jid || !text) return res.status(400).json({ error: 'Missing jid or text' });
  if (!sock || !isConnected) return res.status(503).json({ error: 'WhatsApp not connected' });

  try {
    const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
    const sent = await sock.sendMessage(formattedJid, { text });

    const time = Date.now();
    if (!messagesMap[formattedJid]) messagesMap[formattedJid] = [];
    messagesMap[formattedJid].push({
      id: sent.key.id,
      fromMe: true,
      text: text,
      time: time,
      sender: 'You'
    });

    if (chatsMap[formattedJid]) {
      chatsMap[formattedJid].lastMsg = text;
      chatsMap[formattedJid].time = time;
    }

    res.json({ success: true, id: sent.key.id });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start Express and Baileys
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`WhatsApp Legacy Bridge listening on port ${PORT}`);
  console.log(`Ready for iPad iOS 9.3.5 connection`);
  console.log(`=======================================================`);
  startWhatsApp().catch((err) => console.error('Baileys startup error:', err));
});
