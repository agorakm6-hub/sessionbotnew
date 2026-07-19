import logging
import re
import requests
from telethon import TelegramClient, functions
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, MessageHandler, filters, ContextTypes

logging.basicConfig(level=logging.INFO)

BOT_TOKEN = "8895080427:AAE02i4cD0NeWVOShOC6btza4PMitpJxgk8"
API_ID = 39328144
API_HASH = "b4c02b2f6297f1b61d3073fd50629711"

user_sessions = {}
user_states = {}

async def get_client(user_id):
    if user_id in user_sessions:
        cl = user_sessions[user_id]
        if cl.is_connected():
            return cl
        try:
            await cl.connect()
            return cl
        except Exception:
            del user_sessions[user_id]
            return None
    return None

async def kill_client(user_id):
    if user_id in user_sessions:
        try:
            await user_sessions[user_id].disconnect()
        except Exception:
            pass
        del user_sessions[user_id]

def parse_users(text):
    return re.findall(r'@\w+', text)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    if await get_client(uid):
        await show_menu(update, context)
    else:
        kb = [
            [InlineKeyboardButton("🔑 Войти", callback_data="login")],
            [InlineKeyboardButton("🆕 Новый аккаунт", callback_data="new")]
        ]
        await update.message.reply_text("👋 Привет! Войди в аккаунт:", reply_markup=InlineKeyboardMarkup(kb))

async def show_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    kb = [
        [InlineKeyboardButton("🗑 Удалить аккаунт", callback_data="del")],
        [InlineKeyboardButton("📤 Отправить сообщение", callback_data="send")],
        [InlineKeyboardButton("📖 Читать сообщения", callback_data="read")],
        [InlineKeyboardButton("📢 Мои каналы", callback_data="channels")],
        [InlineKeyboardButton("👥 Контакты", callback_data="contacts")],
        [InlineKeyboardButton("⭐ Баланс звёзд", callback_data="stars")],
        [InlineKeyboardButton("🔄 Зеркало бота", callback_data="mirror")],
        [InlineKeyboardButton("🚪 Выйти", callback_data="logout")]
    ]
    if update.callback_query:
        await update.callback_query.edit_message_text("📱 Меню:", reply_markup=InlineKeyboardMarkup(kb))
    else:
        await update.message.reply_text("📱 Меню:", reply_markup=InlineKeyboardMarkup(kb))

