require('./config')
const { Client, serialize } = require('./lib/serialize.js');
const { formatSize, parseFileSize } = require('./lib/function.js');

const { default: makeWASocket, delay, useMultiFileAuthState, fetchLatestWaWebVersion, makeInMemoryStore, jidNormalizedUser, PHONENUMBER_MCC, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const treeKill = require('tree-kill');

const logger = pino({ timestamp: () => `,"time":"${new Date().toJSON()}"` }).child({ class: 'hisoka' });
logger.level = 'fatal';

const usePairingCode = PAIRING_NUMBER;

const store = makeInMemoryStore({ logger });
if (WRITE_STORE === 'true') store.readFromFile(`./sessions/store.json`);

const startSock = async () => {
const { state, saveCreds } = await useMultiFileAuthState(`./sessions`);
const { version, isLatest } = await fetchLatestWaWebVersion();

console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

const hisoka = makeWASocket({
version,
logger,
printQRInTerminal: !usePairingCode,
auth: state,
browser: ['Chrome (Linux)', '', ''],
markOnlineOnConnect: false,
generateHighQualityLinkPreview: true,
syncFullHistory: true,
getMessage
});

store.bind(hisoka.ev);
await Client({ hisoka, store });

// Pairing login
if (usePairingCode && !hisoka.authState.creds.registered) {
let phoneNumber = usePairingCode.replace(/[^0-9]/g, '');

if (!Object.keys(PHONENUMBER_MCC).some(v => phoneNumber.startsWith(v))) throw "Start with your country's WhatsApp code, Example: 62xxx";

await delay(3000);
let code = await hisoka.requestPairingCode(phoneNumber);
console.log(`\x1b[32m${code?.match(/.{1,4}/g)?.join('-') || code}\x1b[39m`);
}

// Connection updates
hisoka.ev.on('connection.update', (update) => {
const { lastDisconnect, connection } = update;
if (connection) {
console.info(`Connection Status: ${connection}`);
}

if (connection === 'close') {
let reason = new Boom(lastDisconnect?.error)?.output.statusCode;

switch (reason) {
case DisconnectReason.badSession:
case DisconnectReason.connectionClosed:
case DisconnectReason.connectionLost:
case DisconnectReason.connectionReplaced:
case DisconnectReason.restartRequired:
console.info("Connection issue, restarting...");
startSock();
break;
case DisconnectReason.loggedOut:
case DisconnectReason.multideviceMismatch:
console.error("Device has logged out or version mismatch, please rescan...");
hisoka.end();
fs.rmSync(`./sessions`, { recursive: true, force: true });
exec("npm run stop:pm2", (err) => {
if (err) return treeKill(process.pid);
});
break;
default:
console.log("Unhandled connection issue.");
process.exit(1);
}
}

if (connection === 'open') {
console.log(`${hisoka.user?.name} has Connected...`);
}
});

// Save session credentials
hisoka.ev.on('creds.update', saveCreds);

// Contacts updates
hisoka.ev.on('contacts.update', (update) => {
for (let contact of update) {
let id = jidNormalizedUser(contact.id);
if (store && store.contacts) store.contacts[id] = { ...(store.contacts?.[id] || {}), ...(contact || {}) };
}
});

// Contacts upsert
hisoka.ev.on('contacts.upsert', (update) => {
for (let contact of update) {
let id = jidNormalizedUser(contact.id);
if (store && store.contacts) store.contacts[id] = { ...(contact || {}), isContact: true };
}
});

// Group updates
hisoka.ev.on('groups.update', (updates) => {
for (const update of updates) {
const id = update.id;
if (store.groupMetadata[id]) {
store.groupMetadata[id] = { ...(store.groupMetadata[id] || {}), ...(update || {}) };
}
}
});

// Group participants updates
hisoka.ev.on('group-participants.update', ({ id, participants, action }) => {
const metadata = store.groupMetadata[id];
if (metadata) {
switch (action) {
case 'add':
case 'revoked_membership_requests':
metadata.participants.push(...participants.map(id => ({ id: jidNormalizedUser(id), admin: null })));
break;
case 'demote':
case 'promote':
for (const participant of metadata.participants) {
let id = jidNormalizedUser(participant.id);
if (participants.includes(id)) {
participant.admin = (action === 'promote' ? 'admin' : null);
}
}
break;
case 'remove':
metadata.participants = metadata.participants.filter(p => !participants.includes(jidNormalizedUser(p.id)));
break;
}
}
});

// Message updates
hisoka.ev.on('messages.upsert', async ({ messages }) => {
if (!messages[0].message) return;
let m = await serialize(hisoka, messages[0], store);

// Metadata to store
if (store.groupMetadata && Object.keys(store.groupMetadata).length === 0) store.groupMetadata = await hisoka.groupFetchAllParticipating();

// Read status messages
if (m.key && !m.key.fromMe && m.key.remoteJid === 'status@broadcast') {
if (m.type === 'protocolMessage' && m.message.protocolMessage.type === 0) return;

const allowedSenders = ["6287816436092@s.whatsapp.net", "6282340049260@s.whatsapp.net", ]; //disini isi nomer yang ingin agar bot tidak otomatis read sw dari list nomor dibawah 
if (allowedSenders.includes(m.key.participant)) { return }

const emojis = ["🔥", "✨", "🤖", "🌟", "🌞", "🎉", "🎊", "😺"];
function getRandomEmoji() {
const randomIndex = Math.floor(Math.random() * emojis.length);
return emojis[randomIndex];
}
 
const randomEmoji = getRandomEmoji();
hisoka.sendMessage("status@broadcast", { 
react: { 
text: randomEmoji, 
key: m.key 
}
}, { 
statusJidList: [m.key.participant] 
});
await hisoka.readMessages([m.key]);
await hisoka.sendMessage(jidNormalizedUser(hisoka.user.id), { text: `Read Story @${m.key.participant.split('@')[0]}`, mentions: [m.key.participant] }, { quoted: m });
}

// Handle messages
if (!mode && !m.isOwner) return;
await ((await import(`./message.js?v=${Date.now()}`)).default(hisoka, store, m))
});

setInterval(async () => {
// Write store
if (WRITE_STORE === 'true') store.writeToFile(`./sessions/store.json`);
}, 10 * 1000); // Every 10 seconds

setInterval(() => {
fs.readdir("./session", (err, files) => {
if (!err) {
files.forEach(file => {
if (/^(pre-key|sender-key|session-|app-state)/.test(file)) {
fs.unlinkSync(`./session/${file}`);
}
});
}
});
}, 60000);

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);
};

// Optional
async function getMessage(key) {
try {
const jid = jidNormalizedUser(key.remoteJid);
const msg = await store.loadMessage(jid, key.id);
return msg?.message || "";
} catch { }
}

startSock();