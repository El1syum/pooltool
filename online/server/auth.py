"""Opaque sessions and strictly verified VK launch credentials."""

import base64
import hashlib
import hmac
import os
import secrets
from urllib.parse import parse_qsl, urlencode, urlsplit

from fastapi import HTTPException


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(48)


def verify_vk_launch_params(raw: str, now: float) -> str:
    app_id = os.getenv("VK_APP_ID")
    secret = os.getenv("VK_APP_SECRET")
    if not app_id or not secret:
        raise HTTPException(503, "Авторизация VK не настроена")
    if len(raw) > 8192:
        raise HTTPException(422, "Слишком длинные параметры запуска")
    query = urlsplit(raw).query if "://" in raw else raw.lstrip("?")
    pairs = parse_qsl(query, keep_blank_values=True)
    if len(pairs) != len(dict(pairs)):
        raise HTTPException(401, "Повторяющиеся параметры запуска")
    params = dict(pairs)
    signature = params.get("sign", "")
    signed = urlencode(sorted((key, value) for key, value in pairs if key.startswith("vk_")))
    expected = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), signed.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    if not signature or not hmac.compare_digest(expected, signature):
        raise HTTPException(401, "Неверная подпись VK")
    if params.get("vk_app_id") != app_id:
        raise HTTPException(401, "Неверное приложение VK")
    try:
        timestamp = int(params["vk_ts"])
        user_id = int(params["vk_user_id"])
    except (KeyError, ValueError):
        raise HTTPException(401, "Нет идентификатора VK или метки времени") from None
    if user_id <= 0 or timestamp > now + 300 or now - timestamp > 86400:
        raise HTTPException(401, "Параметры запуска VK устарели")
    return str(user_id)
