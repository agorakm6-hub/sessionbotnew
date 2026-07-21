// ============================================================
//  session.js — приватный бот-менеджер твоих Telegram-аккаунтов
//  (всё в одном файле)
// ============================================================
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');

// ====== КОНФИГ ======
const BOT_TOKEN = process.env.BOT_TOKEN || '';
if (!BOT_TOKEN) { console.error('❌ Не задан BOT_TOKEN.'); process.exit(1); }

const SECRET_KEY = process.env.SECRET_KEY || '';
if (!SECRET_KEY || SECRET_KEY.length < 64) { console.error('❌ SECRET_KEY не задан или короче 64 символов.'); process.exit(1); }

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
const activeClients = new Map();   // chatId -> TelegramClient
const channelsCache = new Map();   // chatId -> [{ entity, title }]

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
    const text = `📱 Активный аккаунт: ${acc.label}\n\nВыбери действие:`;
    const keyboard = [
        [{ text: '📨 Написать сообщение', callback_data: 'send_msg' }],
        [{ text: '📥 Сообщения Telegram', callback_data: 'read_messages' }],
        [{ text: '⭐ Баланс звёзд и подарки', callback_data: 'stars' }],
        [{ text: '📡 Мои каналы', callback_data: 'my_channels' }, { text: '👥 Контакты', callback_data: 'contacts' }],
        [{ text: '🗑 Удалить чат', callback_data: 'delete_chat_menu' }],
        [{ text: '🔄 Сменить аккаунт', callback_data: 'switch_account' }, { text: '➕ Добавить аккаунт', callback_data: 'add_account' }],
        [{ text: '🚪 Выйти с аккаунта', callback_data: 'logout_account' }, { text: '🗑 Удалить аккаунт', callback_data: 'delete_account' }]
    ];
    if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
    else await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}
const backToMenu = { reply_markup: { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] } };

// ====== ТЕКСТОВЫЕ СООБЩЕНИЯ ======
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.text) return;

    const unlocked = await isUnlocked(chatId);
    if (!unlocked) {
        if (msg.text.trim() === SECRET_KEY) {
            await unlock(chatId);
            awaitingInput.set(chatId, { type: 'awaiting_session' });
            await bot.sendMessage(chatId, '🔓 Ключ принят.\n\nПришли session string аккаунта, который хочешь подключить.');
        }
        return; // любой другой текст, включая /start — игнорируем
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
            const inputUser = await client.getInputEntity(target);
            const invoice = new Api.InputInvoiceStarGift({ userId: inputUser, giftId: BigInt(state.giftId) });
            const form = await client.invoke(new Api.payments.GetPaymentForm({ invoice }));
            await client.invoke(new Api.payments.SendStarsForm({ formId: form.formId, invoice }));
            await bot.editMessageText(`🎁 Подарок "${state.giftName}" отправлен пользователю @${target}!`, { chat_id: chatId, message_id: wait.message_id });
        } catch (e) {
            console.error('send gift error:', e.message);
            await bot.editMessageText(`❌ Не удалось отправить подарок: ${e.message}`, { chat_id: chatId, message_id: wait.message_id });
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
                    banUsers: true, inviteUsers: true, pinMessages: true, manageCall: true, other: true
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
        awaitingInput.set(chatId, { type: 'awaiting_channel_transfer_password', channelIdx: state.channelIdx, target });
        await bot.sendMessage(chatId, '🔐 Для передачи владения Telegram требует твой облачный пароль (2FA). Введи его:');
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
            await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: wait.message_id });
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
});

// ====== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ======
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

    if (!(await isUnlocked(chatId))) return;

    if (data === 'menu') { awaitingInput.delete(chatId); await showMenu(chatId, messageId); return; }

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
});
