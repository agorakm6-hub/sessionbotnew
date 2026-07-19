const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const http = require('http');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

// ====== КОНФИГ ======
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID = 8701969979;

if (!BOT_TOKEN) {
    console.error('❌ Не задан BOT_TOKEN в переменных окружения.');
    process.exit(1);
}

// MTProto — для реальной проверки занятости username. Если не задано,
// бот работает в режиме "только генерация" без проверки.
const TG_API_ID = parseInt(process.env.TG_API_ID || '0', 10);
const TG_API_HASH = process.env.TG_API_HASH || '';
const TG_SESSION = process.env.TG_SESSION || '';

// Тарифы (в звёздах)
const PRICES = {
    week: 15,      // премиум на 7 дней
    month: 40,     // премиум на 30 дней
    lifetime: 100, // премиум навсегда
    pack10: 5,     // +10 поисков
    pack30: 12     // +30 поисков
};
const REFERRAL_BONUS = 5; // поисков за приглашённого друга

// ====== БОТ (WEBHOOK-РЕЖИМ) ======
const PORT = process.env.PORT || 10000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;

if (!EXTERNAL_URL) {
    console.error('❌ Не найден RENDER_EXTERNAL_URL или WEBHOOK_URL.');
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { webHook: false });
console.log('🚀 Бот запущен в режиме webhook!');

let botUsername = null;
bot.getMe().then((me) => { botUsername = me.username; }).catch((e) => console.error('getMe error:', e));

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            try {
                const update = JSON.parse(body);
                bot.processUpdate(update);
            } catch (e) {
                console.error('Ошибка разбора апдейта:', e);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running');
});

server.listen(PORT, async () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    const webhookUrl = `${EXTERNAL_URL}${WEBHOOK_PATH}`;
    try {
        await bot.setWebHook(webhookUrl);
        console.log(`✅ Webhook установлен: ${webhookUrl}`);
    } catch (e) {
        console.error('❌ Не удалось установить webhook:', e);
    }
});

// ====== MTPROTO КЛИЕНТ (реальная проверка username) ======
let mtClient = null;
let mtReady = false;

class RateLimitedQueue {
    constructor(minDelayMs) {
        this.minDelayMs = minDelayMs;
        this.queue = [];
        this.processing = false;
        this.lastRun = 0;
    }
    push(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this._process();
        });
    }
    async _process() {
        if (this.processing) return;
        this.processing = true;
        while (this.queue.length) {
            const { fn, resolve, reject } = this.queue.shift();
            const wait = Math.max(0, this.minDelayMs - (Date.now() - this.lastRun));
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            try {
                const result = await fn();
                this.lastRun = Date.now();
                resolve(result);
            } catch (e) {
                this.lastRun = Date.now();
                reject(e);
            }
        }
        this.processing = false;
    }
}
// Не чаще одного запроса в 1.5 сек — чтобы не словить FLOOD_WAIT
const usernameCheckQueue = new RateLimitedQueue(1500);

async function initMtClient() {
    if (!TG_API_ID || !TG_API_HASH || !TG_SESSION) {
        console.warn('⚠️ TG_API_ID/TG_API_HASH/TG_SESSION не заданы — реальная проверка username отключена, бот будет только генерировать варианты без проверки занятости.');
        return;
    }
    try {
        mtClient = new TelegramClient(new StringSession(TG_SESSION), TG_API_ID, TG_API_HASH, { connectionRetries: 5 });
        await mtClient.connect();
        mtReady = true;
        console.log('✅ MTProto клиент подключен — проверка занятости username активна');
    } catch (e) {
        console.error('❌ Не удалось подключить MTProto клиент:', e.message);
    }
}
initMtClient();

// Возвращает true (свободен), false (занят/невалиден) или null (не удалось проверить)
async function checkUsernameAvailable(username) {
    if (!mtReady) return null;
    return usernameCheckQueue.push(async () => {
        try {
            const result = await mtClient.invoke(new Api.account.CheckUsername({ username }));
            return result === true;
        } catch (e) {
            const msg = e.errorMessage || e.message || '';
            if (msg.includes('USERNAME_OCCUPIED') || msg.includes('USERNAME_INVALID')) {
                return false;
            }
            console.error(`checkUsername("${username}") error:`, msg);
            return null;
        }
    });
}

