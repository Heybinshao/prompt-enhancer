"""Backend routes for prompt-enhancer (mounted at /api/plugins/prompt-enhancer/).

Two jobs:

1. Model choice: write the user's pick into ``auxiliary.prompt_repair`` and
   ``auxiliary.prompt_enhancement`` so BOTH steps of the button use it. Hermes
   reads that block on every one-shot, so the change is effective immediately —
   no gateway restart, no plugin reload, and it survives Hermes updates because
   it is the user's own config file.

   GET  /model  → { ok, tasks: {prompt_repair: {provider, model}, prompt_enhancement: {...}} }
   POST /model  → {provider, model} pins both tasks; {"clear": true} removes the pin.

2. The ``POST /enhance`` HTTP door (merged from prompt-enhance-cmd): the slash
   command needs a chat session and a typed prefix; a phone has neither to
   spare. An iOS Shortcut (share sheet, Action Button, Home Screen icon) posts
   the draft as a plain body and gets the enhanced text back.

   GET  /ping    → cheap liveness probe for a Shortcut's first setup run
   POST /enhance → {"text": "...", "mode": "both"|"fix"|"raw"} → {ok, text, ...}

Both door routes sit behind `/api/`, so auth is the gateway's own (dashboard
sign-in / session token) like every other ``/api/plugins/*`` route. Only the
model routes touch config.

Deliberately small: no paths, no provider checks. The model names come straight
from the model catalog the desktop already shows. The prompt templates live in
the plugin's ``__init__.py`` (one source of truth for both halves); this module
loads that file rather than restating the prompts.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException

router = APIRouter()

TASKS = ("prompt_repair", "prompt_enhancement")


def _config_path():
    from hermes_cli.config import get_config_path

    return get_config_path()


def _write(key_path: str, value: Any) -> None:
    from hermes_cli.config_backend import write_config_key

    write_config_key(_config_path(), key_path, value)


def _read_tasks() -> dict[str, dict[str, str]]:
    from hermes_cli.config import load_config_readonly

    config = load_config_readonly() or {}
    aux = config.get("auxiliary") if isinstance(config, dict) else None
    aux = aux if isinstance(aux, dict) else {}
    out: dict[str, dict[str, str]] = {}
    for task in TASKS:
        block = aux.get(task)
        block = block if isinstance(block, dict) else {}
        out[task] = {
            "provider": str(block.get("provider") or ""),
            "model": str(block.get("model") or ""),
        }
    return out


@router.get("/model")
def read_model() -> dict:
    return {"ok": True, "tasks": _read_tasks()}


@router.post("/model")
def set_model(payload: dict = Body(default_factory=dict)) -> dict:
    clear = bool(payload.get("clear"))
    provider = str(payload.get("provider") or "").strip()
    model = str(payload.get("model") or "").strip()
    if not clear and (not provider or not model):
        raise HTTPException(status_code=400, detail="provider and model are required")

    for task in TASKS:
        prefix = f"auxiliary.{task}"
        if clear:
            # None unsets the key; empty blocks are harmless and stay parseable.
            _write(f"{prefix}.provider", None)
            _write(f"{prefix}.model", None)
        else:
            _write(f"{prefix}.provider", provider)
            _write(f"{prefix}.model", model)

    return {"ok": True, "cleared": clear, "tasks": _read_tasks()}


# ── POST /enhance HTTP door (merged from prompt-enhance-cmd) ────────────────

import functools  # noqa: E402
import importlib.util  # noqa: E402
from pathlib import Path  # noqa: E402
from pydantic import BaseModel  # noqa: E402

_MODES = {"both", "fix", "raw"}


@functools.lru_cache(maxsize=1)
def _core():
    """The plugin's own module, loaded once: its templates, guards and two calls."""
    path = Path(__file__).resolve().parent.parent / "__init__.py"
    spec = importlib.util.spec_from_file_location("prompt_enhancer_core", path)
    if spec is None or spec.loader is None:  # pragma: no cover - a broken install
        raise HTTPException(status_code=500, detail="plugin module not loadable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class EnhanceBody(BaseModel):
    text: str = ""
    mode: str = "both"


@router.get("/ping")
def ping() -> dict:
    """Cheap liveness probe for a Shortcut's first setup run: no model call."""
    return {"ok": True, "plugin": "prompt-enhancer", "modes": sorted(_MODES)}


@router.post("/enhance")
def enhance(payload: EnhanceBody) -> dict:
    core = _core()
    text = (payload.text or "").strip()
    mode = (payload.mode or "both").strip().lower()
    if mode not in _MODES:
        raise HTTPException(status_code=400, detail=f"mode must be one of {sorted(_MODES)}")
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if len(text) > core.MAX_INPUT_CHARS:
        raise HTTPException(status_code=413, detail=f"draft longer than {core.MAX_INPUT_CHARS} chars")

    try:
        # fix = repair ONLY (see _handle in __init__.py — the original
        # prompt-enhance-cmd echoed the draft back untouched in fix mode).
        if mode in {"both", "copy", "fix"} and len(text) <= core.REPAIR_SKIP_CHARS:
            text = core._repair(text)
        if mode != "fix":
            text = core._enhance(text)
    except Exception as exc:  # noqa: BLE001 — the phone needs a reason it can show
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc

    return {"ok": True, "mode": mode, "text": text, "chars": len(text)}
