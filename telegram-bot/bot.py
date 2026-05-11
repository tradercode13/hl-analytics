import asyncio
import logging
import os
from collections import defaultdict

from dotenv import load_dotenv
load_dotenv()

import google.generativeai as genai
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

genai.configure(api_key=os.environ["GEMINI_API_KEY"])

STRAVA_TOOLS = genai.protos.Tool(
    function_declarations=[
        genai.protos.FunctionDeclaration(
            name="get_athlete_profile",
            description="Get the athlete's profile: name, location, weight, FTP, follower counts.",
            parameters=genai.protos.Schema(
                type=genai.protos.Type.OBJECT,
                properties={},
            ),
        ),
        genai.protos.FunctionDeclaration(
            name="get_athlete_stats",
            description="Get all-time and recent (4-week) totals: distance, time, elevation by sport type.",
            parameters=genai.protos.Schema(
                type=genai.protos.Type.OBJECT,
                properties={},
            ),
        ),
        genai.protos.FunctionDeclaration(
            name="get_recent_activities",
            description="List recent activities with key metrics: type, distance, pace, heart rate, elevation.",
            parameters=genai.protos.Schema(
                type=genai.protos.Type.OBJECT,
                properties={
                    "per_page": genai.protos.Schema(
                        type=genai.protos.Type.INTEGER,
                        description="Number of activities to fetch (1-30, default 10)",
                    ),
                    "page": genai.protos.Schema(
                        type=genai.protos.Type.INTEGER,
                        description="Page number (default 1)",
                    ),
                },
            ),
        ),
        genai.protos.FunctionDeclaration(
            name="get_activity_details",
            description="Get detailed info for a specific activity: km splits, best efforts, gear.",
            parameters=genai.protos.Schema(
                type=genai.protos.Type.OBJECT,
                properties={
                    "activity_id": genai.protos.Schema(
                        type=genai.protos.Type.INTEGER,
                        description="Strava activity ID",
                    ),
                },
                required=["activity_id"],
            ),
        ),
        genai.protos.FunctionDeclaration(
            name="get_activity_streams",
            description="Get time-series stats for an activity (min/max/avg): heartrate, pace, power, cadence, altitude.",
            parameters=genai.protos.Schema(
                type=genai.protos.Type.OBJECT,
                properties={
                    "activity_id": genai.protos.Schema(
                        type=genai.protos.Type.INTEGER,
                        description="Strava activity ID",
                    ),
                    "keys": genai.protos.Schema(
                        type=genai.protos.Type.ARRAY,
                        items=genai.protos.Schema(type=genai.protos.Type.STRING),
                        description="Stream types: heartrate, velocity_smooth, cadence, watts, altitude",
                    ),
                },
                required=["activity_id"],
            ),
        ),
    ]
)

model = genai.GenerativeModel(
    model_name="gemini-2.0-flash",
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

    # Build contents: persistent history + new user message
    contents = user_history + [{"role": "user", "parts": [{"text": user_message}]}]

    while True:
        response = await asyncio.to_thread(model.generate_content, contents)

        parts = response.candidates[0].content.parts
        fc_parts = [p for p in parts if p.function_call and p.function_call.name]

        if fc_parts:
            # Add model's function-call turn to contents
            contents.append(response.candidates[0].content)

            # Execute all tool calls and collect responses
            fn_responses = []
            for part in fc_parts:
                fc = part.function_call
                args = {k: v for k, v in fc.args.items()}
                result = await _call_tool(fc.name, args)
                fn_responses.append(
                    genai.protos.Part(
                        function_response=genai.protos.FunctionResponse(
                            name=fc.name,
                            response={"result": result},
                        )
                    )
                )
            contents.append({"role": "user", "parts": fn_responses})

        else:
            # Final text response — persist only the text turns to history
            text = "".join(p.text for p in parts if hasattr(p, "text"))
            user_history.append({"role": "user", "parts": [{"text": user_message}]})
            user_history.append({"role": "model", "parts": [{"text": text}]})

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
