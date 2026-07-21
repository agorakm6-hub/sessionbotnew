// ============================================================
//  index.js — приватный бот-менеджер твоих Telegram-аккаунтов
// ============================================================
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const cfg = require('./config');
const db = require('./database');

const bot = new TelegramBot(cfg.BOT_TOKEN, { webHook: false });
console.log('🚀 Приватный бот запущен (webhook)');

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// ====== HTTP / WEBHOOK ======
const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === cfg.WEBHOOK_PATH) {
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
server.listen(cfg.PORT, async () => {
    console.log(`✅ Сервер на порту ${cfg.PORT}`);
    try {
        await bot.setWebHook(`${cfg.EXTERNAL_URL}${cfg.WEBHOOK_PATH}`);
        console.log('✅ Webhook установлен');
    } catch (e) { console.error('❌ Webhook error:', e); }
});

db.initDb();

// ====== СОСТОЯНИЯ ВВОДА (в памяти — бот личный, один пользователь) ======
const awaitingInput = new Map(); // chatId -> { type, ...extra }
const activeClients = new Map(); // chatId -> TelegramClient (подключённый)

// ====== ПОДКЛЮЧЕНИЕ К АККАУНТУ ПО SESSION STRING ======
async function connectSession(sessionString) {
    const client = new TelegramClient(new StringSession(sessionString), cfg.TG_API_ID, cfg.TG_API_HASH, { connectionRetries: 3 });
    await client.connect();
    const me = await client.getMe(); // бросит ошибку, если сессия невалидна
    return { client, me };
}

async function ensureActiveClient(chatId) {
    if (activeClients.has(chatId)) return activeClients.get(chatId);
    const acc = await db.getActiveAccount(chatId);
    if (!acc) return null;
    try {
        const { client } = await connectSession(acc.session_string);
        activeClients.set(chatId, client);
        return client;
    } catch (e) {
        console.error('ensureActiveClient error:', e.message);
        return null;
    }
}

async function disconnectClient(chatId) {
    const client = activeClients.get(chatId);
    if (client) {
        try { await client.disconnect(); } catch (e) {}
        activeClients.delete(chatId);
    }
}

// ====== ГЛАВНОЕ МЕНЮ ======
async function showMenu(chatId, messageId = null) {
    const acc = await db.getActiveAccount(chatId);
    if (!acc) {
        const text = '📱 Аккаунт не подключён.\n\nПришли session string, чтобы подключить свой Telegram-аккаунт.';
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
        else await bot.sendMessage(chatId, text);
        awaitingInput.set(chatId, { type: 'awaiting_session' });
        return;
    }
    const text = `📱 Активный аккаунт: ${acc.label}\n\nВыбери действие:`;
    const keyboard = [
        [{ text: '📨 Написать сообщение', callback_data: 'send_msg' }],
        [{ text: '📥 Последние сообщения', callback_data: 'read_messages' }],
        [{ text: '📡 Мои каналы', callback_data: 'my_channels' }],
        [{ text: '🔄 Сменить аккаунт', callback_data: 'switch_account' }, { text: '➕ Добавить аккаунт', callback_data: 'add_account' }],
        [{ text: '🚪 Выйти с аккаунта', callback_data: 'logout_account' }, { text: '🗑 Удалить аккаунт', callback_data: 'delete_account' }]
    ];
    const opts = { chat_id: chatId, reply_markup: { inline_keyboard: keyboard } };
    if (messageId) await bot.editMessageText(text, { ...opts, message_id: messageId });
    else await bot.sendMessage(chatId, text, { reply_markup: opts.reply_markup });
}

// ====== ТЕКСТОВЫЕ СООБЩЕНИЯ ======
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.text) return;

    const unlocked = await db.isUnlocked(chatId);

    // --- Не авторизован: бот реагирует ТОЛЬКО на точное совпадение ключа, иначе молчит ---
    if (!unlocked) {
        if (msg.text.trim() === cfg.SECRET_KEY) {
            await db.unlock(chatId);
            awaitingInput.set(chatId, { type: 'awaiting_session' });
            await bot.sendMessage(chatId, '🔓 Ключ принят.\n\nПришли session string аккаунта, который хочешь подключить.');
        }
        // любой другой текст, включая /start — полностью игнорируем
        return;
    }

    // --- Авторизован ---
    if (msg.text === '/start') {
        if (!awaitingInput.has(chatId)) await showMenu(chatId);
        return;
    }

    const state = awaitingInput.get(chatId);
    if (!state) return;

    if (state.type === 'awaiting_session') {
        const sessionString = msg.text.trim();
        const wait = await bot.sendMessage(chatId, '⏳ Проверяю session string...');
        try {
            const { client, me } = await connectSession(sessionString);
            const label = me.username ? `@${me.username}` : (me.phone ? `+${me.phone}` : `ID ${me.id}`);
            await db.addAccount(chatId, sessionString, label, me.phone || null);
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

    if (state.type === 'awaiting_send') {
        const lines = msg.text.split('\n');
        const recipientsLine = lines[0] || '';
        const body = lines.slice(1).join('\n').trim();
        const recipients = recipientsLine.split(/\s+/).map((s) => s.replace(/^@/, '')).filter(Boolean);
        if (recipients.length === 0 || !body) {
            await bot.sendMessage(chatId, '❌ Формат: первая строка — @юз1 @юз2, дальше — текст сообщения.');
            return;
        }
        awaitingInput.delete(chatId);
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        let sent = [], failed = [];
        for (const r of recipients) {
            try { await client.sendMessage(r, { message: body }); sent.push(r); }
            catch (e) { failed.push(`${r} (${e.message})`); }
        }
        let text = sent.length ? `✅ Отправлено: ${sent.map((s) => '@' + s).join(', ')}` : '';
        if (failed.length) text += `\n❌ Не удалось: ${failed.join(', ')}`;
        await bot.sendMessage(chatId, text || 'Ничего не отправлено.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] } });
        return;
    }

    if (state.type === 'awaiting_delete_confirm') {
        awaitingInput.delete(chatId);
        if (msg.text.trim() !== state.phrase) {
            await bot.sendMessage(chatId, '❌ Фраза не совпала — удаление отменено.');
            return;
        }
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            await client.invoke(new Api.account.DeleteAccount({ reason: 'Requested via personal management bot' }));
            await disconnectClient(chatId);
            await db.removeAccount(chatId, state.accountId);
            await bot.sendMessage(chatId, '🗑 Аккаунт удалён навсегда.');
            await showMenu(chatId);
        } catch (e) {
            console.error('delete account error:', e.message);
            await bot.sendMessage(chatId, `❌ Не удалось удалить аккаунт: ${e.message}`);
        }
        return;
    }
});

