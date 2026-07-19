from flask import Flask, request
import requests
import json
import re
from pyrogram import Client
from pyrogram.raw import functions

app = Flask(__name__)

BOT_TOKEN = "8895080427:AAE02i4cD0NeWVOShOC6btza4PMitpJxgk8"
API_ID = 39328144
API_HASH = "b4c02b2f6297f1b61d3073fd50629711"
WEBHOOK_URL = "https://sessionbotnew-1.onrender.com/webhook"

user_sessions = {}
user_states = {}

def send_message(chat_id, text, reply_markup=None):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {"chat_id": chat_id, "text": text}
    if reply_markup:
        payload["reply_markup"] = json.dumps(reply_markup)
    requests.post(url, json=payload)

def edit_message(chat_id, message_id, text, reply_markup=None):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/editMessageText"
    payload = {"chat_id": chat_id, "message_id": message_id, "text": text}
    if reply_markup:
        payload["reply_markup"] = json.dumps(reply_markup)
    requests.post(url, json=payload)

def answer_callback(callback_id, text=None):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/answerCallbackQuery"
    payload = {"callback_query_id": callback_id}
    if text:
        payload["text"] = text
    requests.post(url, json=payload)

def get_client(user_id):
    return user_sessions.get(user_id)

def kill_client(user_id):
    if user_id in user_sessions:
        try:
            user_sessions[user_id].stop()
        except:
            pass
        del user_sessions[user_id]

def parse_users(text):
    return re.findall(r'@\w+', text)

