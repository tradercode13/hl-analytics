import logging
import os
from collections import defaultdict

from dotenv import load_dotenv
load_dotenv()

from google import genai
from google.genai import types
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

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

STRAVA_TOOLS = [
    types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name="get_athlete_profile",
                description="Get the athlete's profile: name, location, weight, FTP, follower counts.",
            ),
            types.FunctionDeclaration(
                name="get_athlete_stats",
                description="Get all-time and recent (4-week) totals: distance, time, elevation by sport type.",
            ),
            types.FunctionDeclaration(
                name="get_recent_activities",
                description="List recent activities with key metrics: type, distance, pace, heart rate, elevation.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "per_page": types.Schema(
                            type=types.Type.INTEGER,
                            description="Number of activities to fetch (1-30, default 10)",
                        ),
                        "page": types.Schema(
                            type=types.Type.INTEGER,
                            description="Page number (default 1)",
                        ),
                    },
                ),
            ),
            types.FunctionDeclaration(
                name="get_activity_details",
                description="Get detailed info for a specific activity: km splits, best efforts, gear.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "activity_id": types.Schema(
                            type=types.Type.INTEGER,
                            description="Strava activity ID",
                        ),
                    },
                    required=["activity_id"],
                ),
            ),
            types.FunctionDeclaration(
                name="get_activity_streams",
                description="Get time-series stats for an activity (min/max/avg): heartrate, pace, power, cadence, altitude.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "activity_id": types.Schema(
                            type=types.Type.INTEGER,
                            description="Strava activity ID",
                        ),
                        "keys": types.Schema(
                            type=types.Type.ARRAY,
                            items=types.Schema(type=types.Type.STRING),
                            description="Stream types: heartrate, velocity_smooth, cadence, watts, altitude",
                        ),
                    },
                    required=["activity_id"],
                ),
            ),
        ]
    )
]

MODEL_CONFIG = types.GenerateContentConfig(
    system_instruction=SYSTEM_PROMPT,
    tools=STRAVA_TOOLS,
)

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

    contents = user_history + [
        types.Content(role="user", parts=[types.Part(text=user_message)])
    ]

    while True:
        response = await client.aio.models.generate_content(
            model="gemini-2.0-flash",
            contents=contents,
            config=MODEL_CONFIG,
        )

        parts = response.candidates[0].content.parts
        fc_parts = [p for p in parts if p.function_call and p.function_call.name]

        if fc_parts:
            contents.append(response.candidates[0].content)

            fn_responses = []
            for part in fc_parts:
                fc = part.function_call
                args = dict(fc.args) if fc.args else {}
                result = await _call_tool(fc.name, args)
                fn_responses.append(
                    types.Part(
                        function_response=types.FunctionResponse(
                            name=fc.name,
                            response={"result": result},
                        )
                    )
                )
            contents.append(types.Content(role="user", parts=fn_responses))

        else:
            text = "".join(p.text for p in parts if hasattr(p, "text") and p.text)
            user_history.append(
                types.Content(role="user", parts=[types.Part(text=user_message)])
            )
            user_history.append(
                types.Content(role="model", parts=[types.Part(text=text)])
            )

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
        await update.message.reply_text(
            "Something went wrong. Try again in a moment."
        )


def main() -> None:
    app = ApplicationBuilder().token(os.environ["TELEGRAM_TOKEN"]).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    logger.info("Bot polling...")
    app.run_polling()


if __name__ == "__main__":
    main()
