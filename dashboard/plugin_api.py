"""Backend routes for prompt-enhancer (mounted at /api/plugins/prompt-enhancer/).

One job: write the user's model choice into ``auxiliary.prompt_repair`` and
``auxiliary.prompt_enhancement`` so BOTH steps of the button use it. Hermes reads
that block on every one-shot, so the change is effective immediately — no gateway
restart, no plugin reload, and it survives Hermes updates because it is the user's
own config file.

GET  /model  → { ok, tasks: {prompt_repair: {provider, model}, prompt_enhancement: {...}} }
POST /model  → {provider, model} pins both tasks; {"clear": true} removes the pin.

Deliberately small: no paths, no provider checks. The names come straight from the
model catalog the desktop already shows.
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
