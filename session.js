// ============================================================
//  session.js — приватный бот-менеджер твоих Telegram-аккаунтов
//  (всё в одном файле)
// ============================================================
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const https = require('https');
const { CustomFile } = require('telegram/client/uploads');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');

// ====== КОНФИГ ======
const BOT_TOKEN = process.env.BOT_TOKEN || '';
if (!BOT_TOKEN) { console.error('❌ Не задан BOT_TOKEN.'); process.exit(1); }

const SECRET_KEY_1 = process.env.SECRET_KEY_1 || '';
const SECRET_KEY_2 = process.env.SECRET_KEY_2 || '';
if (!SECRET_KEY_1 || SECRET_KEY_1.length < 264) { console.error('❌ SECRET_KEY_1 не задан или короче 264 символов.'); process.exit(1); }
if (!SECRET_KEY_2 || SECRET_KEY_2.length < 264) { console.error('❌ SECRET_KEY_2 не задан или короче 264 символов.'); process.exit(1); }

// Твой личный Telegram chat_id — только у него будет доступ к панели бана ключей.
// Узнать свой chat_id можно, например, через @userinfobot.
const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID || 0);

const TG_API_ID = parseInt(process.env.TG_API_ID || '0', 10);
const TG_API_HASH = process.env.TG_API_HASH || '';
if (!TG_API_ID || !TG_API_HASH) { console.error('❌ Не заданы TG_API_ID / TG_API_HASH.'); process.exit(1); }

// ⚠️ Без Persistent Disk на Render файловая система сбрасывается при каждом
// деплое/перезапуске — вместе с ней исчезнут сохранённые session string.
// Render → сервис → Disks → Add Disk (mount path "/data") → DB_PATH=/data/accounts.db
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'accounts.db');

const PORT = process.env.PORT || 10000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
if (!EXTERNAL_URL) { console.error('❌ Не найден RENDER_EXTERNAL_URL или WEBHOOK_URL.'); process.exit(1); }

const TELEGRAM_SERVICE_ID = 777000;

// Подарки за звёзды (ID, название, цена)
const GIFTS = [
    { id: '5170233102089322756', name: '🧸 Мишка', price: 15 },
    { id: '5168103777563050263', name: '🌹 Роза', price: 25 },
    { id: '6028601630662853006', name: '🍾 Шампанское', price: 50 },
    { id: '5170690322832818290', name: '💍 Кольцо', price: 100 }
];

// ====== БОТ / СЕРВЕР ======
const bot = new TelegramBot(BOT_TOKEN, { webHook: false });
console.log('🚀 Приватный бот запущен (webhook)');

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            try { bot.processUpdate(JSON.parse(body)); } catch (e) { console.error('parse error:', e); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
});
server.listen(PORT, async () => {
    console.log(`✅ Сервер на порту ${PORT}`);
    try {
        await bot.setWebHook(`${EXTERNAL_URL}${WEBHOOK_PATH}`);
        console.log('✅ Webhook установлен');
    } catch (e) { console.error('❌ Webhook error:', e); }
});

