"""prompt-enhancer — backend half.

The desktop half owns the button, the draft and the menu. This half exists for
exactly one reason: a renderer plugin cannot write ``config.yaml``, and the model
choice has to land there — ``llm.oneshot`` has no provider/model parameter yet
(upstream #118430), but ``auxiliary.<task>.{provider,model}`` is read on every
call, so writing it is both immediate and version-independent.

Routes live in ``dashboard/plugin_api.py``; nothing is registered on the agent
side (no tools, no hooks, no middleware).
"""

from __future__ import annotations


def register(ctx) -> None:  # noqa: ARG001 — manifest API, routes come from dashboard/
    return None