// ====== CALLBACK-КНОПКИ ======
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    await bot.answerCallbackQuery(query.id);

    if (!(await db.isUnlocked(chatId))) return; // на всякий случай, до кнопок дело не дойдёт

    if (data === 'menu') { awaitingInput.delete(chatId); await showMenu(chatId, messageId); return; }

    if (data === 'add_account') {
        awaitingInput.set(chatId, { type: 'awaiting_session' });
        await bot.editMessageText('✍️ Пришли session string нового аккаунта:', { chat_id: chatId, message_id: messageId });
        return;
    }

    if (data === 'switch_account') {
        const accounts = await db.listAccounts(chatId);
        if (!accounts.length) { await bot.editMessageText('Нет сохранённых аккаунтов.', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] } }); return; }
        const keyboard = accounts.map((a) => [{ text: `${a.active ? '✅ ' : ''}${a.label}`, callback_data: `switchto_${a.id}` }]);
        keyboard.push([{ text: '◀️ Меню', callback_data: 'menu' }]);
        await bot.editMessageText('📋 Твои аккаунты:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
        return;
    }

    if (data.startsWith('switchto_')) {
        const accountId = parseInt(data.split('_')[1], 10);
        const acc = await db.getAccount(chatId, accountId);
        if (!acc) return;
        await disconnectClient(chatId);
        await db.setActiveAccount(chatId, accountId);
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
        const acc = await db.getActiveAccount(chatId);
        if (!acc) { await showMenu(chatId, messageId); return; }
        await bot.editMessageText(`🚪 Выйти из ${acc.label}? Это завершит сессию — понадобится новый session string, чтобы зайти снова.`, {
            chat_id: chatId, message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '✅ Да, выйти', callback_data: `logoutconfirm_${acc.id}` }, { text: '❌ Отмена', callback_data: 'menu' }]] }
        });
        return;
    }
    if (data.startsWith('logoutconfirm_')) {
        const accountId = parseInt(data.split('_')[1], 10);
        const client = await ensureActiveClient(chatId);
        try {
            if (client) await client.invoke(new Api.auth.LogOut());
        } catch (e) { console.error('logout error:', e.message); }
        await disconnectClient(chatId);
        await db.removeAccount(chatId, accountId);
        await bot.editMessageText('✅ Вышел из аккаунта.', { chat_id: chatId, message_id: messageId });
        await showMenu(chatId);
        return;
    }

    if (data === 'delete_account') {
        const acc = await db.getActiveAccount(chatId);
        if (!acc) { await showMenu(chatId, messageId); return; }
        const phrase = `УДАЛИТЬ ${acc.label}`;
        awaitingInput.set(chatId, { type: 'awaiting_delete_confirm', accountId: acc.id, phrase });
        await bot.editMessageText(
            `⚠️ Это НАВСЕГДА удалит аккаунт ${acc.label} из Telegram. Отменить нельзя.\n\nЧтобы подтвердить, отправь текстом ровно:\n\`${phrase}\``,
            { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
        );
        return;
    }

    if (data === 'send_msg') {
        awaitingInput.set(chatId, { type: 'awaiting_send' });
        await bot.editMessageText('✍️ Первая строка — получатели через пробел (@юз1 @юз2), дальше — текст сообщения.', { chat_id: chatId, message_id: messageId });
        return;
    }

    if (data === 'read_messages') {
        await bot.editMessageText('⏳ Загружаю последние чаты...', { chat_id: chatId, message_id: messageId });
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            const dialogs = await client.getDialogs({ limit: 15 });
            // Telegram (777000) всегда первым
            let serviceDialog = dialogs.find((d) => Number(d.id) === cfg.TELEGRAM_SERVICE_ID);
            const others = dialogs.filter((d) => Number(d.id) !== cfg.TELEGRAM_SERVICE_ID).slice(0, 9);
            const ordered = serviceDialog ? [serviceDialog, ...others] : others.slice(0, 10);

            if (ordered.length === 0) {
                await bot.sendMessage(chatId, 'Чатов не найдено.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] } });
                return;
            }

            for (const dialog of ordered) {
                try {
                    const messages = await client.getMessages(dialog.entity, { limit: 10 });
                    let text = `💬 ${dialog.title || dialog.name || 'Чат'}${dialog.unreadCount ? ` (непрочитано: ${dialog.unreadCount})` : ''}\n\n`;
                    if (!messages.length) text += '— пусто —';
                    else {
                        messages.reverse().forEach((m) => {
                            const who = m.out ? 'Я' : (m.sender?.firstName || m.sender?.username || '—');
                            const body = (m.message || '[медиа/без текста]').slice(0, 200);
                            const time = m.date ? new Date(m.date * 1000).toLocaleString('ru-RU') : '';
                            text += `[${time}] ${who}: ${body}\n`;
                        });
                    }
                    await bot.sendMessage(chatId, text.slice(0, 4000));
                } catch (e) {
                    console.error('read chat error:', e.message);
                }
            }
            await bot.sendMessage(chatId, 'Готово ✅', { reply_markup: { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] } });
        } catch (e) {
            console.error('read_messages error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
        return;
    }

    if (data === 'my_channels') {
        await bot.editMessageText('⏳ Сканирую твои каналы...', { chat_id: chatId, message_id: messageId });
        const client = await ensureActiveClient(chatId);
        if (!client) { await bot.sendMessage(chatId, '❌ Нет подключённого аккаунта.'); return; }
        try {
            const dialogs = await client.getDialogs({ limit: 200 });
            const myChannels = dialogs.filter((d) => d.isChannel && d.entity?.creator === true);
            if (!myChannels.length) {
                await bot.sendMessage(chatId, 'Каналов, где ты создатель, не найдено.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] } });
                return;
            }
            let text = `📡 Твои каналы (${myChannels.length}):\n\n`;
            for (const d of myChannels) {
                let subs = '—';
                try {
                    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: d.entity }));
                    subs = full.fullChat.participantsCount ?? '—';
                } catch (e) { /* не критично */ }
                let link = d.entity.username ? `https://t.me/${d.entity.username}` : null;
                if (!link) {
                    try {
                        const invite = await client.invoke(new Api.messages.ExportChatInvite({ peer: d.entity }));
                        link = invite.link || '(приватный, без ссылки)';
                    } catch (e) { link = '(приватный, без ссылки)'; }
                }
                text += `• ${d.title}\n  👥 ${subs} подписчиков\n  🔗 ${link}\n\n`;
            }
            await bot.sendMessage(chatId, text.slice(0, 4000), { reply_markup: { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] } });
        } catch (e) {
            console.error('my_channels error:', e.message);
            await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
        return;
    }
});// ============================================================
//  database.js — авторизация по ключу + хранение аккаунтов
// ============================================================
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { DB_PATH } = require('./config');