// ====== БАЗА ДАННЫХ ======
let db;
async function initDb() {
    db = await open({ filename: './username.db', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            searches INTEGER DEFAULT 5,
            ratings INTEGER DEFAULT 5,
            unlimited BOOLEAN DEFAULT 0,
            premium_until TEXT DEFAULT NULL,
            last_reset TEXT DEFAULT NULL,
            banned INTEGER DEFAULT 0,
            referred_by INTEGER DEFAULT NULL,
            referral_count INTEGER DEFAULT 0
        )
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS search_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            username TEXT,
            created_at TEXT
        )
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            amount INTEGER,
            tier TEXT,
            created_at TEXT
        )
    `);
}
initDb();

// ====== ФУНКЦИИ БАЗЫ ======
async function createUser(userId) {
    await db.run('INSERT OR IGNORE INTO users (user_id) VALUES (?)', userId);
}
async function isBanned(userId) {
    const row = await db.get('SELECT banned FROM users WHERE user_id = ?', userId);
    return row && row.banned === 1;
}
async function banUser(userId) {
    await db.run('UPDATE users SET banned = 1 WHERE user_id = ?', userId);
}
async function unbanUser(userId) {
    await db.run('UPDATE users SET banned = 0 WHERE user_id = ?', userId);
}
async function getSearches(userId) {
    const row = await db.get('SELECT searches FROM users WHERE user_id = ?', userId);
    return row ? row.searches : 0;
}
async function updateSearches(userId, amount) {
    await db.run('UPDATE users SET searches = searches + ? WHERE user_id = ?', amount, userId);
}
async function getRatings(userId) {
    const row = await db.get('SELECT ratings FROM users WHERE user_id = ?', userId);
    return row ? row.ratings : 0;
}
async function updateRatings(userId, amount) {
    await db.run('UPDATE users SET ratings = ratings + ? WHERE user_id = ?', amount, userId);
}
async function isUnlimited(userId) {
    const row = await db.get('SELECT unlimited, premium_until FROM users WHERE user_id = ?', userId);
    if (!row) return false;
    if (row.unlimited === 1) return true;
    if (row.premium_until && new Date(row.premium_until) > new Date()) return true;
    return false;
}
async function setLifetimePremium(userId) {
    await db.run('UPDATE users SET unlimited = 1 WHERE user_id = ?', userId);
}
async function grantPremiumTier(userId, tier) {
    const now = new Date();
    const row = await db.get('SELECT premium_until FROM users WHERE user_id = ?', userId);
    const base = (row && row.premium_until && new Date(row.premium_until) > now) ? new Date(row.premium_until) : now;
    const days = tier === 'week' ? 7 : 30;
    const until = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    await db.run('UPDATE users SET premium_until = ? WHERE user_id = ?', until.toISOString(), userId);
    return until;
}
function isAdmin(userId) {
    return Number(userId) === Number(ADMIN_ID);
}
function todayStr() {
    return new Date().toISOString().slice(0, 10);
}
async function ensureDailyReset(userId) {
    const row = await db.get('SELECT last_reset FROM users WHERE user_id = ?', userId);
    const today = todayStr();
    if (!row || row.last_reset !== today) {
        await db.run('UPDATE users SET searches = 5, ratings = 5, last_reset = ? WHERE user_id = ?', today, userId);
    }
}

// ====== СОСТОЯНИЯ ОЖИДАНИЯ ВВОДА ======
const awaitingInput = new Map(); // chatId -> { type, messageId }

// ====== ГЕНЕРАЦИЯ ЮЗЕРНЕЙМОВ ======
function generateFakeUsernames(length, count = 30) {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const exclude = 'il1o0';
    const available = letters.split('').filter((c) => !exclude.includes(c)).join('');
    const usernames = new Set();
    let attempts = 0;
    while (usernames.size < count && attempts < 20000) {
        let username = '';
        const chars = available.split('');
        for (let i = 0; i < length; i++) {
            const idx = Math.floor(Math.random() * chars.length);
            username += chars[idx];
            chars.splice(idx, 1);
        }
        if (username.length === length) {
            usernames.add(username);
        }
        attempts++;
    }
    return Array.from(usernames);
}

// ====== ОЦЕНКА ======
function rateUsername(username) {
    let score = 0;
    const feedback = [];
    if (username.length < 5) { score += 1; feedback.push('❌ Слишком короткий (меньше 5)'); }
    else if (username.length <= 8) { score += 3; feedback.push('✅ Хорошая длина (5-8)'); }
    else if (username.length <= 12) { score += 2; feedback.push('⚠️ Длинноват (9-12)'); }
    else { score += 1; feedback.push('❌ Слишком длинный (>12)'); }
    if (/^[a-zA-Z]+$/.test(username)) { score += 3; feedback.push('✅ Только буквы'); }
    else if (/^[a-zA-Z0-9]+$/.test(username)) { score += 2; feedback.push('⚠️ Есть цифры'); }
    else { score += 0; feedback.push('❌ Есть спецсимволы'); }
    if (username === username.toLowerCase()) { score += 2; feedback.push('✅ Нижний регистр'); }
    else if (username === username.toUpperCase()) { score += 0; feedback.push('❌ Верхний регистр'); }
    else { score += 1; feedback.push('⚠️ Смешанный регистр'); }
    if (/^[a-zA-Z]+$/.test(username)) { score += 2; feedback.push('✅ Легко читается'); }
    else { feedback.push('⚠️ Может быть нечитаемым'); }
    if (new Set(username).size === username.length) { score += 1; feedback.push('✅ Все буквы уникальны'); }
    else { feedback.push('⚠️ Есть повторяющиеся буквы'); }
    score = Math.min(10, Math.max(1, score));
    return { score, feedback };
}

// ====== ГЛАВНОЕ МЕНЮ ======
async function showMainMenu(chatId, messageId = null) {
    if (await isBanned(chatId)) {
        await bot.sendMessage(chatId, '❌ Вы забанены!');
        return;
    }
    await ensureDailyReset(chatId);
    const unlimited = await isUnlimited(chatId);
    const searches = unlimited ? '∞' : await getSearches(chatId);
    const ratings = await getRatings(chatId);
    const row = await db.get('SELECT premium_until FROM users WHERE user_id = ?', chatId);
    let premiumLine = '';
    if (await db.get('SELECT unlimited FROM users WHERE user_id = ? AND unlimited = 1', chatId)) {
        premiumLine = '⭐ Премиум: навсегда';
    } else if (row && row.premium_until && new Date(row.premium_until) > new Date()) {
        premiumLine = `⭐ Премиум до: ${new Date(row.premium_until).toLocaleDateString('ru-RU')}`;
    }
    const text = `👋 Привет!\n\n🔍 Поиски: ${searches}\n⭐ Оценки: ${ratings}/5\n${premiumLine}`;
    const buttons = {
        reply_markup: {
            inline_keyboard: [
                [{ text: unlimited ? '🔍 5 букв' : '🔍 6+ букв', callback_data: 'search' }],
                [{ text: '🎯 Своё число', callback_data: 'search_custom' }],
                [{ text: '⭐ Оценить юзернейм', callback_data: 'rate' }],
                [{ text: '📜 История поисков', callback_data: 'history_0' }],
                [{ text: '🎁 Пригласить друга', callback_data: 'referral' }],
                [{ text: '💎 Премиум', callback_data: 'premium' }]
            ]
        }
    };
    if (isAdmin(chatId)) {
        buttons.reply_markup.inline_keyboard.push([{ text: '👑 Админ-панель', callback_data: 'admin' }]);
    }
    if (messageId) {
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...buttons });
    } else {
        await bot.sendMessage(chatId, text, buttons);
    }
}

// ====== СТАРТ (+ РЕФЕРАЛЬНАЯ ССЫЛКА) ======
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const payload = match && match[1];
    const existing = await db.get('SELECT user_id FROM users WHERE user_id = ?', chatId);
    const isNew = !existing;
    await createUser(chatId);

    if (isNew && payload && payload.startsWith('ref_')) {
        const refId = parseInt(payload.split('_')[1], 10);
        if (!isNaN(refId) && refId !== chatId) {
            await createUser(refId);
            const res = await db.run('UPDATE users SET referred_by = ? WHERE user_id = ? AND referred_by IS NULL', refId, chatId);
            if (res.changes > 0) {
                await db.run('UPDATE users SET referral_count = referral_count + 1 WHERE user_id = ?', refId);
                await updateSearches(refId, REFERRAL_BONUS);
                try {
                    await bot.sendMessage(refId, `🎉 По твоей ссылке зарегистрировался новый пользователь! +${REFERRAL_BONUS} поисков`);
                } catch (e) { /* пользователь мог заблокировать бота */ }
            }
        }
    }

    awaitingInput.delete(chatId);
    await showMainMenu(chatId);
});

// ====== ПОИСК (с реальной проверкой занятости) ======
async function performSearch(chatId, messageId, length) {
    if (await isBanned(chatId)) {
        await bot.editMessageText('❌ Вы забанены!', { chat_id: chatId, message_id: messageId });
        return;
    }
    await ensureDailyReset(chatId);
    const unlimited = await isUnlimited(chatId);
    if (!unlimited && length < 6) {
        await bot.editMessageText('❌ Для поиска 5 букв нужен премиум!', { chat_id: chatId, message_id: messageId });
        return;
    }
    const searches = await getSearches(chatId);
    if (searches <= 0 && !isAdmin(chatId)) {
        await bot.editMessageText('❌ Закончились поиски! Пополни через 💎 Премиум.', { chat_id: chatId, message_id: messageId });
        return;
    }
    if (!isAdmin(chatId)) await updateSearches(chatId, -1);

    const candidates = generateFakeUsernames(length, 40);

    if (!mtReady || length < 5) {
        // Без MTProto (или длина < 5, для которой Telegram не разрешает проверку) —
        // отдаём сгенерированные варианты без гарантии, что они свободны.
        await bot.editMessageText('⏳ Генерирую юзернеймы...', { chat_id: chatId, message_id: messageId });
        const usernames = candidates.slice(0, 25);
        let text = `🔍 Сгенерировано ${usernames.length} юзернеймов (${length} букв):\n⚠️ Реальная проверка занятости недоступна — это только варианты, не гарантия свободности.\n\n`;
        usernames.forEach((u, i) => text += `${i + 1}. @${u}\n`);
        const buttons = { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu' }]] } };
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...buttons });
        return;
    }

    await bot.editMessageText('⏳ Проверяю доступность (это может занять до минуты)...', { chat_id: chatId, message_id: messageId });

    const confirmed = [];
    const maxToCheck = 20;
    let checked = 0;
    for (const u of candidates) {
        if (checked >= maxToCheck || confirmed.length >= 10) break;
        const available = await checkUsernameAvailable(u);
        checked++;
        if (available === true) confirmed.push(u);
        if (checked % 5 === 0) {
            try {
                await bot.editMessageText(`⏳ Проверено ${checked}/${maxToCheck}, найдено свободных: ${confirmed.length}...`, { chat_id: chatId, message_id: messageId });
            } catch (e) { /* сообщение могло не измениться — игнорируем */ }
        }
    }

    if (confirmed.length === 0) {
        await bot.editMessageText('❌ Не нашлось свободных юзернеймов среди проверенных вариантов. Попробуй ещё раз.', {
            chat_id: chatId, message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu' }]] }
        });
        return;
    }

    const now = new Date().toISOString();
    for (const u of confirmed) {
        await db.run('INSERT INTO search_history (user_id, username, created_at) VALUES (?, ?, ?)', chatId, u, now);
    }

    let text = `✅ Найдено ${confirmed.length} реально свободных юзернеймов (${length} букв):\n\n`;
    confirmed.forEach((u, i) => text += `${i + 1}. @${u}\n`);
    const buttons = { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu' }]] } };
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...buttons });
}

// ====== ОБРАБОТКА ТЕКСТОВОГО ВВОДА (по состояниям) ======
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.text || msg.text.startsWith('/')) return;

    const state = awaitingInput.get(chatId);
    if (!state) return;

    awaitingInput.delete(chatId);

    if (state.type === 'search_custom') {
        const length = parseInt(msg.text, 10);
        if (isNaN(length) || length < 3 || length > 15) {
            await bot.sendMessage(chatId, '❌ Введи число от 3 до 15!');
            return;
        }
        const unlimited = await isUnlimited(chatId);
        if (!unlimited && length < 6) {
            await bot.sendMessage(chatId, '❌ Для поиска 5 букв нужен премиум!');
            return;
        }
        await performSearch(chatId, state.messageId, length);
        return;
    }

    if (state.type === 'rate') {
        const username = msg.text.trim();
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            await bot.sendMessage(chatId, '❌ Некорректный юзернейм');
            return;
        }
        const { score, feedback } = rateUsername(username);
        let text = `⭐ @${username}\nОценка: ${score}/10\n\n`;
        feedback.forEach((f) => text += f + '\n');
        const buttons = { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu' }]] } };
        await bot.sendMessage(chatId, text, buttons);
        return;
    }

    if (!isAdmin(chatId)) return;

    if (state.type === 'admin_give') {
        const parts = msg.text.trim().split(/\s+/);
        if (parts.length !== 2) {
            await bot.sendMessage(chatId, '❌ Формат: `ID количество`', { parse_mode: 'Markdown' });
            return;
        }
        const targetId = parseInt(parts[0], 10);
        const amount = parseInt(parts[1], 10);
        if (isNaN(targetId) || isNaN(amount)) {
            await bot.sendMessage(chatId, '❌ Введи числа!');
            return;
        }
        await createUser(targetId);
        await updateSearches(targetId, amount);
        await bot.sendMessage(chatId, `✅ Выдано ${amount} поисков пользователю \`${targetId}\``, { parse_mode: 'Markdown' });
        return;
    }

    if (state.type === 'admin_give_premium') {
        const targetId = parseInt(
