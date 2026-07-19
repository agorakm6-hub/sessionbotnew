import logging
from telegram import Update
from telegram.ext import Updater, CommandHandler, CallbackContext

logging.basicConfig(level=logging.INFO)

BOT_TOKEN = "8895080427:AAE02i4cD0NeWVOShOC6btza4PMitpJxgk8"

def start(update: Update, context: CallbackContext):
    update.message.reply_text("Привет гандон! 🤡")

def main():
    updater = Updater(BOT_TOKEN, use_context=True)
    dp = updater.dispatcher
    dp.add_handler(CommandHandler("start", start))
    print("✅ Бот запущен!")
    updater.start_polling()
    updater.idle()

if __name__ == "__main__":
    main()