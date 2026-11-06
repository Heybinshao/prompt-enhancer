"""prompt-enhancer — backend half.

The desktop half owns the button, the draft and the menu. This half exists for
exactly one reason: a renderer plugin cannot write ``config.yaml``, and the model
choice has to land there — ``llm.oneshot`` has no provider/model parameter yet
(upstream #118430), but ``auxiliary.<task>.{provider,model}`` is read on every
call, so writing it is both immediate and version-independent.

Routes live in ``dashboard/plugin_api.py``. The two auxiliary task slots are
registered here — newer Hermes builds refuse ``llm.oneshot`` with a task name no
plugin registered (``unknown auxiliary task``), so ``prompt_repair`` and
``prompt_enhancement`` must exist as registered slots even though nothing else
runs on the agent side (no tools, no hooks, no middleware).
"""

from __future__ import annotations


def register(ctx) -> None:
    ctx.register_auxiliary_task(
        "prompt_repair",
        display_name="提示词修复",
        description="prompt-enhancer 第一步：修正常见笔误与口语句",
    )
    ctx.register_auxiliary_task(
        "prompt_enhancement",
        display_name="提示词增强",
        description="prompt-enhancer 第二步：把提示词改写成模型更易执行的版本",
    )
