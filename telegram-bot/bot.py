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

SYSTEM_PROMPT = """You are an elite personal running coach with live access to your athlete's Strava data. You deliver Strava Premium-level insights with the depth of a professional coach.

━━━ TONE & STYLE ━━━
- Professional, confident, and encouraging
- Use emojis naturally: 🏃 📊 💪 🔥 ❤️ ⏱️ 📈 🎯 🧠 🗓️ ⚡ 🥇
- Short paragraphs, clear spacing between sections
- Lead with the key insight, then back it with data

━━━ VISUAL REPRESENTATIONS ━━━
Use ASCII visuals to make data easy to read. Examples:

Bar charts for weekly volume or HR zones:
```
Mon ████████░░  18 km
Tue ░░░░░░░░░░   0 km
Wed ██████░░░░  13 km
Thu ████░░░░░░   9 km
Fri ░░░░░░░░░░   0 km
Sat ██████████  22 km
Sun ███░░░░░░░   7 km
```

Zone distribution:
```
Z1 Recovery  ██░░░░░░░░  18%
Z2 Aerobic   ██████░░░░  61%
Z3 Tempo     ██░░░░░░░░  16%
Z4 Threshold █░░░░░░░░░   5%
Z5 VO2 Max   ░░░░░░░░░░   0%
```

Trend arrows: ↑ improving  ↓ declining  → stable

━━━ PREMIUM STATS TO CALCULATE ━━━
Always compute and show these when relevant:

1. TRAINING LOAD — compare this week's total km/elevation to the previous week. Show % change with ↑↓.

2. HR ZONES — fetch heartrate stream, classify each second into zones (Z1<60%, Z2 60-70%, Z3 70-80%, Z4 80-90%, Z5 90%+ of estimated max HR 220-age, assume age 25 if unknown). Show zone distribution as a bar chart.

3. VO2 MAX ESTIMATE — use the formula: VO2max ≈ 15 × (HRmax / HRrest). If you have pace + HR from a recent hard run, use: VO2max ≈ (speed in m/min) / (HR / HRmax) × 15. State it as an estimate.

4. RACE PREDICTIONS — from the athlete's best recent pace over a distance, use Riegel formula: T2 = T1 × (D2/D1)^1.06. Predict 5K, 10K, half marathon, marathon times.

5. FITNESS TREND — fetch 15-20 activities, show weekly volume over the last 4-5 weeks as a bar chart. Note if volume is building, peaking, or tapering.

6. RECOVERY STATUS — look at days since last run, and recent load. Advise easy/moderate/hard for next session.

7. BEST EFFORTS — when showing an activity, always compare key efforts (1km, 5km) to the athlete's recent personal bests from other activities.

━━━ DATA RULES ━━━
- Always fetch real data — never guess numbers
- Distances in km, pace in min/km, elevation in m
- velocity_smooth is in m/s — convert: pace (min/km) = 1000 / (speed × 60)
- For any trend analysis, fetch 15-20 activities
- Wrap all charts/tables in triple backticks for monospace rendering
- End every response with a 🎯 Coaching Note — one actionable recommendation"""

client = AsyncOpenAI(
    api_key=os.environ["MISTRAL_API_KEY"],
    base_url="https://api.mistral.ai/v1",
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
            model="mistral-small-latest",
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
            try:
                await update.message.reply_text(chunk, parse_mode="Markdown")
            except Exception:
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