let db;
async function initDb() {
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS auth (
            chat_id INTEGER PRIMARY KEY,
            unlocked_at TEXT
        )
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER,
            label TEXT,
            phone TEXT,
            session_string TEXT,
            active INTEGER DEFAULT 0,
            added_at TEXT
        )
    `);
    console.log(`✅ БД готова: ${DB_PATH}`);
    return db;
}
function getDb() { return db; }

// ---- авторизация ключом ----
async function isUnlocked(chatId) {
    const row = await db.get('SELECT chat_id FROM auth WHERE chat_id = ?', chatId);
    return !!row;
}
async function unlock(chatId) {
    await db.run('INSERT OR IGNORE INTO auth (chat_id, unlocked_at) VALUES (?, ?)', chatId, new Date().toISOString());
}

// ---- аккаунты ----
async function addAccount(chatId, sessionString, label, phone) {
    await db.run('UPDATE accounts SET active = 0 WHERE chat_id = ?', chatId);
    const res = await db.run(
        'INSERT INTO accounts (chat_id, label, phone, session_string, active, added_at) VALUES (?, ?, ?, ?, 1, ?)',
        chatId, label, phone, sessionString, new Date().toISOString()
    );
    return res.lastID;
}
async function listAccounts(chatId) {
    return db.all('SELECT * FROM accounts WHERE chat_id = ? ORDER BY id', chatId);
}
async function getActiveAccount(chatId) {
    return db.get('SELECT * FROM accounts WHERE chat_id = ? AND active = 1', chatId);
}
async function setActiveAccount(chatId, accountId) {
    await db.run('UPDATE accounts SET active = 0 WHERE chat_id = ?', chatId);
    await db.run('UPDATE accounts SET active = 1 WHERE id = ? AND chat_id = ?', accountId, chatId);
}
async function removeAccount(chatId, accountId) {
    await db.run('DELETE FROM accounts WHERE id = ? AND chat_id = ?', accountId, chatId);
}
async function getAccount(chatId, accountId) {
    return db.get('SELECT * FROM accounts WHERE id = ? AND chat_id = ?', accountId, chatId);
}

module.exports = {
    initDb, getDb,
    isUnlocked, unlock,
    addAccount, listAccounts, getActiveAccount, setActiveAccount, removeAccount, getAccount
};// ============================================================
//  config.js — конфигурация приватного бота-менеджера аккаунтов
// ============================================================
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
if (!BOT_TOKEN) {
    console.error('❌ Не задан BOT_TOKEN в переменных окружения.');
    process.exit(1);
}

// Секретный ключ — 64 случайных символа. Сгенерировать можно так:
//   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
// Пока не введён точно этот ключ, бот вообще ни на что не отвечает —
// со стороны выглядит "нерабочим".
const SECRET_KEY = process.env.SECRET_KEY || '';
if (!SECRET_KEY || SECRET_KEY.length < 64) {
    console.error('❌ SECRET_KEY не задан или короче 64 символов. Сгенерируй длинный случайный ключ и задай в переменных окружения.');
    process.exit(1);
}

// MTProto — нужен для подключения к аккаунтам по session string
const TG_API_ID = parseInt(process.env.TG_API_ID || '0', 10);
const TG_API_HASH = process.env.TG_API_HASH || '';
if (!TG_API_ID || !TG_API_HASH) {
    console.error('❌ Не заданы TG_API_ID / TG_API_HASH — без них нельзя подключаться к аккаунтам через session string.');
    process.exit(1);
}

// ⚠️ Про базу данных на Render: без подключённого Persistent Disk файловая
// система сбрасывается при каждом деплое/перезапуске — вместе с ней исчезнут
// сохранённые session string. Подключи Disk (Render → сервис → Disks →
// Add Disk, mount path например "/data") и задай DB_PATH=/data/accounts.db
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'accounts.db');

const PORT = process.env.PORT || 10000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
if (!EXTERNAL_URL) {
    console.error('❌ Не найден RENDER_EXTERNAL_URL или WEBHOOK_URL.');
    process.exit(1);
}

// Служебный чат "Telegram" (777000) — всегда показываем первым в списке сообщений,
// чтобы никогда не пропустить системные уведомления (коды входа и т.п.)
const TELEGRAM_SERVICE_ID = 777000;

module.exports = {
    BOT_TOKEN, SECRET_KEY, TG_API_ID, TG_API_HASH, DB_PATH,
    PORT, EXTERNAL_URL, WEBHOOK_PATH, TELEGRAM_SERVICE_ID
};