async def button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    uid = update.effective_user.id
    data = q.data

    if data == "login":
        user_states[uid] = 'awaiting_session'
        await q.edit_message_text("🔑 Отправь session string:")

    elif data == "new":
        await q.edit_message_text("🆕 Создай аккаунт в Telegram, потом войди через /start")

    elif data == "del":
        cl = await get_client(uid)
        if not cl:
            await q.edit_message_text("❌ Нет сессии")
            return
        try:
            await cl(functions.account.DeleteAccountRequest(reason="Удаление"))
            await kill_client(uid)
            await q.edit_message_text("✅ Аккаунт удалён")
        except Exception as e:
            await q.edit_message_text(f"❌ Ошибка: {e}")

    elif data == "send":
        user_states[uid] = 'awaiting_message'
        await q.edit_message_text("📤 Введи: @user1 @user2 Текст сообщения")

    elif data == "read":
        cl = await get_client(uid)
        if not cl:
            await q.edit_message_text("❌ Нет сессии")
            return
        try:
            dialogs = await cl.get_dialogs(limit=10)
            if not dialogs:
                await q.edit_message_text("📭 Нет диалогов")
                return
            out = "📖 Последние диалоги:\n\n"
            for d in dialogs:
                out += f"• {d.name}\n"
                msgs = await cl.get_messages(d.id, limit=2)
                for m in msgs:
                    txt = m.text[:40] if m.text else "[медиа]"
                    out += f"  └ {txt}\n"
                out += "\n"
            await q.edit_message_text(out[:4000])
        except Exception as e:
            await q.edit_message_text(f"❌ Ошибка: {e}")

    elif data == "channels":
        cl = await get_client(uid)
        if not cl:
            await q.edit_message_text("❌ Нет сессии")
            return
        try:
            dialogs = await cl.get_dialogs()
            chs = [d for d in dialogs if d.is_channel and d.entity.creator]
            if not chs:
                await q.edit_message_text("📢 Нет созданных каналов")
                return
            out = "📢 Твои каналы:\n"
            for c in chs:
                link = f"t.me/{c.entity.username}" if c.entity.username else "без ссылки"
                out += f"• {c.name} — {link}\n"
            await q.edit_message_text(out)
        except Exception as e:
            await q.edit_message_text(f"❌ Ошибка: {e}")

    elif data == "contacts":
        cl = await get_client(uid)
        if not cl:
            await q.edit_message_text("❌ Нет сессии")
            return
        try:
            contacts = await cl.get_contacts()
            if not contacts:
                await q.edit_message_text("👥 Нет контактов")
                return
            out = "👥 Контакты:\n"
            for c in contacts[:20]:
                name = f"{c.first_name or ''} {c.last_name or ''}".strip() or "Без имени"
                out += f"• {name} | @{c.username or 'нет'} | ID: {c.id}\n"
            await q.edit_message_text(out[:4000])
        except Exception as e:
            await q.edit_message_text(f"❌ Ошибка: {e}")

    elif data == "stars":
        cl = await get_client(uid)
        if not cl:
            await q.edit_message_text("❌ Нет сессии")
            return
        try:
            me = await cl.get_me()
            stars = getattr(me, 'stars', 0)
            await q.edit_message_text(f"⭐ Баланс звёзд: {stars}")
        except Exception as e:
            await q.edit_message_text(f"❌ Ошибка: {e}")

    elif data == "mirror":
        user_states[uid] = 'awaiting_mirror'
        await q.edit_message_text("🔄 Отправь токен нового бота:")

    elif data == "logout":
        await kill_client(uid)
        if uid in user_states:
            del user_states[uid]
        await q.edit_message_text("🚪 Вышел. Используй /start для входа")

async def message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    text = update.message.text
    state = user_states.get(uid)

    if not text:
        return

    if state == 'awaiting_session':
        try:
            cl = TelegramClient(f"sess_{uid}", API_ID, API_HASH)
            await cl.start(session_string=text)
            await cl.get_me()
            user_sessions[uid] = cl
            if uid in user_states:
                del user_states[uid]
            await update.message.reply_text("✅ Вход выполнен!")
            await show_menu(update, context)
        except Exception as e:
            await update.message.reply_text(f"❌ Сессия невалидна: {e}")

    elif state == 'awaiting_message':
        cl = await get_client(uid)
        if not cl:
            await update.message.reply_text("❌ Нет сессии")
            return
        parts = text.split(maxsplit=1)
        if len(parts) < 2:
            await update.message.reply_text("❌ Формат: @user1 @user2 Текст")
            return
        usernames = parse_users(parts[0])
        msg_text = parts[1]
        if not usernames:
            await update.message.reply_text("❌ Нет юзернеймов")
            return
        sent = 0
        for u in usernames:
            try:
                entity = await cl.get_entity(u)
                await cl.send_message(entity, msg_text)
                sent += 1
            except Exception:
                pass
        await update.message.reply_text(f"✅ Отправлено {sent} из {len(usernames)}")
        if uid in user_states:
            del user_states[uid]
        await show_menu(update, context)

    elif state == 'awaiting_mirror':
        try:
            resp = requests.get(f"https://api.telegram.org/bot{text}/getMe", timeout=5)
            if resp.status_code == 200 and resp.json().get("ok"):
                await update.message.reply_text(f"✅ Токен валиден! Бот: @{resp.json()['result']['username']}\n\n⚠️ Для зеркала нужен отдельный сервер с этим же кодом.")
            else:
                await update.message.reply_text("❌ Токен недействителен")
        except Exception:
            await update.message.reply_text("❌ Ошибка проверки токена")
        if uid in user_states:
            del user_states[uid]
        await show_menu(update, context)

    else:
        await update.message.reply_text("❓ Используй /start")

async def main():
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(button))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, message))
    print("✅ Бот запущен!")
    await app.run_polling()

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())