// ====== БАЗА ДАННЫХ ======
let db;
async function initDb() {
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.exec(`CREATE TABLE IF NOT EXISTS auth (chat_id INTEGER PRIMARY KEY, unlocked_at TEXT)`);
    await db.exec(`CREATE TABLE IF NOT EXISTS banned_key_users (chat_id INTEGER PRIMARY KEY, banned_at TEXT)`);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER, label TEXT, phone TEXT, session_string TEXT,
            active INTEGER DEFAULT 0, added_at TEXT
        )
    `);
    console.log(`✅ БД готова: ${DB_PATH}`);
}
initDb();

async function isUnlocked(chatId) { return !!(await db.get('SELECT chat_id FROM auth WHERE chat_id = ?', chatId)); }
async function unlock(chatId) { await db.run('INSERT OR IGNORE INTO auth (chat_id, unlocked_at) VALUES (?, ?)', chatId, new Date().toISOString()); }
async function isKeyBanned(chatId) { return !!(await db.get('SELECT chat_id FROM banned_key_users WHERE chat_id = ?', chatId)); }
async function banKeyUser(chatId) {
    await db.run('INSERT OR IGNORE INTO banned_key_users (chat_id, banned_at) VALUES (?, ?)', chatId, new Date().toISOString());
    await db.run('DELETE FROM auth WHERE chat_id = ?', chatId); // выкидываем сразу, если был внутри
}
async function unbanKeyUser(chatId) { await db.run('DELETE FROM banned_key_users WHERE chat_id = ?', chatId); }
async function listUnlockedUsers() { return db.all('SELECT chat_id, unlocked_at FROM auth ORDER BY unlocked_at DESC'); }
async function listKeyBannedUsers() { return db.all('SELECT chat_id, banned_at FROM banned_key_users ORDER BY banned_at DESC'); }
async function addAccount(chatId, sessionString, label, phone) {
    await db.run('UPDATE accounts SET active = 0 WHERE chat_id = ?', chatId);
    const res = await db.run(
        'INSERT INTO accounts (chat_id, label, phone, session_string, active, added_at) VALUES (?, ?, ?, ?, 1, ?)',
        chatId, label, phone, sessionString, new Date().toISOString()
    );
    return res.lastID;
}
async function listAccounts(chatId) { return db.all('SELECT * FROM accounts WHERE chat_id = ? ORDER BY id', chatId); }
async function getActiveAccount(chatId) { return db.get('SELECT * FROM accounts WHERE chat_id = ? AND active = 1', chatId); }
async function setActiveAccount(chatId, accountId) {
    await db.run('UPDATE accounts SET active = 0 WHERE chat_id = ?', chatId);
    await db.run('UPDATE accounts SET active = 1 WHERE id = ? AND chat_id = ?', accountId, chatId);
}
async function removeAccount(chatId, accountId) { await db.run('DELETE FROM accounts WHERE id = ? AND chat_id = ?', accountId, chatId); }
async function getAccount(chatId, accountId) { return db.get('SELECT * FROM accounts WHERE id = ? AND chat_id = ?', accountId, chatId); }

// ====== СОСТОЯНИЯ / КЛИЕНТЫ / КЭШИ ======
const awaitingInput = new Map();   // chatId -> { type, ...extra }
const keyStage = new Map();        // chatId -> 0 (ничего) | 1 (первый ключ введён, ждём второй)
const activeClients = new Map();   // chatId -> TelegramClient
const channelsCache = new Map();   // chatId -> [{ entity, title }]
const nftCache = new Map();        // chatId -> [savedGift, ...]
const antiKick = new Map();        // chatId -> { active: bool, sessions: [], password: string|null }
const sessionsCache = new Map();   // chatId -> [Authorization, ...]
const sessionWatch = new Map();    // chatId -> { active: bool, known: Set<string> }

// ====== БЕЗОПАСНОСТЬ: мониторинг новых входов в аккаунт ======
async function pollSessionWatch(chatId) {
    const watch = sessionWatch.get(chatId);
    if (!watch || !watch.active) return;
    const client = await ensureActiveClient(chatId);
    if (client) {
        try {
            const result = await client.invoke(new Api.account.GetAuthorizations());
            for (const a of result.authorizations) {
                const h = String(a.hash);
                if (!watch.known.has(h)) {
                    watch.known.add(h);
                    if (!a.current) {
                        await bot.sendMessage(chatId,
                            `🔔 Новый вход в аккаунт!\n📱 ${a.deviceModel || '—'} / ${a.platform || '—'} ${a.systemVersion || ''}\n🌍 ${a.country || '—'} (IP: ${a.ip || '—'})\n🕐 ${a.dateCreated ? new Date(a.dateCreated * 1000).toLocaleString('ru-RU') : '—'}`,
                            { reply_markup: { inline_keyboard: [[{ text: '🛑 Завершить эту сессию', callback_data: `killhash_${h}` }]] } }
                        );
                    }
                }
            }
        } catch (e) { console.error('pollSessionWatch error:', e.message); }
    }
    if (sessionWatch.get(chatId)?.active) setTimeout(() => pollSessionWatch(chatId), 60000);
}
async function startSessionWatch(chatId) {
    const client = await ensureActiveClient(chatId);
    const watch = { active: true, known: new Set() };
    if (client) {
        try {
            const result = await client.invoke(new Api.account.GetAuthorizations());
            result.authorizations.forEach((a) => watch.known.add(String(a.hash)));
        } catch (e) { console.error('startSessionWatch init error:', e.message); }
    }
    sessionWatch.set(chatId, watch);
    setTimeout(() => pollSessionWatch(chatId), 60000);
}

// ====== АНТИ-КИК: читаем код входа из служебного чата "Telegram" ======
async function waitForLoginCode(existingClient, sinceMessageId, serviceEntity) {
    for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
            const messages = await existingClient.getMessages(serviceEntity, { limit: 3 });
            for (const m of messages) {
                if (m.id > sinceMessageId && m.message) {
                    const match = m.message.match(/\b(\d{5,6})\b/);
                    if (match) return match[1];
                }
            }
        } catch (e) { /* пробуем на следующей итерации */ }
    }
    throw new Error('Код входа не пришёл за 30 секунд');
}

async function antiKickLoop(chatId) {
    const state = antiKick.get(chatId);
    if (!state || !state.active) return;
    const acc = await getActiveAccount(chatId);
    const watcherClient = await ensureActiveClient(chatId);
    if (!acc || !watcherClient) { state.active = false; return; }

    let serviceEntity;
    try { serviceEntity = await watcherClient.getEntity(TELEGRAM_SERVICE_ID); } catch (e) { state.active = false; return; }

    while (state.active) {
        try {
            let sinceId = 0;
            try {
                const last = await watcherClient.getMessages(serviceEntity, { limit: 1 });
                sinceId = last.length ? last[0].id : 0;
            } catch (e) {}

            const newClient = new TelegramClient(new StringSession(''), TG_API_ID, TG_API_HASH, { connectionRetries: 2 });
            await newClient.start({
                phoneNumber: async () => acc.phone,
                phoneCode: async () => waitForLoginCode(watcherClient, sinceId, serviceEntity),
                password: async () => {
                    if (!state.password) throw new Error('Требуется облачный пароль (2FA)');
                    return state.password;
                },
                onError: (err) => console.error('antikick login error:', err.message)
            });
            const newSession = newClient.session.save();
            state.sessions.push(newSession);
            bot.sendMessage(chatId, `🛡 Новая сессия создана (всего: ${state.sessions.length})`).catch(() => {});
            newClient.disconnect().catch(() => {}); // не ждём отключения — сразу следующий круг
        } catch (e) {
            console.error('antiKickLoop error:', e.message);
            if (e.message && e.message.includes('FLOOD_WAIT')) {
                const waitMatch = e.message.match(/(\d+)/);
                const waitSec = waitMatch ? parseInt(waitMatch[1], 10) : 60;
                await bot.sendMessage(chatId, `⏳ Telegram притормозил (FLOOD_WAIT ${waitSec}с) — жду и продолжаю...`);
                await new Promise((r) => setTimeout(r, Math.min(waitSec, 300) * 1000));
            } else {
                await new Promise((r) => setTimeout(r, 2000));
            }
        }
        if (!antiKick.get(chatId)?.active) break;
    }
}

async function connectSession(sessionString) {
    const client = new TelegramClient(new StringSession(sessionString), TG_API_ID, TG_API_HASH, { connectionRetries: 3 });
    await client.connect();
    const me = await client.getMe();
    return { client, me };
}
async function ensureActiveClient(chatId) {
    if (activeClients.has(chatId)) return activeClients.get(chatId);
    const acc = await getActiveAccount(chatId);
    if (!acc) return null;
    try {
        const { client } = await connectSession(acc.session_string);
        activeClients.set(chatId, client);
        return client;
    } catch (e) { console.error('ensureActiveClient error:', e.message); return null; }
}
async function disconnectClient(chatId) {
    const client = activeClients.get(chatId);
    if (client) { try { await client.disconnect(); } catch (e) {} activeClients.delete(chatId); }
}

// ====== ГЛАВНОЕ МЕНЮ ======
async function showMenu(chatId, messageId = null) {
    const acc = await getActiveAccount(chatId);
    if (!acc) {
        const text = '📱 Аккаунт не подключён.\n\nПришли session string, чтобы подключить свой Telegram-аккаунт.';
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
        else await bot.sendMessage(chatId, text);
        awaitingInput.set(chatId, { type: 'awaiting_session' });
        return;
    }
    const text = `📱 Активный аккаунт: ${acc.label}\n\nВыбери раздел:`;
    const keyboard = [
        [{ text: '⭐ Звёзды и подарки', callback_data: 'menu_stars' }],
        [{ text: '👤 Управление аккаунтом', callback_data: 'menu_account' }],
        [{ text: '🛡 Безопасность', callback_data: 'menu_security' }]
    ];
    if (OWNER_CHAT_ID && chatId === OWNER_CHAT_ID) {
        keyboard.push([{ text: '🔑 Панель ключей', callback_data: 'keypanel' }]);
    }
    if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
    else await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}
const backToMenu = { reply_markup: { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] } };
const cancelKeyboard = { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена / В меню', callback_data: 'menu' }]] } };

async function renderKeyPanel(chatId, messageId) {
    const unlockedUsers = await listUnlockedUsers();
    const bannedUsers = await listKeyBannedUsers();
    let text = `🔑 Панель ключей\n\n👥 Вошли по ключу (${unlockedUsers.length}):\n`;
    const keyboard = [];
    unlockedUsers.forEach((u) => {
        const isMe = Number(u.chat_id) === OWNER_CHAT_ID;
        text += `\`${u.chat_id}\`${isMe ? ' (это ты)' : ''} — ${new Date(u.unlocked_at).toLocaleString('ru-RU')}\n`;
        if (!isMe) keyboard.push([{ text: `🚫 Забанить ${u.chat_id}`, callback_data: `keyban_${u.chat_id}` }]);
    });
    if (bannedUsers.length) {
        text += `\n🚫 Забанены (${bannedUsers.length}):\n`;
        bannedUsers.forEach((u) => {
            text += `\`${u.chat_id}\` — ${new Date(u.banned_at).toLocaleString('ru-RU')}\n`;
            keyboard.push([{ text: `✅ Разбанить ${u.chat_id}`, callback_data: `keyunban_${u.chat_id}` }]);
        });
    }
    keyboard.push([{ text: '◀️ Меню', callback_data: 'menu' }]);
    await bot.editMessageText(text.slice(0, 4000), { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
}

async function showStarsMenu(chatId, messageId) {
    const keyboard = [
        [{ text: '⭐ Баланс звёзд и подарки', callback_data: 'stars' }],
        [{ text: '🖼 Мои NFT-подарки', callback_data: 'nft_scan' }, { text: '🎁 Обычные подарки', callback_data: 'regular_gifts_scan' }],
        [{ text: '◀️ Меню', callback_data: 'menu' }]
    ];
    await bot.editMessageText('⭐ Звёзды и подарки:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
}
async function showAccountMenu(chatId, messageId) {
    const keyboard = [
        [{ text: '📨 Написать сообщение', callback_data: 'send_msg' }],
        [{ text: '📥 Сообщения Telegram', callback_data: 'read_messages' }],
        [{ text: '📡 Мои каналы', callback_data: 'my_channels' }, { text: '👥 Контакты', callback_data: 'contacts' }],
        [{ text: '🗑 Удалить чат', callback_data: 'delete_chat_menu' }, { text: '🧬 Клонировать аккаунт', callback_data: 'clone_account' }],
        [{ text: '🔄 Сменить аккаунт', callback_data: 'switch_account' }, { text: '➕ Добавить аккаунт', callback_data: 'add_account' }],
        [{ text: '🚪 Выйти с аккаунта', callback_data: 'logout_account' }, { text: '🗑 Удалить аккаунт', callback_data: 'delete_account' }],
        [{ text: '◀️ Меню', callback_data: 'menu' }]
    ];    await bot.editMessageText('👤 Управление аккаунтом:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
}
async function showSecurityMenu(chatId, messageId) {
    const watch = sessionWatch.get(chatId);
    const monitorLabel = watch && watch.active ? '🔕 Выключить мониторинг входов' : '🔔 Включить мониторинг входов';
    const keyboard = [
        [{ text: '🛡 Анти-кик', callback_data: 'antikick_menu' }],
        [{ text: '🔐 Активные сессии', callback_data: 'sessions_list' }],
        [{ text: monitorLabel, callback_data: 'monitor_toggle' }],
        [{ text: '◀️ Меню', callback_data: 'menu' }]
    ];
    if (messageId) await bot.editMessageText('🛡 Безопасность:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
    else await bot.sendMessage(chatId, '🛡 Безопасность:', { reply_markup: { inline_keyboard: keyboard } });
}

// ====== ТЕКСТОВЫЕ СООБЩЕНИЯ ======
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (await isKeyBanned(chatId)) return; // забаненный по ключу — полная тишина, даже если знает ключи

    // ---- фото для клонирования/смены аватарки (обрабатываем до проверки на текст) ----
    if (msg.photo && (await isUnlocked(chatId))) {
        const state = awaitingInput.get(chatId);
        if (state && state.type === 'awaiting_clone_input') {
            awaitingInput.delete(chatId);
            const client = await ensureActiveClient(chatId);
            if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
            const wait = await bot.sendMessage(chatId, '⏳ Устанавливаю аватарку...');
            try {
                const photo = msg.photo[msg.photo.length - 1];
                const fileUrl = await bot.getFileLink(photo.file_id);
                const buffer = await downloadBuffer(fileUrl);
                await setProfilePhotoFromBuffer(client, buffer);
                await bot.editMessageText('✅ Аватарка обновлена.', { chat_id: chatId, message_id: wait.message_id });
            } catch (e) {
                console.error('set avatar error:', e.message);
                await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: wait.message_id });
            }
            return;
        }
    }

    if (!msg.text) return;

    const unlocked = await isUnlocked(chatId);
    if (!unlocked) {
        const stage = keyStage.get(chatId) || 0;
        if (stage === 0) {
            if (msg.text.trim() === SECRET_KEY_1) {
                keyStage.set(chatId, 1);
                await bot.sendMessage(chatId, '🔓 Первый ключ принят. Введи второй ключ.');
            }
            return; // неверный/отсутствующий первый ключ — полная тишина
        }
        if (stage === 1) {
            if (msg.text.trim() === SECRET_KEY_2) {
                keyStage.delete(chatId);
                await unlock(chatId);
                awaitingInput.set(chatId, { type: 'awaiting_session' });
                await bot.sendMessage(chatId, '🔓 Ключ принят полностью.\n\nПришли session string аккаунта, который хочешь подключить.');
            }
            // неверный второй ключ — остаёмся на этом же шаге, тишина
            return;
        }
        return;
    }

    if (msg.text === '/start') { if (!awaitingInput.has(chatId)) await showMenu(chatId); return; }

    const state = awaitingInput.get(chatId);
    if (!state) return;

    // ---- подключение аккаунта ----
    if (state.type === 'awaiting_session') {
        const sessionString = msg.text.trim();
        const wait = await bot.sendMessage(chatId, '⏳ Проверяю session string...');
        try {
            const { client, me } = await connectSession(sessionString);
            const label = me.username ? `@${me.username}` : (me.phone ? `+${me.phone}` : `ID ${me.id}`);
            await addAccount(chatId, sessionString, label, me.phone || null);
            activeClients.set(chatId, client);
            awaitingInput.delete(chatId);
            await bot.editMessageText(`✅ Аккаунт подключён: ${label}`, { chat_id: chatId, message_id: wait.message_id });
            await showMenu(chatId);
        } catch (e) {
            console.error('session validate error:', e.message);
            await bot.editMessageText('❌ Session string невалидна или истекла. Пришли другую.', { chat_id: chatId, message_id: wait.message_id });
        }
        return;
    }

    // ---- отправка сообщения: шаг 1 — получатели ----
    if (state.type === 'awaiting_send_recipients') {
        const recipients = msg.text.split(/\s+/).map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
        if (!recipients.length) { await bot.sendMessage(chatId, '❌ Укажи хотя бы один юзернейм.'); return; }
        awaitingInput.set(chatId, { type: 'awaiting_send_text', recipients });
        await bot.sendMessage(chatId, `✍️ Кому: ${recipients.map((r) => '@' + r).join(', ')}\n\nТеперь пришли текст сообщения:`);
        return;
    }
    // ---- отправка сообщения: шаг 2 — текст ----
    if (state.type === 'awaiting_send_text') {
        awaitingInput.delete(chatId);
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        let sent = [], failed = [];
        for (const r of state.recipients) {
            try { await client.sendMessage(r, { message: msg.text }); sent.push(r); }
            catch (e) { failed.push(`${r} (${e.message})`); }
        }
        let text = sent.length ? `✅ Отправлено: ${sent.map((s) => '@' + s).join(', ')}` : '';
        if (failed.length) text += `\n❌ Не удалось: ${failed.join(', ')}`;
        await bot.sendMessage(chatId, text || 'Ничего не отправлено.', backToMenu);
        return;
    }

    // ---- подтверждение удаления аккаунта ----
    if (state.type === 'awaiting_delete_confirm') {
        awaitingInput.delete(chatId);
        if (msg.text.trim() !== state.phrase) { await bot.sendMessage(chatId, '❌ Фраза не совпала — удаление отменено.'); return; }
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            await client.invoke(new Api.account.DeleteAccount({ reason: 'Requested via personal management bot' }));
            await disconnectClient(chatId);
            await removeAccount(chatId, state.accountId);
            await bot.sendMessage(chatId, '🗑 Аккаунт удалён навсегда.');
            await showMenu(chatId);
        } catch (e) {
            console.error('delete account error:', e.message);
            await bot.sendMessage(chatId, `❌ Не удалось удалить аккаунт: ${e.message}`);
        }
        return;
    }

    // ---- подарок: получатель ----
    if (state.type === 'awaiting_gift_recipient') {
        awaitingInput.delete(chatId);
        const target = msg.text.trim().replace(/^@/, '');
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        const wait = await bot.sendMessage(chatId, '⏳ Отправляю подарок...');
        try {
            const inputPeer = await client.getInputEntity(target);
            const invoice = new Api.InputInvoiceStarGift({ peer: inputPeer, giftId: BigInt(state.giftId) });
            const form = await client.invoke(new Api.payments.GetPaymentForm({ invoice }));
            await client.invoke(new Api.payments.SendStarsForm({ formId: form.formId, invoice }));
            await bot.editMessageText(`🎁 Подарок "${state.giftName}" отправлен пользователю @${target}!`, { chat_id: chatId, message_id: wait.message_id });
        } catch (e) {
            console.error('send gift error:', e.message);
            await bot.editMessageText(friendlyGiftError(e).replace('❌ ', '❌ Не удалось отправить подарок: '), { chat_id: chatId, message_id: wait.message_id });
        }
        return;
    }

    // ---- перевод NFT-подарка(ов) ----
    if (state.type === 'awaiting_nft_recipient') {
        awaitingInput.delete(chatId);
        const target = msg.text.trim().replace(/^@/, '');
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        const cachedList = nftCache.get(chatId) || [];
        const toSend = state.mode === 'all'
            ? cachedList.filter((sg) => sg.gift.className === 'StarGiftUnique')
            : [cachedList[state.giftIdx]].filter(Boolean);
        if (!toSend.length) { await bot.sendMessage(chatId, '❌ Нечего отправлять — открой список заново.', backToMenu); return; }
        try {
            const inputUser = await client.getInputEntity(target);
            let ok = 0;
            const failReasons = [];
            for (const sg of toSend) {
                try {
                    const inputSaved = new Api.InputSavedStarGiftUser({ msgId: sg.msgId });
                    await client.invoke(new Api.payments.TransferStarGift({ stargift: inputSaved, toId: inputUser }));
                    ok++;
                } catch (e) { console.error('transfer nft error:', e.message); failReasons.push(friendlyGiftError(e)); }
            }
            let resultText = `✅ Отправлено: ${ok}`;
            if (failReasons.length) resultText += `\n\n${[...new Set(failReasons)].join('\n')}`;
            await bot.sendMessage(chatId, resultText, backToMenu);
        } catch (e) {
            console.error('nft transfer outer error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`, backToMenu);
        }
        return;
    }

    // ---- выставление NFT на продажу за звёзды ----
    if (state.type === 'awaiting_nft_sell_price') {
        awaitingInput.delete(chatId);
        const price = parseInt(msg.text.trim(), 10);
        if (isNaN(price) || price <= 0) { await bot.sendMessage(chatId, '❌ Введи целое число звёзд, например 500.'); return; }
        const sg = (nftCache.get(chatId) || [])[state.giftIdx];
        if (!sg) { await bot.sendMessage(chatId, '❌ Подарок не найден, открой список заново.', backToMenu); return; }
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            await listGiftForResale(client, sg, price);
            await bot.sendMessage(chatId, `✅ NFT выставлен на продажу за ${price}⭐`, backToMenu);
        } catch (e) {
            console.error('list nft for resale error:', e.message);
            await bot.sendMessage(chatId, friendlyGiftError(e), backToMenu);
        }
        return;
    }

    // ---- назначение админа канала ----
    if (state.type === 'awaiting_channel_admin_target') {
        awaitingInput.delete(chatId);
        const target = msg.text.trim().replace(/^@/, '');
        const client = await ensureActiveClient(chatId);
        const cached = (channelsCache.get(chatId) || [])[state.channelIdx];
        if (!client || !cached) { await bot.sendMessage(chatId, '❌ Канал не найден, открой список заново.'); return; }
        try {
            const user = await client.getInputEntity(target);
            await client.invoke(new Api.channels.EditAdmin({
                channel: cached.entity,
                userId: user,
                adminRights: new Api.ChatAdminRights({
                    changeInfo: true, postMessages: true, editMessages: true, deleteMessages: true,
                    banUsers: true, inviteUsers: true, pinMessages: true, manageCall: true, other: true,
                    addAdmins: true, anonymous: false, manageTopics: true,
                    postStories: true, editStories: true, deleteStories: true
                }),
                rank: 'Admin'
            }));
            await bot.sendMessage(chatId, `✅ @${target} назначен администратором в "${cached.title}"`, backToMenu);
        } catch (e) {
            console.error('promote admin error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`, backToMenu);
        }
        return;
    }

    // ---- передача владения каналом: шаг 1 — получатель ----
    if (state.type === 'awaiting_channel_transfer_target') {
        const target = msg.text.trim().replace(/^@/, '');
        const client = await ensureActiveClient(chatId);
        const cached = (channelsCache.get(chatId) || [])[state.channelIdx];
        if (!client || !cached) { await bot.sendMessage(chatId, '❌ Канал не найден, открой список заново.', cancelKeyboard); return; }

        let pwdInfo;
        try { pwdInfo = await client.invoke(new Api.account.GetPassword()); } catch (e) {}

        if (!pwdInfo || !pwdInfo.hasPassword) {
            // 2FA не установлен — передаём владение без пароля
            const wait = await bot.sendMessage(chatId, '⏳ 2FA не найден на аккаунте, передаю владение без пароля...');
            try {
                const user = await client.getInputEntity(target);
                await client.invoke(new Api.channels.EditCreator({ channel: cached.entity, userId: user, password: new Api.InputCheckPasswordEmpty() }));
                await bot.editMessageText(`✅ Владение "${cached.title}" передано @${target}`, { chat_id: chatId, message_id: wait.message_id });
            } catch (e) {
                console.error('transfer ownership (no 2fa) error:', e.message);
                await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: wait.message_id });
            }
            return;
        }

        awaitingInput.set(chatId, { type: 'awaiting_channel_transfer_password', channelIdx: state.channelIdx, target });
        await bot.sendMessage(chatId, '🔐 Для передачи владения Telegram требует твой облачный пароль (2FA). Введи его:', cancelKeyboard);
        return;
    }
    // ---- передача владения каналом: шаг 2 — пароль 2FA ----
    if (state.type === 'awaiting_channel_transfer_password') {
        awaitingInput.delete(chatId);
        const client = await ensureActiveClient(chatId);
        const cached = (channelsCache.get(chatId) || [])[state.channelIdx];
        // удаляем сообщение с паролем из чата ради безопасности
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
        if (!client || !cached) { await bot.sendMessage(chatId, '❌ Канал не найден, открой список заново.'); return; }
        const wait = await bot.sendMessage(chatId, '⏳ Передаю права владельца...');
        try {
            const user = await client.getInputEntity(state.target);
            const pwdInfo = await client.invoke(new Api.account.GetPassword());
            const check = await computeCheck(pwdInfo, msg.text);
            await client.invoke(new Api.channels.EditCreator({ channel: cached.entity, userId: user, password: check }));
            await bot.editMessageText(`✅ Владение "${cached.title}" передано @${state.target}`, { chat_id: chatId, message_id: wait.message_id });
        } catch (e) {
            console.error('transfer ownership error:', e.message);
            let text = `❌ Ошибка: ${e.message}`;
            if (e.message.includes('PASSWORD_TOO_FRESH')) {
                text = '❌ Telegram блокирует передачу владения на несколько дней после установки/смены облачного пароля (мера защиты от угона). Попробуй позже.';
            }
            await bot.editMessageText(text, { chat_id: chatId, message_id: wait.message_id });
        }
        return;
    }

    // ---- удаление одного чата ----
    if (state.type === 'awaiting_delete_chat_target') {
        awaitingInput.delete(chatId);
        const target = msg.text.trim();
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            const entity = await client.getEntity(target.replace(/^@/, ''));
            await deleteSingleChat(client, entity);
            await bot.sendMessage(chatId, '✅ Чат удалён.', backToMenu);
        } catch (e) {
            console.error('delete single chat error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`, backToMenu);
        }
        return;
    }

    // ---- клонирование профиля (юзернейм/ID) ----
    if (state.type === 'awaiting_clone_input') {
        awaitingInput.delete(chatId);
        const target = msg.text.trim().replace(/^@/, '');
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        const wait = await bot.sendMessage(chatId, '⏳ Клонирую профиль...');
        try {
            const entity = await client.getEntity(target);
            let about = '';
            try {
                const full = await client.invoke(new Api.users.GetFullUser({ id: entity }));
                about = full.fullUser?.about || '';
            } catch (e) {}
            await client.invoke(new Api.account.UpdateProfile({
                firstName: entity.firstName || '',
                lastName: entity.lastName || '',                about
            }));
            try {
                const buffer = await client.downloadProfilePhoto(entity, { isBig: true });
                if (buffer && buffer.length) await setProfilePhotoFromBuffer(client, buffer);
            } catch (e) { console.error('clone avatar error:', e.message); }
            await bot.editMessageText(`✅ Профиль склонирован с @${target} (имя, фамилия, био, аватарка). Юзернейм остался прежним.`, { chat_id: chatId, message_id: wait.message_id });
        } catch (e) {
            console.error('clone profile error:', e.message);
            await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: wait.message_id });
        }
        return;
    }

    // ---- анти-кик: запуск после ввода пароля ----
    if (state.type === 'awaiting_antikick_password') {
        awaitingInput.delete(chatId);
        const password = msg.text.trim();
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {} // убираем пароль из чата
        antiKick.set(chatId, { active: true, sessions: [], password: password === '-' ? null : password });
        await bot.sendMessage(chatId, '🛡 Анти-кик запущен. Бот будет создавать новые сессии в фоне. Нажми "🛡 Анти-кик" в меню в любой момент, чтобы остановить.');
        antiKickLoop(chatId); // работает в фоне, не блокирует бота
        return;
    }
});

