const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const http = require('http');

// ====== КОНФИГ ======
// Токен теперь берём из переменной окружения BOT_TOKEN.
// Для локального теста можно временно оставить запасной токен ниже,
// но как только вставишь рабочий — убери тестовый токен из кода вообще
// и запускай бота так: BOT_TOKEN=твой_токен node bot.js
const BOT_TOKEN = process.env.BOT_TOKEN || '8970650072:AAE1biI5pH5rldCM07JtBmrP791YKVbMZOA';
const ADMIN_ID = 8701969979;
const PREMIUM_PRICE = 25; // цена премиума в звёздах — меняешь только тут

// ====== БОТ (WEBHOOK-РЕЖИМ) ======
// Render автоматически даёт переменную RENDER_EXTERNAL_URL — публичный адрес сервиса.
// Локально её не будет, поэтому можно задать WEBHOOK_URL вручную при желании.
const PORT = process.env.PORT || 10000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`; // секретный путь — знает только Telegram

if (!EXTERNAL_URL) {
    console.error('❌ Не найден RENDER_EXTERNAL_URL или WEBHOOK_URL. На Render эта переменная должна быть доступна автоматически — если её нет, задай WEBHOOK_URL вручную в Environment.');
    process.exit(1);
}

// polling выключен — обновления приходят через HTTP-запрос от Telegram
const bot = new TelegramBot(BOT_TOKEN, { webHook: false });
console.log('🚀 Бот запущен в режиме webhook!');

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// ====== HTTP-СЕРВЕР: health check + приём апдейтов от Telegram ======
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

    // health check для Render
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

// ====== БАЗА ДАННЫХ ======
let db;
async function initDb() {
    db = await open({
        filename: './username.db',
        driver: sqlite3.Database
    });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            searches INTEGER DEFAULT 5,
            ratings INTEGER DEFAULT 5,
            unlimited BOOLEAN DEFAULT 0,
            last_reset TEXT DEFAULT NULL,
            banned INTEGER DEFAULT 0
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
    const row = await db.get('SELECT unlimited FROM users WHERE user_id = ?', userId);
    return row && row.unlimited === 1;
}
async function setUnlimited(userId) {
    await db.run('UPDATE users SET unlimited = 1 WHERE user_id = ?', userId);
}
async function resetDaily(userId) {
    await db.run('UPDATE users SET searches = 5, ratings = 5 WHERE user_id = ?', userId);
}
function isAdmin(userId) {
    return Number(userId) === Number(ADMIN_ID);
}

// ====== СОСТОЯНИЯ ОЖИДАНИЯ ВВОДА ======
// Заменяет ненадёжные bot.once('message', ...), которые ловили
// следующее сообщение от ЛЮБОГО пользователя, а не только нужного.
// Теперь у каждого chatId своё состояние в памяти.
const awaitingInput = new Map(); // chatId -> { type, messageId }

// ====== ГЕНЕРАЦИЯ ЮЗЕРНЕЙМОВ ======
function generateFakeUsernames(length) {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const exclude = 'il1o0';
    const available = letters.split('').filter(c => !exclude.includes(c)).join('');
    const usernames = new Set();
    let attempts = 0;
    while (usernames.size < 25 && attempts < 10000) {
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
    const unlimited = await isUnlimited(chatId);
    const searches = unlimited ? '∞' : await getSearches(chatId);
    const ratings = await getRatings(chatId);
    const text = `👋 Привет!\n\n🔍 Поиски: ${searches}\n⭐ Оценки: ${ratings}/5\n${unlimited ? '⭐ Премиум активен!' : ''}`;
    const buttons = {
        reply_markup: {
            inline_keyboard: [
                [{ text: unlimited ? '🔍 5 букв' : '🔍 6+ букв', callback_data: 'search' }],
                [{ text: '🎯 Своё число', callback_data: 'search_custom' }],
                [{ text: '⭐ Оценить юзернейм', callback_data: 'rate' }],
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

// ====== СТАРТ ======
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await createUser(chatId);
    awaitingInput.delete(chatId);
    await showMainMenu(chatId);
});

// ====== ПОИСК ======
async function performSearch(chatId, messageId, length) {
    if (await isBanned(chatId)) {
        await bot.editMessageText('❌ Вы забанены!', { chat_id: chatId, message_id: messageId });
        return;
    }
    const unlimited = await isUnlimited(chatId);
    if (!unlimited && length < 6) {
        await bot.editMessageText('❌ Для поиска 5 букв нужен премиум!', { chat_id: chatId, message_id: messageId });
        return;
    }
    const searches = await getSearches(chatId);
    if (searches <= 0 && !isAdmin(chatId)) {
        await bot.editMessageText('❌ Закончились поиски!', { chat_id: chatId, message_id: messageId });
        return;
    }
    if (!isAdmin(chatId)) await updateSearches(chatId, -1);
    await bot.editMessageText('⏳ Генерирую юзернеймы...', { chat_id: chatId, message_id: messageId });
    const usernames = generateFakeUsernames(length);
    if (usernames.length === 0) {
        await bot.editMessageText('❌ Свободных юзернеймов не найдено.', { chat_id: chatId, message_id: messageId });
        return;
    }
    let text = `🔍 Найдено ${usernames.length} юзернеймов (${length} букв):\n\n`;
    usernames.forEach((u, i) => text += `${i+1}. @${u}\n`);
    const buttons = { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu' }]] } };
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...buttons });
}

// ====== ОБРАБОТКА ТЕКСТОВОГО ВВОДА (по состояниям) ======
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.text || msg.text.startsWith('/')) return;

    const state = awaitingInput.get(chatId);
    if (!state) return; // сообщение вне контекста ожидания — игнорируем

    awaitingInput.delete(chatId); // сразу снимаем состояние, чтобы не сработало дважды

    if (state.type === 'search_custom') {
        const length = parseInt(msg.text);
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
        feedback.forEach(f => text += f + '\n');
        const buttons = { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'menu' }]] } };
        await bot.sendMessage(chatId, text, buttons);
        return;
    }

    if (!isAdmin(chatId)) return; // остальные состояния — только для админа

    if (state.type === 'admin_give') {
        const parts = msg.text.trim().split(/\s+/);
        if (parts.length !== 2) {
            await bot.sendMessage(chatId, '❌ Формат: `ID количество`', { parse_mode: 'Markdown' });
            return;
        }
        const targetId = parseInt(parts[0]);
        const amount = parseInt(parts[1]);
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
        const targetId = parseInt(msg.text.trim());
        if (isNaN(targetId)) {
            await bot.sendMessage(chatId, '❌ Введи число!');
            return;
        }
        await createUser(targetId);
        await setUnlimited(targetId);
        await bot.sendMessage(chatId, `✅ Премиум выдан пользователю \`${targetId}\``, { parse_mode: 'Markdown' });
        return;
    }

    if (state.type === 'admin_ban') {
        const targetId = parseInt(msg.text.trim());
        if (isNaN(targetId)) {
            await bot.sendMessage(chatId, '❌ Введи число!');
            return;
        }
        await createUser(targetId);
        await banUser(targetId);
        await bot.sendMessage(chatId, `✅ Пользователь \`${targetId}\` заблокирован`, { parse_mode: 'Markdown' });
        return;
    }

    if (state.type === 'admin_unban') {
        const targetId = parseInt(msg.text.trim());
        if (isNaN(targetId)) {
            await bot.sendMessage(chatId, '❌ Введи число!');
            return;
        }
        await unbanUser(targetId);
        await bot.sendMessage(chatId, `✅ Пользователь \`${targetId}\` разблокирован`, { parse_mode: 'Markdown' });
        return;
    }
});

