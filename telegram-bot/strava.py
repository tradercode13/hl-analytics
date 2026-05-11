import json
import time
from typing import Any

import httpx

BASE_URL = "https://www.strava.com/api/v3"
TOKEN_URL = "https://www.strava.com/oauth/token"


def _format_activity(a: dict) -> dict:
    moving_time = a.get("moving_time", 0)
    distance = a.get("distance", 0)
    pace_per_km = None
    if distance > 0 and moving_time > 0:
        secs = moving_time / (distance / 1000)
        pace_per_km = f"{int(secs // 60)}:{int(secs % 60):02d} min/km"
    return {
        "id": a["id"],
        "name": a.get("name"),
        "type": a.get("sport_type", a.get("type")),
        "date": a.get("start_date_local", "")[:10],
        "distance_km": round(distance / 1000, 2),
        "moving_time_min": round(moving_time / 60, 1),
        "elevation_m": a.get("total_elevation_gain"),
        "avg_hr": a.get("average_heartrate"),
        "max_hr": a.get("max_heartrate"),
        "avg_watts": a.get("average_watts"),
        "pace_per_km": pace_per_km,
        "suffer_score": a.get("suffer_score"),
        "kudos": a.get("kudos_count"),
    }


class StravaClient:
    def __init__(self, client_id: str, client_secret: str, refresh_token: str):
        self.client_id = client_id
        self.client_secret = client_secret
        self.refresh_token = refresh_token
        self._access_token: str | None = None
        self._expires_at: int = 0
        self._athlete_id: int | None = None

    async def _get_token(self) -> str:
        if self._access_token and time.time() < self._expires_at - 60:
            return self._access_token
        async with httpx.AsyncClient() as client:
            resp = await client.post(TOKEN_URL, data={
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "refresh_token": self.refresh_token,
                "grant_type": "refresh_token",
            })
            resp.raise_for_status()
            data = resp.json()
        self._access_token = data["access_token"]
        self._expires_at = data["expires_at"]
        self.refresh_token = data["refresh_token"]
        return self._access_token

    async def _get(self, path: str, params: dict | None = None) -> Any:
        token = await self._get_token()
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{BASE_URL}{path}",
                headers={"Authorization": f"Bearer {token}"},
                params=params or {},
                timeout=15.0,
            )
            resp.raise_for_status()
            return resp.json()

    async def get_athlete(self) -> str:
        data = await self._get("/athlete")
        self._athlete_id = data["id"]
        return json.dumps({
            "id": data["id"],
            "name": f"{data.get('firstname', '')} {data.get('lastname', '')}".strip(),
            "city": data.get("city"),
            "country": data.get("country"),
            "weight_kg": data.get("weight"),
            "ftp": data.get("ftp"),
            "followers": data.get("follower_count"),
            "following": data.get("friend_count"),
        })

    async def get_athlete_stats(self) -> str:
        if not self._athlete_id:
            await self.get_athlete()
        data = await self._get(f"/athletes/{self._athlete_id}/stats")

        def fmt(t: dict) -> dict:
            return {
                "count": t.get("count"),
                "distance_km": round(t.get("distance", 0) / 1000, 1),
                "time_hours": round(t.get("moving_time", 0) / 3600, 1),
                "elevation_km": round(t.get("elevation_gain", 0) / 1000, 2),
            }

        return json.dumps({
            "recent_runs": fmt(data.get("recent_run_totals", {})),
            "recent_rides": fmt(data.get("recent_ride_totals", {})),
            "recent_swims": fmt(data.get("recent_swim_totals", {})),
            "ytd_runs": fmt(data.get("ytd_run_totals", {})),
            "ytd_rides": fmt(data.get("ytd_ride_totals", {})),
            "all_time_runs": fmt(data.get("all_run_totals", {})),
            "all_time_rides": fmt(data.get("all_ride_totals", {})),
        })

    async def get_activities(self, per_page: int = 10, page: int = 1) -> str:
        data = await self._get("/athlete/activities", {
            "per_page": min(per_page, 30),
            "page": page,
        })
        return json.dumps([_format_activity(a) for a in data])

    async def get_activity(self, activity_id: int) -> str:
        data = await self._get(f"/activities/{activity_id}")
        result = _format_activity(data)
        result.update({
            "description": data.get("description"),
            "gear": data.get("gear", {}).get("name") if data.get("gear") else None,
            "splits_metric": data.get("splits_metric", [])[:10],
            "best_efforts": [
                {"name": e.get("name"), "elapsed_s": e.get("elapsed_time")}
                for e in (data.get("best_efforts") or [])[:8]
            ],
        })
        return json.dumps(result)

    async def get_activity_streams(self, activity_id: int, keys: list[str]) -> str:
        valid = {"heartrate", "velocity_smooth", "cadence", "watts", "altitude",
                 "grade_smooth", "time", "distance"}
        keys = [k for k in keys if k in valid] or ["heartrate", "velocity_smooth"]
        data = await self._get(
            f"/activities/{activity_id}/streams",
            {"keys": ",".join(keys), "key_by_type": "true"},
        )
        result = {}
        for key, stream in data.items():
            if isinstance(stream, dict) and "data" in stream:
                values = [v for v in stream["data"] if v is not None]
                if values:
                    result[key] = {
                        "min": round(min(values), 2),
                        "max": round(max(values), 2),
                        "avg": round(sum(values) / len(values), 2),
                        "samples": len(values),
                    }
        return json.dumps(result)
