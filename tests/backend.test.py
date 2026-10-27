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


for name, fn in [
    ("B1: 一次写入两个任务（修复 + 增强）", test_writes_both_tasks),
    ("B2: clear 只清辅助模型，不动主模型", test_clear_removes_keys),
    ("B3: 只有一半的请求被 400 拒绝", test_rejects_half_a_pick),
    ("B4: 读回与写入一致", test_read_roundtrip),
]:
    check(name, fn)

fail = 0
for name, status, detail in results:
    print(f"{'✅' if status == 'PASS' else '❌'} {name}  {detail}")
    if status != "PASS":
        fail += 1
print(f"\n{len(results) - fail}/{len(results)} passed")
raise SystemExit(1 if fail else 0)
