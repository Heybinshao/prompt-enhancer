"""后端半边的行为测试（写 config.yaml 的那 40 行）。

跑法（要 Hermes 自带的 venv，里面有 fastapi / yaml；PYTHONPATH 指向
hermes-agent 仓根——`hermes_yaml` 在那里，venv 里没装）：
    PYTHONPATH=~/.hermes/hermes-agent ~/.hermes/hermes-agent/venv/bin/python3 tests/backend.test.py

不碰真实配置：把 `_config_path` 指到一个临时文件，只验证「写进去的键对不对」。
读取用的 `load_config_readonly()` 属于 Hermes 内部缓存，这里替换成直接解析临时
文件，测的是本插件自己的写入逻辑。
"""

from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("pe_plugin_api", ROOT / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

results = []


def check(name, fn):
    try:
        fn()
        results.append((name, "PASS", ""))
    except AssertionError as exc:
        results.append((name, "FAIL", str(exc)))
    except Exception as exc:  # noqa: BLE001 — surface the real error in the report
        results.append((name, "FAIL", f"{type(exc).__name__}: {exc}"))


def repo():
    tmp = Path(tempfile.mkdtemp(prefix="pe-api-")) / "config.yaml"
    tmp.write_text("model:\n  default: qoder-cn/qfmodel\n  provider: magpie\n", encoding="utf-8")
    api._config_path = lambda: tmp
    api._read_tasks = lambda: _tasks_from(tmp)
    return tmp


def _tasks_from(path: Path):
    cfg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    aux = cfg.get("auxiliary") or {}
    out = {}
    for task in api.TASKS:
        block = aux.get(task) or {}
        out[task] = {"provider": block.get("provider") or "", "model": block.get("model") or ""}
    return out


def test_writes_both_tasks():
    path = repo()
    api.set_model({"provider": "magpie", "model": "m1"})
    cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
    for task in ("prompt_repair", "prompt_enhancement"):
        assert cfg["auxiliary"][task]["provider"] == "magpie", f"{task} provider 未写入"
        assert cfg["auxiliary"][task]["model"] == "m1", f"{task} model 未写入"
    # 原有配置不受影响
    assert cfg["model"]["default"] == "qoder-cn/qfmodel"


def test_clear_removes_keys():
    path = repo()
    api.set_model({"provider": "magpie", "model": "m1"})
    api.set_model({"clear": True})
    cfg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    aux = cfg.get("auxiliary") or {}
    for task in ("prompt_repair", "prompt_enhancement"):
        block = aux.get(task) or {}
        assert not block.get("provider"), f"{task} provider 未清除"
        assert not block.get("model"), f"{task} model 未清除"
    assert cfg["model"]["default"] == "qoder-cn/qfmodel", "clear 不得动主模型"


def test_rejects_half_a_pick():
    repo()
    for bad in ({"provider": "magpie"}, {"model": "m1"}, {}):
        try:
            api.set_model(bad)
        except Exception as exc:  # HTTPException
            assert getattr(exc, "status_code", None) == 400, f"{bad} 应以 400 拒绝，实际 {exc!r}"
        else:
            raise AssertionError(f"{bad} 应当被拒绝")


def test_read_roundtrip():
    repo()
    api.set_model({"provider": "p", "model": "m"})
    payload = api.read_model()
    assert payload["tasks"]["prompt_enhancement"] == {"provider": "p", "model": "m"}


def test_register_declares_aux_tasks():
    # 新版 Hermes 网关拒绝未注册的 task 名（unknown auxiliary task），
    # register() 必须把两个槽位都声明出来，缺一个按钮就报 invalid_params。
    registered = []

    class FakeCtx:
        def register_auxiliary_task(self, key, **_kw):
            registered.append(key)

        def register_command(self, *a, **kw):  # merged /enhance — captured, not run
            registered.append(f"cmd:{a[0] if a else kw.get('name')}")

    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location("pe_backend", ROOT / "__init__.py")
    assert _spec is not None and _spec.loader is not None
    _mod = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    _mod.register(FakeCtx())
    assert sorted(registered) == ["cmd:enhance", "prompt_enhancement", "prompt_repair"]


def _backend_module():
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location("pe_backend2", ROOT / "__init__.py")
    assert _spec is not None and _spec.loader is not None
    _mod = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    return _mod


def test_templates_mirror_desktop():
    # 模板曾经分散两个仓、靠手动拷贝（漂了没人知道）。合并后逐字节守护：
    # desktop/plugin.js 是源头，__init__.py 必须一字不差。
    import re as _re

    backend = _backend_module()
    js = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    for py_const, js_const in (("SYSTEM_TEMPLATE", "SYSTEM_TEMPLATE"), ("REPAIR_TEMPLATE", "REPAIR_TEMPLATE")):
        m = _re.search(rf"const {js_const} = `([^`]*)`", js)
        assert m, f"desktop/plugin.js 里找不到 {js_const}"
        assert getattr(backend, py_const) == m.group(1), f"{py_const} 与桌面版模板漂移了"


def test_enhance_command_handler():
    backend = _backend_module()
    calls = []

    def fake_oneshot(instructions, user_input, task, max_tokens):
        calls.append(task)
        return f"处理后的文本（{len(user_input)} 字输入）"

    setattr(backend, "_oneshot", fake_oneshot)
    # 空参 → 帮助
    assert backend._handle("") == backend.HELP
    # both 模式：修复 + 改写，两次调用
    out = backend._handle("帮我写一封邮件给老师请假")
    assert calls == ["prompt_repair", "prompt_enhancement"]
    assert "处理后的文本" in out
    # fix 模式：只修复，一次调用
    calls.clear()
    out = backend._handle("fix 拼音错字测试")
    assert calls == ["prompt_repair"]
    # copy 模式：结果包代码围栏
    calls.clear()
    out = backend._handle("copy 内容")
    assert out.startswith("```\n") and out.endswith("\n```")
    # 超长草稿：拒绝且不调用模型
    calls.clear()
    out = backend._handle("x" * (backend.MAX_INPUT_CHARS + 1))
    assert "上限" in out and calls == []


for name, fn in [
    ("B1: 一次写入两个任务（修复 + 增强）", test_writes_both_tasks),
    ("B2: clear 只清辅助模型，不动主模型", test_clear_removes_keys),
    ("B3: 只有一半的请求被 400 拒绝", test_rejects_half_a_pick),
    ("B4: 读回与写入一致", test_read_roundtrip),
    ("B5: register 声明两个辅助任务槽位 + /enhance 命令", test_register_declares_aux_tasks),
    ("B6: 提示词模板与桌面版逐字节一致", test_templates_mirror_desktop),
    ("B7: /enhance 命令处理器（模式/上限/帮助）", test_enhance_command_handler),
]:
    check(name, fn)

fail = 0
for name, status, detail in results:
    print(f"{'✅' if status == 'PASS' else '❌'} {name}  {detail}")
    if status != "PASS":
        fail += 1
print(f"\n{len(results) - fail}/{len(results)} passed")
raise SystemExit(1 if fail else 0)
