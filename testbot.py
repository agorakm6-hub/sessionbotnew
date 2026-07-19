from flask import Flask, request
import requests
import json

app = Flask(__name__)
BOT_TOKEN = "8895080427:AAE02i4cD0NeWVOShOC6btza4PMitpJxgk8"
WEBHOOK_URL = "https://sessionbotnew-1.onrender.com/webhook"

def send_message(chat_id, text):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {"chat_id": chat_id, "text": text}
    requests.post(url, json=payload)

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.get_json()
    if data and 'message' in data:
        chat_id = data['message']['chat']['id']
        text = data['message'].get('text', '')
        if text == '/start':
            send_message(chat_id, "Привет гандон! 🤡")
    return "OK", 200

@app.route('/')
def home():
    return "Bot is running!"

if __name__ == "__main__":
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/setWebhook?url={WEBHOOK_URL}"
    requests.get(url)
    app.run(host='0.0.0.0', port=10000)