// ====== КНОПКИ ======
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    await bot.answerCallbackQuery(query.id);

    if (await isBanned(chatId)) {
        await bot.editMessageText('❌ Вы забанены!', { chat_id: chatId, message_id: messageId });
        return;
    }

    if (data === 'menu') {
        awaitingInput.delete(chatId);
        await showMainMenu(chatId, messageId);
        return;
    }

    if (data === 'search') {
        const unlimited = await isUnlimited(chatId);
        const length = unlimited ? 5 : 7;
        await performSearch(chatId, messageId, length);
        return;
    }

    if (data === 'search_custom') {
        await bot.editMessageText('✍️ Введите длину (3-15):', { chat_id: chatId, message_id: messageId });
        awaitingInput.set(chatId, { type: 'search_custom', messageId });
        return;
    }

    if (data === 'rate') {
        const ratings = await getRatings(chatId);
        if (ratings <= 0 && !isAdmin(chatId)) {
            await bot.editMessageText('❌ Закончились оценки!', { chat_id: chatId, message_id: messageId });
            return;
        }
        if (!isAdmin(chatId)) await updateRatings(chatId, -1);
        await bot.editMessageText('✍️ Напиши юзернейм для оценки (без @):', { chat_id: chatId, message_id: messageId });
        awaitingInput.set(chatId, { type: 'rate', messageId });
        return;
    }

    // ====== ПРЕМИУМ (ПЛАТЁЖ ЗВЁЗДАМИ) ======
    if (data === 'premium') {
        try {
            await bot.sendInvoice(
                chatId,
                '⭐ Премиум доступ',
                'Бесконечные поиски и поиск 5 букв навсегда',
                `premium_${chatId}`,
                '', // provider_token — для Stars всегда пусто
                'XTR',
                [{ label: '⭐ Премиум', amount: PREMIUM_PRICE }],
                {
                    reply_markup: {
                        inline_keyboard: [[{ text: `⭐ Оплатить ${PREMIUM_PRICE} звёзд`, pay: true }]]
                    }
                }
            );
        } catch (error) {
            console.error('Invoice error:', error);
            await bot.sendMessage(chatId, '❌ Ошибка при создании платежа. Попробуй позже.');
        }
        return;
    }

    if (data === 'admin') {
        if (!isAdmin(chatId)) {
            await bot.answerCallbackQuery(query.id, { text: '❌ Ты не админ!', show_alert: true });
            return;
        }
        const buttons = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🎁 Выдать поиски', callback_data: 'admin_give' }],
                    [{ text: '🎁 Выдать премиум', callback_data: 'admin_give_premium' }],
                    [{ text: '🚫 Бан по ID', callback_data: 'admin_ban' }],
                    [{ text: '✅ Разбан по ID', callback_data: 'admin_unban' }],
                    [{ text: '📋 Список пользователей', callback_data: 'admin_list_0' }],
                    [{ text: '◀️ Назад', callback_data: 'menu' }]
                ]
            }
        };
        await bot.editMessageText('👑 Админ-панель', { chat_id: chatId, message_id: messageId, ...buttons });
        return;
    }

    if (data === 'admin_give') {
        if (!isAdmin(chatId)) return;
        await bot.editMessageText('✍️ Введите: ID количество\n\nПример: `123456789 10`', {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown'
        });
        awaitingInput.set(chatId, { type: 'admin_give', messageId });
        return;
    }

    if (data === 'admin_give_premium') {
        if (!isAdmin(chatId)) return;
        await bot.editMessageText('✍️ Введите ID пользователя для выдачи премиума:', { chat_id: chatId, message_id: messageId });
        awaitingInput.set(chatId, { type: 'admin_give_premium', messageId });
        return;
    }

    if (data === 'admin_ban') {
        if (!isAdmin(chatId)) return;
        await bot.editMessageText('✍️ Введите ID пользователя для бана:', { chat_id: chatId, message_id: messageId });
        awaitingInput.set(chatId, { type: 'admin_ban', messageId });
        return;
    }

    if (data === 'admin_unban') {
        if (!isAdmin(chatId)) return;
        await bot.editMessageText('✍️ Введите ID пользователя для разбана:', { chat_id: chatId, message_id: messageId });
        awaitingInput.set(chatId, { type: 'admin_unban', messageId });
        return;
    }

    // ====== СПИСОК ПОЛЬЗОВАТЕЛЕЙ С ПАГИНАЦИЕЙ ======
    if (data.startsWith('admin_list_')) {
        if (!isAdmin(chatId)) return;
        const page = parseInt(data.split('_')[2]) || 0;
        const pageSize = 20;
        const users = await db.all(
            'SELECT user_id, username FROM users ORDER BY user_id LIMIT ? OFFSET ?',
            pageSize + 1, // берём на 1 больше, чтобы понять, есть ли следующая страница
            page * pageSize
        );
        const hasNext = users.length > pageSize;
        const pageUsers = users.slice(0, pageSize);

        let text = `📋 Пользователи (стр. ${page + 1}):\n`;
        pageUsers.forEach(u => {
            text += `\`${u.user_id}\` — @${u.username || '—'}\n`;
        });

        const navRow = [];
        if (page > 0) navRow.push({ text: '◀️ Пред.', callback_data: `admin_list_${page - 1}` });
        if (hasNext) navRow.push({ text: 'След. ▶️', callback_data: `admin_list_${page + 1}` });

        const keyboard = [];
        if (navRow.length) keyboard.push(navRow);
        keyboard.push([{ text: '◀️ Назад', callback_data: 'admin' }]);

        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
        return;
    }
});

// ====== ПЛАТЕЖИ ======
bot.on('pre_checkout_query', async (query) => {
    try {
        await bot.answerPreCheckoutQuery(query.id, true);
    } catch (error) {
        console.error('pre_checkout_query error:', error);
    }
});

bot.on('successful_payment', async (msg) => {
    const chatId = msg.chat.id;
    const payload = msg.successful_payment.invoice_payload;
    if (payload && payload.startsWith('premium_')) {
        const userId = parseInt(payload.split('_')[1]);
        if (!isNaN(userId)) {
            await createUser(userId);
            await setUnlimited(userId);
            await bot.sendMessage(chatId, '✅ **Премиум активирован!** 🎉', { parse_mode: 'Markdown' });
        }
    }
});