def show_menu(chat_id, message_id=None):
    keyboard = {
        "inline_keyboard": [
            [{"text": "🗑 Удалить аккаунт", "callback_data": "del"}],
            [{"text": "📤 Отправить сообщение", "callback_data": "send"}],
            [{"text": "📖 Читать сообщения", "callback_data": "read"}],
            [{"text": "📢 Мои каналы", "callback_data": "channels"}],
            [{"text": "👥 Контакты", "callback_data": "contacts"}],
            [{"text": "⭐ Баланс звёзд", "callback_data": "stars"}],
            [{"text": "🚪 Выйти", "callback_data": "logout"}]
        ]
    }
    if message_id:
        edit_message(chat_id, message_id, "📱 Меню:", keyboard)
    else:
        send_message(chat_id, "📱 Меню:", keyboard)

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.get_json()
    if not data:
        return "OK", 200

    if 'message' in data:
        msg = data['message']
        chat_id = msg['chat']['id']
        text = msg.get('text', '')
        user_id = msg['from']['id']

        if text == '/start':
            if get_client(user_id):
                show_menu(chat_id)
            else:
                keyboard = {
                    "inline_keyboard": [
                        [{"text": "🔑 Войти", "callback_data": "login"}],
                        [{"text": "🆕 Новый аккаунт", "callback_data": "new"}]
                    ]
                }
                send_message(chat_id, "👋 Привет! Войди в аккаунт:", keyboard)
        
        elif user_id in user_states and user_states[user_id] == 'awaiting_session':
            try:
                # СОЗДАЁМ КЛИЕНТ PYROGRAM
                client = Client(
                    f"sess_{user_id}",
                    api_id=API_ID,
                    api_hash=API_HASH,
                    session_string=text,
                    in_memory=True
                )
                client.start()
                client.get_me()
                user_sessions[user_id] = client
                del user_states[user_id]
                send_message(chat_id, "✅ Вход выполнен!")
                show_menu(chat_id)
            except Exception as e:
                send_message(chat_id, f"❌ Сессия невалидна: {e}")

        elif user_id in user_states and user_states[user_id] == 'awaiting_message':
            client = get_client(user_id)
            if not client:
                send_message(chat_id, "❌ Нет сессии")
                return "OK", 200
            parts = text.split(maxsplit=1)
            if len(parts) < 2:
                send_message(chat_id, "❌ Формат: @user1 @user2 Текст")
                return "OK", 200
            usernames = parse_users(parts[0])
            msg_text = parts[1]
            if not usernames:
                send_message(chat_id, "❌ Нет юзернеймов")
                return "OK", 200
            sent = 0
            for u in usernames:
                try:
                    entity = client.get_users(u)
                    client.send_message(entity.id, msg_text)
                    sent += 1
                except:
                    pass
            send_message(chat_id, f"✅ Отправлено {sent} из {len(usernames)}")
            del user_states[user_id]
            show_menu(chat_id)

    elif 'callback_query' in data:
        query = data['callback_query']
        callback_id = query['id']
        chat_id = query['message']['chat']['id']
        message_id = query['message']['message_id']
        user_id = query['from']['id']
        data_cb = query['data']

        answer_callback(callback_id)

        if data_cb == "login":
            user_states[user_id] = 'awaiting_session'
            edit_message(chat_id, message_id, "🔑 Отправь session string:")

        elif data_cb == "new":
            edit_message(chat_id, message_id, "🆕 Создай аккаунт в Telegram, потом войди через /start")

        elif data_cb == "del":
            client = get_client(user_id)
            if not client:
                edit_message(chat_id, message_id, "❌ Нет сессии")
                return "OK", 200
            try:
                client.invoke(functions.account.DeleteAccountRequest(reason="Удаление"))
                kill_client(user_id)
                edit_message(chat_id, message_id, "✅ Аккаунт удалён")
            except Exception as e:
                edit_message(chat_id, message_id, f"❌ Ошибка: {e}")

        elif data_cb == "send":
            user_states[user_id] = 'awaiting_message'
            edit_message(chat_id, message_id, "📤 Введи: @user1 @user2 Текст сообщения")

        elif data_cb == "read":
            client = get_client(user_id)
            if not client:
                edit_message(chat_id, message_id, "❌ Нет сессии")
                return "OK", 200
            try:
                dialogs = client.get_dialogs(limit=10)
                if not dialogs:
                    edit_message(chat_id, message_id, "📭 Нет диалогов")
                    return "OK", 200
                out = "📖 Последние диалоги:\n\n"
                for d in dialogs:
                    out += f"• {d.title}\n"
                    msgs = client.get_messages(d.id, limit=2)
                    for m in msgs:
                        txt = m.text[:40] if m.text else "[медиа]"
                        out += f"  └ {txt}\n"
                    out += "\n"
                edit_message(chat_id, message_id, out[:4000])
            except Exception as e:
                edit_message(chat_id, message_id, f"❌ Ошибка: {e}")

        elif data_cb == "channels":
            client = get_client(user_id)
            if not client:
                edit_message(chat_id, message_id, "❌ Нет сессии")
                return "OK", 200
            try:
                dialogs = client.get_dialogs()
                chs = [d for d in dialogs if d.chat.type == "channel" and d.chat.is_creator]
                if not chs:
                    edit_message(chat_id, message_id, "📢 Нет созданных каналов")
                    return "OK", 200
                out = "📢 Твои каналы:\n"
                for c in chs:
                    link = f"t.me/{c.chat.username}" if c.chat.username else "без ссылки"
                    out += f"• {c.title} — {link}\n"
                edit_message(chat_id, message_id, out)
            except Exception as e:
                edit_message(chat_id, message_id, f"❌ Ошибка: {e}")

        elif data_cb == "contacts":
            client = get_client(user_id)
            if not client:
                edit_message(chat_id, message_id, "❌ Нет сессии")
                return "OK", 200
            try:
                contacts = client.get_contacts()
                if not contacts:
                    edit_message(chat_id, message_id, "👥 Нет контактов")
                    return "OK", 200
                out = "👥 Контакты:\n"
                for c in contacts[:20]:
                    name = f"{c.first_name or ''} {c.last_name or ''}".strip() or "Без имени"
                    out += f"• {name} | @{c.username or 'нет'} | ID: {c.id}\n"
                edit_message(chat_id, message_id, out[:4000])
            except Exception as e:
                edit_message(chat_id, message_id, f"❌ Ошибка: {e}")

        elif data_cb == "stars":
            client = get_client(user_id)
            if not client:
                edit_message(chat_id, message_id, "❌ Нет сессии")
                return "OK", 200
            try:
                me = client.get_me()
                stars = getattr(me, 'stars', 0)
                edit_message(chat_id, message_id, f"⭐ Баланс звёзд: {stars}")
            except Exception as e:
                edit_message(chat_id, message_id, f"❌ Ошибка: {e}")

        elif data_cb == "logout":
            kill_client(user_id)
            if user_id in user_states:
                del user_states[user_id]
            edit_message(chat_id, message_id, "🚪 Вышел. Используй /start для входа")

    return "OK", 200

@app.route('/')
def home():
    return "Bot is running!"

if __name__ == "__main__":
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/setWebhook?url={WEBHOOK_URL}"
    requests.get(url)
    app.run(host='0.0.0.0', port=10000)