// ====== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ======
function downloadBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}
async function setProfilePhotoFromBuffer(client, buffer) {
    const file = new CustomFile('avatar.jpg', buffer.length, '', buffer);
    const uploaded = await client.uploadFile({ file, workers: 1 });
    await client.invoke(new Api.photos.UploadProfilePhoto({ file: uploaded }));
}

// Обычные подарки можно вернуть звёздами только в течение окна после получения.
// Точный срок Telegram не публикует прямо — по наблюдениям это около 90 дней,
// если API откажет раньше — ориентируйся на реальный текст ошибки.
const REGULAR_GIFT_CONVERT_WINDOW_DAYS = 90;
function isGiftConvertible(sg) {
    if (!sg.date) return true;
    const ageDays = (Date.now() / 1000 - sg.date) / 86400;
    return ageDays <= REGULAR_GIFT_CONVERT_WINDOW_DAYS;
}
async function convertGiftToStars(client, sg) {
    const inputSaved = new Api.InputSavedStarGiftUser({ msgId: sg.msgId });
    await client.invoke(new Api.payments.ConvertStarGift({ stargift: inputSaved }));
}

// Кулдаун на передачу/продажу NFT-подарка после получения (обычно пара недель).
// Поле для точного момента готовности Telegram не документирует стабильно —
// если увидишь ошибку про запрет передачи, пришли текст, поправим проверку.
function nftCooldownRemainingSec(sg) {
    const readyAt = sg.canExportAt || sg.canTransferAt || null;
    if (!readyAt) return 0;
    const remaining = readyAt - Math.floor(Date.now() / 1000);
    return remaining > 0 ? remaining : 0;
}
function friendlyGiftError(e) {
    const m = e.message || '';
    if (m.includes('BALANCE_TOO_LOW')) return '❌ Не хватает звёзд на балансе для оплаты комиссии за передачу/продажу. Пополни баланс и попробуй снова.';
    if (m.includes('STARGIFT_TRANSFER_TOO_EARLY') || m.includes('TOO_EARLY')) return '❌ Ещё действует кулдаун на передачу этого подарка — попробуй позже (см. кнопку "⏳ Кулдаун").';
    if (m.includes('STARGIFT_CONVERT_TOO_OLD')) return '❌ Подарок получен слишком давно — конвертация в звёзды для него больше недоступна.';
    return `❌ Ошибка: ${m}`;
}

