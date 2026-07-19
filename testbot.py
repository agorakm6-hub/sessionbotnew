from flask import Flask
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes
import asyncio

app = Flask(__name__)
BOT_TOKEN = "8895080427:AAE02i4cD0NeWVOShOC6btza4PMitpJxgk8"

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Привет гандон! 🤡")

async def main():
    application = Application.builder().token(BOT_TOKEN).build()
    application.add_handler(CommandHandler("start", start))
    await application.initialize()
    await application.start()
    await application.updater.start_polling()
    await asyncio.Event().wait()

@app.route('/')
def home():
    return "Bot is running!"

if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.create_task(main())
    app.run(host='0.0.0.0', port=10000)