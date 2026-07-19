const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const http = require('http');

// ====== КОНФИГ ======
const BOT_TOKEN = '8970650072:AAE1biI5pH5rldCM07JtBmrP791YKVbMZOA';
const ADMIN_ID = 8701969979;

// ====== БОТ ======
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('🚀 Бот запущен!');

// ====== КЕПАЛАЙВ ======
setInterval(() => {
    bot.getMe().then(() => {
        console.log('✅ Бот активен');
    }).catch(() => {
        console.log('❌ Бот отключён, перезапуск...');
        process.exit(1);
    });
}, 300000);

bot.on('error', (error) => {
    console.error('Ошибка бота:', error);
    if (error.code === 409) process.exit(1);
});

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// ====== HEALTH CHECK ======
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running');
});
server.listen(process.env.PORT || 10000, () => {
    console.log(`✅ Health check server running on port ${process.env.PORT || 10000}`);
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

// ====== ГЕНЕРАЦИЯ ЮЗЕРНЕЙМОВ ======
function generateFakeUsernames(length) {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const exclude = 'il1o0';
    const available = letters.split('').filter(c => !exclude.includes(c)).join('');
    const usernames = new Set();
    while (usernames.size < 25) {
        let username = '';
        for (let i = 0; i < length; i++) {
            const idx = Math.floor(Math.random() * available.length);
            username += available[idx];
        }
        usernames.add(username);
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
    const searches = await isUnlimited(chatId) ? '∞' : await getSearches(chatId);
    const ratings = await getRatings(chatId);
    const text = `👋 Привет!\n\n🔍 Поиски: ${searches}\n⭐ Оценки: ${ratings}/5`;
    const buttons = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔍 5 букв', callback_data: 'search_5' }],
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
    await showMainMenu(chatId);
});

// ====== ПОИСК ======
async function performSearch(chatId, messageId, length) {
    if (await isBanned(chatId)) {
        await bot.editMessageText('❌ Вы забанены!', { chat_id: chatId, message_id: messageId });
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
        await showMainMenu(chatId, messageId);
        return;
    }

    if (data === 'search_5') {
        await performSearch(chatId, messageId, 5);
        return;
    }

    if (data === 'search_custom') {
        await bot.editMessageText('✍️ Введите длину (3-15):', { chat_id: chatId, message_id: messageId });
        bot.once('message', async (msg) => {
            if (msg.chat.id !== chatId) return;
            const length = parseInt(msg.text);
            if (isNaN(length) || length < 3 || length > 15) {
                await bot.sendMessage(chatId, '❌ Введи число от 3 до 15!');
                return;
            }
            await performSearch(chatId, messageId, length);
        });
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
        bot.once('message', async (msg) => {
            if (msg.chat.id !== chatId) return;
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
        });
        return;
    }

    if (data === 'premium') {
        const invoice = {
            chat_id: chatId,
            title: '⭐ Премиум доступ',
            description: 'Бесконечные поиски и оценки навсегда',
            payload: `premium_${chatId}`,
            provider_token: '',
            currency: 'XTR',
            prices: [{ label: '⭐ Премиум', amount: 50 }],
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⭐ Оплатить 50 звёзд', pay: true }]
                ]
            }
        };
        await bot.sendInvoice(
            invoice.chat_id,
            invoice.title,
            invoice.description,
            invoice.payload,
            invoice.provider_token,
            null,
            invoice.currency,
            invoice.prices,
            invoice.reply_markup
        );
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
                    [{ text: '🚫 Бан по ID', callback_data: 'admin_ban' }],
                    [{ text: '✅ Разбан по ID', callback_data: 'admin_unban' }],
                    [{ text: '📋 Список пользователей', callback_data: 'admin_list' }],
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
        bot.once('message', async (msg) => {
            if (msg.chat.id !== chatId) return;
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
        });
        return;
    }

    if (data === 'admin_ban') {
        if (!isAdmin(chatId)) return;
        await bot.editMessageText('✍️ Введите ID пользователя для бана:', { chat_id: chatId, message_id: messageId });
        bot.once('message', async (msg) => {
            if (msg.chat.id !== chatId) return;
            const targetId = parseInt(msg.text.trim());
            if (isNaN(targetId)) {
                await bot.sendMessage(chatId, '❌ Введи число!');
                return;
            }
            await createUser(targetId);
            await banUser(targetId);
            await bot.sendMessage(chatId, `✅ Пользователь \`${targetId}\` заблокирован`, { parse_mode: 'Markdown' });
        });
        return;
    }

    if (data === 'admin_unban') {
        if (!isAdmin(chatId)) return;
        await bot.editMessageText('✍️ Введите ID пользователя для разбана:', { chat_id: chatId, message_id: messageId });
        bot.once('message', async (msg) => {
            if (msg.chat.id !== chatId) return;
            const targetId = parseInt(msg.text.trim());
            if (isNaN(targetId)) {
                await bot.sendMessage(chatId, '❌ Введи число!');
                return;
            }
            await unbanUser(targetId);
            await bot.sendMessage(chatId, `✅ Пользователь \`${targetId}\` разблокирован`, { parse_mode: 'Markdown' });
        });
        return;
    }

    if (data === 'admin_list') {
        if (!isAdmin(chatId)) return;
        const users = await db.all('SELECT user_id, username FROM users');
        let text = '📋 Пользователи бота:\n';
        users.forEach(u => {
            text += `\`${u.user_id}\` — @${u.username || '—'}\n`;
        });
        const buttons = { reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'admin' }]] } };
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...buttons });
        return;
    }
});

// ====== ПЛАТЕЖИ ======
bot.on('pre_checkout_query', (query) => {
    bot.answerPreCheckoutQuery(query.id, true);
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

console.log('🚀 Бот запущен!');