function formatDuration(sec) {
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    if (days > 0) return `${days} дн. ${hours} ч.`;
    const mins = Math.floor((sec % 3600) / 60);
    return `${hours} ч. ${mins} мин.`;
}
async function listGiftForResale(client, sg, priceStars) {
    const inputSaved = new Api.InputSavedStarGiftUser({ msgId: sg.msgId });
    await client.invoke(new Api.payments.UpdateStarGiftPrice({ stargift: inputSaved, price: priceStars }));
}

async function deleteSingleChat(client, entity) {
    if (entity.className === 'Channel') {
        await client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
    } else if (entity.className === 'Chat') {
        await client.invoke(new Api.messages.DeleteHistory({ peer: entity, maxId: 0, revoke: true }));
    } else {
        await client.invoke(new Api.messages.DeleteHistory({ peer: entity, maxId: 0, revoke: true }));
    }
}

// ====== CALLBACK-КНОПКИ ======
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    await bot.answerCallbackQuery(query.id);

    if (await isKeyBanned(chatId)) return;
    if (!(await isUnlocked(chatId))) return;

    if (data === 'menu') { awaitingInput.delete(chatId); await showMenu(chatId, messageId); return; }
    if (data === 'menu_stars') { await showStarsMenu(chatId, messageId); return; }
    if (data === 'menu_account') { await showAccountMenu(chatId, messageId); return; }
    if (data === 'menu_security') { await showSecurityMenu(chatId, messageId); return; }

    // ---- панель ключей (только владелец) ----
    if (data === 'keypanel') {
        if (!OWNER_CHAT_ID || chatId !== OWNER_CHAT_ID) return;
        await renderKeyPanel(chatId, messageId);
        return;
    }
    if (data.startsWith('keyban_')) {
        if (!OWNER_CHAT_ID || chatId !== OWNER_CHAT_ID) return;
        const targetId = parseInt(data.split('_')[1], 10);
        await banKeyUser(targetId);
        await bot.answerCallbackQuery(query.id, { text: `🚫 ${targetId} забанен по ключу` });
        await renderKeyPanel(chatId, messageId);
        return;
    }
    if (data.startsWith('keyunban_')) {
        if (!OWNER_CHAT_ID || chatId !== OWNER_CHAT_ID) return;
        const targetId = parseInt(data.split('_')[1], 10);
        await unbanKeyUser(targetId);
        await bot.answerCallbackQuery(query.id, { text: `✅ ${targetId} разбанен` });
        await renderKeyPanel(chatId, messageId);
        return;
    }

    if (data === 'add_account') {
        awaitingInput.set(chatId, { type: 'awaiting_session' });
        await bot.editMessageText('✍️ Пришли session string нового аккаунта:', { chat_id: chatId, message_id: messageId });
        return;
    }

    if (data === 'switch_account') {
        const accounts = await listAccounts(chatId);
        if (!accounts.length) { await bot.editMessageText('Нет сохранённых аккаунтов.', { chat_id: chatId, message_id: messageId, ...backToMenu }); return; }
        const keyboard = accounts.map((a) => [{ text: `${a.active ? '✅ ' : ''}${a.label}`, callback_data: `switchto_${a.id}` }]);
        keyboard.push([{ text: '◀️ Меню', callback_data: 'menu' }]);
        await bot.editMessageText('📋 Твои аккаунты:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
        return;
    }
    if (data.startsWith('switchto_')) {
        const accountId = parseInt(data.split('_')[1], 10);
        const acc = await getAccount(chatId, accountId);
        if (!acc) return;
        await disconnectClient(chatId);
        await setActiveAccount(chatId, accountId);
        try {
            const { client } = await connectSession(acc.session_string);
            activeClients.set(chatId, client);
            await bot.editMessageText(`✅ Переключился на: ${acc.label}`, { chat_id: chatId, message_id: messageId });
            await showMenu(chatId);
        } catch (e) {
            await bot.editMessageText(`❌ Не удалось подключиться: ${e.message}`, { chat_id: chatId, message_id: messageId });
        }
        return;
    }

    if (data === 'logout_account') {
        const acc = await getActiveAccount(chatId);
        if (!acc) { await showMenu(chatId, messageId); return; }
        await bot.editMessageText(`🚪 Выйти из ${acc.label}? Понадобится новый session string, чтобы зайти снова.`, {
            chat_id: chatId, message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '✅ Да, выйти', callback_data: `logoutconfirm_${acc.id}` }, { text: '❌ Отмена', callback_data: 'menu' }]] }
        });
        return;
    }
    if (data.startsWith('logoutconfirm_')) {
        const accountId = parseInt(data.split('_')[1], 10);
        const client = await ensureActiveClient(chatId);
        try { if (client) await client.invoke(new Api.auth.LogOut()); } catch (e) { console.error('logout error:', e.message); }
        await disconnectClient(chatId);
        await removeAccount(chatId, accountId);
        await bot.editMessageText('✅ Вышел из аккаунта.', { chat_id: chatId, message_id: messageId });
        await showMenu(chatId);
        return;
    }

    if (data === 'delete_account') {
        const acc = await getActiveAccount(chatId);
        if (!acc) { await showMenu(chatId, messageId); return; }
        const phrase = `УДАЛИТЬ ${acc.label}`;
        awaitingInput.set(chatId, { type: 'awaiting_delete_confirm', accountId: acc.id, phrase });
        await bot.editMessageText(
            `⚠️ Это НАВСЕГДА удалит аккаунт ${acc.label} из Telegram. Отменить нельзя.\n\nЧтобы подтвердить, отправь текстом ровно:\n\`${phrase}\``,
            { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
        );
        return;
    }

    // ---- отправка сообщения (шаг 1 из кнопки) ----
    if (data === 'send_msg') {
        awaitingInput.set(chatId, { type: 'awaiting_send_recipients' });
        await bot.editMessageText('✍️ Кому отправить? Пришли один юзернейм или несколько через пробел (@юз1 @юз2):', { chat_id: chatId, message_id: messageId });
        return;
    }

    // ---- сообщения только из Telegram (777000), последние 10 ----
    if (data === 'read_messages') {
        await bot.editMessageText('⏳ Загружаю сообщения из Telegram...', { chat_id: chatId, message_id: messageId });
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            const entity = await client.getEntity(TELEGRAM_SERVICE_ID);
            const messages = await client.getMessages(entity, { limit: 10 });
            let text = `💬 Telegram (последние ${messages.length}):\n\n`;
            if (!messages.length) text += '— пусто —';
            else {
                messages.reverse().forEach((m) => {
                    const body = (m.message || '[медиа/без текста]').slice(0, 300);
                    const time = m.date ? new Date(m.date * 1000).toLocaleString('ru-RU') : '';
                    text += `[${time}] ${body}\n\n`;
                });
            }
            await bot.sendMessage(chatId, text.slice(0, 4000), backToMenu);
        } catch (e) {
            console.error('read_messages error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
        return;
    }

    // ---- баланс звёзд + подарки ----
    if (data === 'stars') {
        await bot.editMessageText('⏳ Проверяю баланс...', { chat_id: chatId, message_id: messageId });
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            const status = await client.invoke(new Api.payments.GetStarsStatus({ peer: new Api.InputPeerSelf() }));
            const balance = status.balance?.amount ?? status.balance ?? 0;
            let text = `⭐ Баланс звёзд: ${balance}\n\n🎁 Выбери подарок для отправки:`;
            const keyboard = GIFTS.map((g) => [{ text: `${g.name} — ${g.price}⭐`, callback_data: `gift_${g.id}` }]);
            keyboard.push([{ text: '◀️ Меню', callback_data: 'menu' }]);
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
        } catch (e) {
            console.error('stars balance error:', e.message);
            await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: messageId, ...backToMenu });
        }
        return;
    }
    if (data.startsWith('gift_')) {
        const giftId = data.slice(5);
        const gift = GIFTS.find((g) => g.id === giftId);
        if (!gift) return;
        awaitingInput.set(chatId, { type: 'awaiting_gift_recipient', giftId: gift.id, giftName: gift.name });
        await bot.editMessageText(`✍️ Кому отправить ${gift.name} (${gift.price}⭐)? Напиши юзернейм:`, { chat_id: chatId, message_id: messageId });
        return;
    }

    // ---- скан NFT/коллекционных подарков в профиле ----
    if (data === 'nft_scan') {
        await bot.editMessageText('⏳ Сканирую NFT-подарки в профиле...', { chat_id: chatId, message_id: messageId });
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            const result = await client.invoke(new Api.payments.GetSavedStarGifts({ peer: new Api.InputPeerSelf(), offset: '', limit: 100 }));
            const gifts = result.gifts || [];
            nftCache.set(chatId, gifts);
            const uniqueIdx = [];
            gifts.forEach((sg, i) => { if (sg.gift.className === 'StarGiftUnique') uniqueIdx.push(i); });
            if (!uniqueIdx.length) { await bot.sendMessage(chatId, 'NFT-подарков (уникальных) в профиле не найдено.', backToMenu); return; }
            let text = `🖼 NFT-подарки (${uniqueIdx.length}):\n\n`;
            const keyboard = [];
            uniqueIdx.forEach((i) => {
                const sg = gifts[i];
                const g = sg.gift;
                const name = g.title || 'NFT-подарок';
                text += `${i + 1}. ${name}\nID: ${g.id}${g.slug ? `\n🔗 https://t.me/nft/${g.slug}` : ''}\n\n`;
                keyboard.push([
                    { text: `📤 ${name}`, callback_data: `nftsend_${i}` },
                    { text: '💰 Продать', callback_data: `nftsell_${i}` },
                    { text: '⏳ Кулдаун', callback_data: `nftcooldown_${i}` }
                ]);
            });
            keyboard.push([{ text: '📤 Отправить ВСЕ NFT одному юзеру', callback_data: 'nftsendall' }]);
            keyboard.push([{ text: '◀️ Меню', callback_data: 'menu' }]);
            await bot.sendMessage(chatId, text.slice(0, 4000), { reply_markup: { inline_keyboard: keyboard } });
        } catch (e) {
            console.error('nft_scan error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
        return;
    }
    if (data.startsWith('nftsend_')) {
        const idx = parseInt(data.split('_')[1], 10);
        const cached = (nftCache.get(chatId) || [])[idx];
        if (!cached) return;
        awaitingInput.set(chatId, { type: 'awaiting_nft_recipient', mode: 'one', giftIdx: idx });
        await bot.editMessageText('✍️ Кому отправить этот подарок? Напиши юзернейм:', { chat_id: chatId, message_id: messageId, ...cancelKeyboard });
        return;
    }
    if (data === 'nftsendall') {
        awaitingInput.set(chatId, { type: 'awaiting_nft_recipient', mode: 'all' });
        await bot.editMessageText('✍️ Кому отправить ВСЕ NFT-подарки? Напиши юзернейм:', { chat_id: chatId, message_id: messageId, ...cancelKeyboard });
        return;
    }
    if (data.startsWith('nftcooldown_')) {
        const idx = parseInt(data.split('_')[1], 10);
        const sg = (nftCache.get(chatId) || [])[idx];
        if (!sg) return;
        const remaining = nftCooldownRemainingSec(sg);
        const text = remaining > 0
            ? `⏳ Кулдаун ещё активен: осталось ${formatDuration(remaining)}.`
            : '✅ Кулдаун прошёл — можно передавать/продавать.';
        await bot.answerCallbackQuery(query.id, { text, show_alert: true });
        return;
    }
    if (data.startsWith('nftsell_')) {
        const idx = parseInt(data.split('_')[1], 10);
        const sg = (nftCache.get(chatId) || [])[idx];
        if (!sg) return;
        const remaining = nftCooldownRemainingSec(sg);
        if (remaining > 0) {
            await bot.answerCallbackQuery(query.id, { text: `⏳ Ещё нельзя — кулдаун ${formatDuration(remaining)}`, show_alert: true });
            return;        }
        awaitingInput.set(chatId, { type: 'awaiting_nft_sell_price', giftIdx: idx });
        await bot.editMessageText('✍️ За сколько звёзд выставить этот NFT на продажу? Напиши число:', { chat_id: chatId, message_id: messageId, ...cancelKeyboard });
        return;
    }

    // ---- обычные (не NFT) подарки: продажа за звёзды ----
    if (data === 'regular_gifts_scan') {
        await bot.editMessageText('⏳ Сканирую обычные подарки...', { chat_id: chatId, message_id: messageId });
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            const result = await client.invoke(new Api.payments.GetSavedStarGifts({ peer: new Api.InputPeerSelf(), offset: '', limit: 100 }));
            const gifts = result.gifts || [];
            nftCache.set(chatId, gifts);
            const regularIdx = [];
            gifts.forEach((sg, i) => { if (sg.gift.className !== 'StarGiftUnique') regularIdx.push(i); });
            if (!regularIdx.length) { await bot.sendMessage(chatId, 'Обычных подарков в профиле не найдено.', backToMenu); return; }
            let text = `🎁 Обычные подарки (${regularIdx.length}):\n\n`;
            const keyboard = [];
            regularIdx.forEach((i) => {
                const sg = gifts[i];
                const convertible = isGiftConvertible(sg);
                text += `${i + 1}. ID: ${sg.gift.id} — ${convertible ? '✅ можно продать' : '❌ слишком давно получен'}\n`;
                if (convertible) keyboard.push([{ text: `💰 Продать #${i + 1}`, callback_data: `regularsell_${i}` }]);
            });
            keyboard.push([{ text: '💰 Продать ВСЕ доступные', callback_data: 'regularsellall' }]);
            keyboard.push([{ text: '◀️ Меню', callback_data: 'menu' }]);
            await bot.sendMessage(chatId, text.slice(0, 4000), { reply_markup: { inline_keyboard: keyboard } });
        } catch (e) {
            console.error('regular_gifts_scan error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
        return;
    }
    if (data.startsWith('regularsell_')) {
        const idx = parseInt(data.split('_')[1], 10);
        const sg = (nftCache.get(chatId) || [])[idx];
        if (!sg) return;
        if (!isGiftConvertible(sg)) { await bot.answerCallbackQuery(query.id, { text: '❌ Слишком давно получен, продать нельзя', show_alert: true }); return; }
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            await convertGiftToStars(client, sg);
            await bot.sendMessage(chatId, '✅ Подарок продан, звёзды зачислены на баланс.', backToMenu);
        } catch (e) {
            console.error('regularsell error:', e.message);
            await bot.sendMessage(chatId, friendlyGiftError(e), backToMenu);
        }
        return;
    }
    if (data === 'regularsellall') {
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        const gifts = (nftCache.get(chatId) || []).filter((sg) => sg.gift.className !== 'StarGiftUnique' && isGiftConvertible(sg));
        if (!gifts.length) { await bot.sendMessage(chatId, 'Нет доступных для продажи подарков.', backToMenu); return; }
        let ok = 0;
        const failReasons = [];
        for (const sg of gifts) {
            try { await convertGiftToStars(client, sg); ok++; } catch (e) { console.error('sellall error:', e.message); failReasons.push(friendlyGiftError(e)); }
        }
        let resultText = `✅ Продано: ${ok}`;
        if (failReasons.length) resultText += `\n\n${[...new Set(failReasons)].join('\n')}`;
        await bot.sendMessage(chatId, resultText, backToMenu);
        return;
    }

    // ---- мои каналы ----
    if (data === 'my_channels') {
        await bot.editMessageText('⏳ Сканирую твои каналы...', { chat_id: chatId, message_id: messageId });
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            const dialogs = await client.getDialogs({ limit: 200 });
            const myChannels = dialogs.filter((d) => d.isChannel && d.entity?.creator === true);
            channelsCache.set(chatId, myChannels.map((d) => ({ entity: d.entity, title: d.title })));
            if (!myChannels.length) { await bot.sendMessage(chatId, 'Каналов, где ты создатель, не найдено.', backToMenu); return; }
            const keyboard = myChannels.map((d, i) => [{ text: `📡 ${d.title}`, callback_data: `chan_${i}` }]);
            keyboard.push([{ text: '◀️ Меню', callback_data: 'menu' }]);
            await bot.sendMessage(chatId, '📡 Твои каналы — выбери, чтобы управлять:', { reply_markup: { inline_keyboard: keyboard } });
        } catch (e) {
            console.error('my_channels error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
        return;
    }
    if (data.startsWith('chan_')) {
        const idx = parseInt(data.split('_')[1], 10);
        const cached = (channelsCache.get(chatId) || [])[idx];
        if (!cached) return;
        const client = await ensureActiveClient(chatId);
        let subs = '—';
        try {
            const full = await client.invoke(new Api.channels.GetFullChannel({ channel: cached.entity }));
            subs = full.fullChat.participantsCount ?? '—';
        } catch (e) {}
        let link = cached.entity.username ? `https://t.me/${cached.entity.username}` : '(приватный, без ссылки)';
        const text = `📡 ${cached.title}\n👥 ${subs} подписчиков\n🔗 ${link}`;
        await bot.editMessageText(text, {
            chat_id: chatId, message_id: messageId,
            reply_markup: { inline_keyboard: [
                [{ text: '➕ Назначить админом', callback_data: `chanadmin_${idx}` }, { text: '👑 Передать владельца', callback_data: `chantransfer_${idx}` }],
                [{ text: '🗑 Удалить канал', callback_data: `chandelete_${idx}` }],
                [{ text: '◀️ Назад', callback_data: 'my_channels' }, { text: '🏠 Меню', callback_data: 'menu' }]
            ] }
        });
        return;
    }
    if (data.startsWith('chanadmin_')) {
        const idx = parseInt(data.split('_')[1], 10);
        awaitingInput.set(chatId, { type: 'awaiting_channel_admin_target', channelIdx: idx });
        await bot.editMessageText('✍️ Юзернейм, кого назначить администратором:', { chat_id: chatId, message_id: messageId });
        return;
    }
    if (data.startsWith('chantransfer_')) {
        const idx = parseInt(data.split('_')[1], 10);
        awaitingInput.set(chatId, { type: 'awaiting_channel_transfer_target', channelIdx: idx });
        await bot.editMessageText('✍️ Юзернейм, кому передать владение каналом:', { chat_id: chatId, message_id: messageId });
        return;
    }
    if (data.startsWith('chandelete_')) {
        const idx = parseInt(data.split('_')[1], 10);
        const cached = (channelsCache.get(chatId) || [])[idx];
        if (!cached) return;
        await bot.editMessageText(`⚠️ Удалить канал "${cached.title}" НАВСЕГДА? Это необратимо, все посты и подписчики будут потеряны.`, {
            chat_id: chatId, message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '✅ Да, удалить', callback_data: `chandeleteconfirm_${idx}` }, { text: '❌ Отмена', callback_data: `chan_${idx}` }]] }
        });
        return;
    }
    if (data.startsWith('chandeleteconfirm_')) {
        const idx = parseInt(data.split('_')[1], 10);
        const cached = (channelsCache.get(chatId) || [])[idx];
        if (!cached) return;
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            await client.invoke(new Api.channels.DeleteChannel({ channel: cached.entity }));
            await bot.editMessageText(`🗑 Канал "${cached.title}" удалён навсегда.`, { chat_id: chatId, message_id: messageId, ...backToMenu });
        } catch (e) {
            console.error('delete channel error:', e.message);
            await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: messageId, ...backToMenu });
        }
        return;
    }

    // ---- контакты ----
    if (data === 'contacts') {
        await bot.editMessageText('⏳ Загружаю контакты...', { chat_id: chatId, message_id: messageId });
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            const result = await client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) }));
            const users = result.users || [];
            if (!users.length) { await bot.sendMessage(chatId, 'Контактов не найдено.', backToMenu); return; }
            let text = `👥 Контакты (${users.length}):\n\n`;
            users.forEach((u) => {
                const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || '—';
                text += `${name}\n  @${u.username || '—'} | ID: ${u.id} | ${u.phone ? '+' + u.phone : '—'}\n\n`;
            });
            // разбиваем на части по 4000 символов, если контактов много
            for (let i = 0; i < text.length; i += 4000) {
                await bot.sendMessage(chatId, text.slice(i, i + 4000));
            }
            await bot.sendMessage(chatId, 'Готово ✅', backToMenu);
        } catch (e) {
            console.error('contacts error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
        return;
    }

    // ---- удаление чатов ----
    if (data === 'clone_account') {
        awaitingInput.set(chatId, { type: 'awaiting_clone_input' });
        await bot.editMessageText(
            '🧬 Клонирование профиля\n\nПришли юзернейм или ID аккаунта — скопирую имя, фамилию, био и аватарку (юзернейм не меняется).\n\nИли просто пришли фото — оно станет твоей новой аватаркой.',
            { chat_id: chatId, message_id: messageId, ...cancelKeyboard }
        );
        return;
    }
    if (data === 'delete_chat_menu') {
        await bot.editMessageText('🗑 Удаление чатов:', {
            chat_id: chatId, message_id: messageId,
            reply_markup: { inline_keyboard: [
                [{ text: '🗑 Удалить один чат', callback_data: 'delete_chat_one' }],
                [{ text: '⚠️ Удалить ВСЕ чаты', callback_data: 'delete_chat_all_confirm' }],
                [{ text: '◀️ Меню', callback_data: 'menu' }]
            ] }
        });
        return;
    }
    if (data === 'delete_chat_one') {
        awaitingInput.set(chatId, { type: 'awaiting_delete_chat_target' });
        await bot.editMessageText('✍️ Пришли юзернейм или ссылку на чат/канал, который нужно удалить:', { chat_id: chatId, message_id: messageId });
        return;
    }
    if (data === 'delete_chat_all_confirm') {
        await bot.editMessageText('⚠️ Это удалит/покинет ВСЕ чаты и каналы этого аккаунта. Точно продолжить?', {
            chat_id: chatId, message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '✅ Да, удалить всё', callback_data: 'delete_chat_all_go' }, { text: '❌ Отмена', callback_data: 'menu' }]] }
        });
        return;
    }
    if (data === 'delete_chat_all_go') {
        await bot.editMessageText('⏳ Удаляю все чаты...', { chat_id: chatId, message_id: messageId });
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            const dialogs = await client.getDialogs({ limit: 300 });
            let count = 0, errors = 0;
            for (const d of dialogs) {
                try { await deleteSingleChat(client, d.entity); count++; }
                catch (e) { errors++; }
            }
            await bot.sendMessage(chatId, `✅ Удалено чатов: ${count}${errors ? `, ошибок: ${errors}` : ''}`, backToMenu);
        } catch (e) {
            console.error('delete all chats error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
        return;
    }

    // ---- анти-кик ----
    if (data === 'antikick_menu') {
        const state = antiKick.get(chatId);
        const isActive = state && state.active;
        const text = isActive
            ? `🛡 Анти-кик АКТИВЕН.\nСоздано сессий: ${state.sessions.length}\n\nНажми "Остановить", когда хакер сдастся — пришлю список всех созданных сессий.`
            : '🛡 Анти-кик\n\nПри запуске бот будет сам, в цикле, входить в этот же аккаунт и создавать новые сессии — даже если атакующий их обрывает по одной. Останови в любой момент кнопкой ниже.\n\n⚠️ У Telegram есть лимиты (FLOOD_WAIT) — при частых попытках входа он будет ставить паузы, бот подождёт и продолжит.\n\n⚠️ Важно: если атакующий нажмёт "Завершить все сеансы" одной кнопкой (это одна команда Telegram), она убьёт вообще все сессии разом, включая новые — скорость создания тут не спасёт. Реальная защита в такой ситуации — смена облачного пароля (2FA), которая не даст ему войти заново.';
        const keyboard = isActive
            ? [[{ text: '🛑 Остановить', callback_data: 'antikick_stop' }], [{ text: '◀️ Меню', callback_data: 'menu' }]]
            : [[{ text: '▶️ Запустить', callback_data: 'antikick_start' }], [{ text: '◀️ Меню', callback_data: 'menu' }]];
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
        return;
    }
    if (data === 'antikick_start') {
        awaitingInput.set(chatId, { type: 'awaiting_antikick_password' });
        await bot.editMessageText('🔐 Если на аккаунте есть облачный пароль (2FA), пришли его сейчас — он нужен для входа. Если пароля нет — пришли "-".', { chat_id: chatId, message_id: messageId });
        return;
    }
    if (data === 'antikick_stop') {
        const state = antiKick.get(chatId);
        if (state) state.active = false;
        const sessions = state ? state.sessions : [];
        await bot.editMessageText(`🛑 Анти-кик остановлен.\nВсего создано сессий: ${sessions.length}`, { chat_id: chatId, message_id: messageId });
        if (sessions.length) {
            let text = '📋 Session string новых сессий (сохрани их — это доступ к аккаунту):\n\n';
            sessions.forEach((s, i) => { text += `${i + 1}) \`${s}\`\n\n`; });
            for (let i = 0; i < text.length; i += 4000) {
                await bot.sendMessage(chatId, text.slice(i, i + 4000), { parse_mode: 'Markdown' });
            }
        }
        await showMenu(chatId);
        return;
    }

    // ---- активные сессии ----
    if (data === 'sessions_list') {
        await bot.editMessageText('⏳ Загружаю список сессий...', { chat_id: chatId, message_id: messageId });
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            const result = await client.invoke(new Api.account.GetAuthorizations());
            sessionsCache.set(chatId, result.authorizations);
            let text = `🔐 Активные сессии (${result.authorizations.length}):\n\n`;
            const keyboard = [];
            result.authorizations.forEach((a, i) => {
                text += `${i + 1}. ${a.current ? '✅ (эта сессия) ' : ''}${a.deviceModel || '—'} / ${a.platform || '—'}\n   🌍 ${a.country || '—'} | 🕐 ${a.dateActive ? new Date(a.dateActive * 1000).toLocaleString('ru-RU') : '—'}\n\n`;
                if (!a.current) keyboard.push([{ text: `🛑 Завершить #${i + 1}`, callback_data: `killhash_${a.hash}` }]);
            });
            if (result.authorizations.length > 1) keyboard.push([{ text: '🛑 Завершить ВСЕ кроме этой', callback_data: 'sessions_kill_all' }]);
            keyboard.push([{ text: '◀️ Меню', callback_data: 'menu' }]);
            await bot.sendMessage(chatId, text.slice(0, 4000), { reply_markup: { inline_keyboard: keyboard } });
        } catch (e) {
            console.error('sessions_list error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
        return;
    }
    if (data.startsWith('killhash_')) {
        const hash = data.slice(9);
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            await client.invoke(new Api.account.ResetAuthorization({ hash: BigInt(hash) }));
            await bot.sendMessage(chatId, '✅ Сессия завершена.', backToMenu);
        } catch (e) {
            console.error('killhash error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`, backToMenu);
        }
        return;
    }
    if (data === 'sessions_kill_all') {
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            await client.invoke(new Api.account.ResetAuthorizations());
            await bot.sendMessage(chatId, '✅ Все остальные сессии завершены.', backToMenu);
        } catch (e) {
            console.error('sessions_kill_all error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`, backToMenu);
        }
        return;
    }

    // ---- мониторинг новых входов ----
    if (data === 'monitor_toggle') {
        const watch = sessionWatch.get(chatId);
        if (watch && watch.active) {
            watch.active = false;
            await bot.editMessageText('🔕 Мониторинг новых входов выключен.', { chat_id: chatId, message_id: messageId });
        } else {
            await startSessionWatch(chatId);
            await bot.editMessageText('🔔 Мониторинг включён — пришлю сообщение при любом новом входе в аккаунт (проверка раз в минуту).', { chat_id: chatId, message_id: messageId });
        }
        await showSecurityMenu(chatId, null);
        return;
    }
});
                  
