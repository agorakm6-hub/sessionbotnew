from flask import Flask, request
import requests
import json
import re

app = Flask(__name__)

BOT_TOKEN = "8895080427:AAE02i4cD0NeWVOShOC6btza4PMitpJxgk8"
WEBHOOK_URL = "https://sessionbotnew-1.onrender.com/webhook"

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

def answer_callback(callback_id):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/answerCallbackQuery"
    requests.post(url, json={"callback_query_id": callback_id})

def show_menu(chat_id, message_id=None):
    keyboard = {
        "inline_keyboard": [
            [{"text": "📤 Отправить сообщение", "callback_data": "send"}],
            [{"text": "📖 Читать сообщения", "callback_data": "read"}],
            [{"text": "🚪 Выйти", "callback_data": "logout"}]
        ]
    }
    if message_id:
        edit_message(chat_id, message_id, "📱 Меню (демо):", keyboard)
    else:
        send_message(chat_id, "📱 Меню (демо):", keyboard)

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.get_json()
    if not data:
        return "OK", 200

    if 'message' in data:
        msg = data['message']
        chat_id = msg['chat']['id']
        text = msg.get('text', '')

        if text == '/start':
            keyboard = {
                "inline_keyboard": [
                    [{"text": "🔑 Войти (демо)", "callback_data": "login"}],
                    [{"text": "📱 Меню", "callback_data": "menu"}]
                ]
            }
            send_message(chat_id, "👋 Привет! Это демо-бот без Telethon/Pyrogram. Нажми кнопку:", keyboard)

    elif 'callback_query' in data:
        query = data['callback_query']
        callback_id = query['id']
        chat_id = query['message']['chat']['id']
        message_id = query['message']['message_id']
        data_cb = query['data']

        answer_callback(callback_id)

        if data_cb == "login":
            edit_message(chat_id, message_id, "✅ Ты нажал 'Войти' (демо).\n\nРеальная авторизация через сессию требует Telethon/Pyrogram, но они не работают на Python 3.14 в Flask.")
        elif data_cb == "menu":
            show_menu(chat_id, message_id)
        elif data_cb == "send":
            edit_message(chat_id, message_id, "📤 Отправка сообщений (демо).\n\nВ реальности требует авторизации.")
        elif data_cb == "read":
            edit_message(chat_id, message_id, "📖 Чтение сообщений (демо).\n\nВ реальности требует авторизации.")
        elif data_cb == "logout":
            edit_message(chat_id, message_id, "🚪 Вышел (демо). Используй /start")

    return "OK", 200

@app.route('/')
def home():
    return "Bot is running!"

if __name__ == "__main__":
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/setWebhook?url={WEBHOOK_URL}"
    requests.get(url)
    app.run(host='0.0.0.0', port=10000)