import json
import logging
import os
from collections import defaultdict

from dotenv import load_dotenv
load_dotenv()

from openai import AsyncOpenAI
from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

from strava import StravaClient

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a personal Strava coaching assistant with live access to the user's training data. Use the tools to fetch fresh data whenever the user asks about their activities, stats, or training.

Guidelines:
- Always fetch real data — never guess numbers
- Be specific: include actual distances, paces, heart rates, elevation
- Keep Telegram messages concise and readable (plain text, no markdown)
- Distances in km, pace in min/km, elevation in meters
- velocity_smooth from Strava is in m/s — convert to min/km pace when showing it
- Be encouraging and coach-like, not just a data dump
- For trends, fetch 10-20 activities"""

client = AsyncOpenAI(
    api_key=os.environ["GROQ_API_KEY"],
    base_url="https://api.groq.com/openai/v1",
)

STRAVA_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_athlete_profile",
            "description": "Get the athlete's profile: name, location, weight, FTP, follower counts.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_athlete_stats",
            "description": "Get all-time and recent (4-week) totals: distance, time, elevation by sport type.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_recent_activities",
            "description": "List recent activities with key metrics: type, distance, pace, heart rate, elevation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "per_page": {"type": "integer", "description": "Number of activities to fetch (1-30, default 10)"},
                    "page": {"type": "integer", "description": "Page number (default 1)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_activity_details",
            "description": "Get detailed info for a specific activity: km splits, best efforts, gear.",
            "parameters": {
                "type": "object",
                "properties": {
                    "activity_id": {"type": "integer", "description": "Strava activity ID"},
                },
                "required": ["activity_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_activity_streams",
            "description": "Get time-series stats for an activity (min/max/avg): heartrate, pace, power, cadence, altitude.",
            "parameters": {
                "type": "object",
                "properties": {
                    "activity_id": {"type": "integer", "description": "Strava activity ID"},
                    "keys": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Stream types: heartrate, velocity_smooth, cadence, watts, altitude",
                    },
                },
                "required": ["activity_id"],
            },
        },
    },
]

strava = StravaClient(
    client_id=os.environ["STRAVA_CLIENT_ID"],
    client_secret=os.environ["STRAVA_CLIENT_SECRET"],
    refresh_token=os.environ["STRAVA_REFRESH_TOKEN"],
)

history: dict[int, list] = defaultdict(list)
MAX_TURNS = 15


async def _call_tool(name: str, args: dict) -> str:
    try:
        if name == "get_athlete_profile":
            return await strava.get_athlete()
        if name == "get_athlete_stats":
            return await strava.get_athlete_stats()
        if name == "get_recent_activities":
            return await strava.get_activities(
                per_page=int(args.get("per_page", 10)),
                page=int(args.get("page", 1)),
            )
        if name == "get_activity_details":
            return await strava.get_activity(int(args["activity_id"]))
        if name == "get_activity_streams":
            return await strava.get_activity_streams(
                int(args["activity_id"]),
                list(args.get("keys", ["heartrate", "velocity_smooth", "altitude"])),
            )
        return f"Unknown tool: {name}"
    except Exception as exc:
        logger.warning("Tool %s failed: %s", name, exc)
        return f"Error: {exc}"


async def _chat(user_id: int, user_message: str) -> str:
    user_history = history[user_id]

    messages = (
        [{"role": "system", "content": SYSTEM_PROMPT}]
        + user_history
        + [{"role": "user", "content": user_message}]
    )

    while True:
        response = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=messages,
            tools=STRAVA_TOOLS,
            tool_choice="auto",
            max_tokens=2048,
        )

        msg = response.choices[0].message

        if msg.tool_calls:
            messages.append({
                "role": "assistant",
                "content": msg.content,
                "tool_calls": [tc.model_dump() for tc in msg.tool_calls],
            })
            for tc in msg.tool_calls:
                args = json.loads(tc.function.arguments) if tc.function.arguments else {}
                result = await _call_tool(tc.function.name, args)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": str(result),
                })
        else:
            text = msg.content or ""
            user_history.append({"role": "user", "content": user_message})
            user_history.append({"role": "assistant", "content": text})

            if len(user_history) > MAX_TURNS * 2:
                user_history[:] = user_history[-(MAX_TURNS * 2):]

            return text


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    history[update.effective_user.id].clear()
    await update.message.reply_text(
        "Hey! I'm your Strava coach. Ask me anything — recent runs, weekly stats, "
        "pace trends, recovery, whatever. I have live access to your data."
    )


async def cmd_reset(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    history[update.effective_user.id].clear()
    await update.message.reply_text("Done — conversation cleared.")


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = update.effective_user.id
    await update.message.chat.send_action("typing")
    try:
        reply = await _chat(user_id, update.message.text)
        for chunk in [reply[i:i + 4096] for i in range(0, len(reply), 4096)]:
            await update.message.reply_text(chunk)
    except Exception as exc:
        logger.error("Error for user %d: %s", user_id, exc, exc_info=True)
        await update.message.reply_text("Something went wrong. Try again in a moment.")


def main() -> None:
    app = ApplicationBuilder().token(os.environ["TELEGRAM_TOKEN"]).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    logger.info("Bot polling...")
    app.run_polling()


if __name__ == "__main__":
    main()
