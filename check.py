import asyncio
import sys
import random
from telethon import TelegramClient
from telethon.errors import UsernameNotOccupiedError
from telethon.sessions import StringSession

API_ID = 39328144
API_HASH = "b4c02b2f6297f1b61d3073fd50629711"
SESSION_STRING = "1AZWarzgBuzNZma0YX6nb4Ns35cCcSGGZcJi4Rp0U1epTiUTWIHtTsx2ysX6axMwUaTCqknpR2ipcChbucb6aw5M0fXXLDK7ZzWLFy1iznRTQJNU7BQkr-WN8sJdN3DHSOYIrPnuG8bDQfa6S8xSxXIibSqPGNBFX30jtojV1hnuZ7L6tD6AhCTlsvAMK2J4h_pVv7wSbwVA4iIHhc8qMTHUCegmPNW1pbEhnUOX9J_1Ouk6kFydis_apdTnpZf8KW66lWFvE3gYbRj_PsgqqMMf3_SZyd9p17aP2MefEbz6MQ4jnmmhPTu0XxHJ1u1Z1Np14IXtcfTZlU9Cja1fndvZY1SryHts="

async def main():
    length = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    client = TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH)
    await client.start()
    
    letters = 'abcdefghijklmnopqrstuvwxyz'
    exclude = 'il1o0'
    available = ''.join([c for c in letters if c not in exclude])
    
    found = set()
    attempts = 0
    while len(found) < 25 and attempts < 3000:
        username = ''.join(random.sample(available, min(length, len(available))))
        if len(username) == length:
            try:
                await client.get_entity(username)
            except UsernameNotOccupiedError:
                found.add(username)
            except:
                pass
        attempts += 1
        if attempts % 50 == 0:
            await asyncio.sleep(0.1)
    
    result = list(found)[:25]
    print(" ".join(result))
    await client.disconnect()

if __name__ == "__main__":
    asyncio.run(main())