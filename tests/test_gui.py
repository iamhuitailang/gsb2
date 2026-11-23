import sys
import types

import pytest

# GUI 测试在无显示环境下跳过（CI/headless）
import numpy as np
import pytest

tk = pytest.importorskip("tkinter")
pytest.importorskip("PIL")


def _has_display():
    if sys.platform == "darwin":
        return True  # macOS 上允许创建离屏 Tk
    import os
    return bool(os.environ.get("DISPLAY"))


@pytest.mark.skipif(not _has_display(), reason="无显示环境")
def test_app_constructs_and_loads_samples(tmp_path):
    from focus_stack.app import FocusStackApp
    from focus_stack.samples import generate_focus_stack

    paths = generate_focus_stack(tmp_path / "s", n=3)
    app = FocusStackApp()
    try:
        app.state_.load_paths(paths)
        assert len(app.state_.images) == 3
        app.tabs["load"].refresh_files()
        assert app.tabs["load"].file_list.size() == 3

        # 同步跑一次管线（与 AppState._run_worker 一样传入同一 PinSet 实例）
        from focus_stack.pipeline import run_pipeline
        app.state_.result = run_pipeline(app.state_.images, pins=app.state_.pins)
        for tab in app.tabs.values():
            if hasattr(tab, "refresh_after_run"):
                tab.refresh_after_run()
        assert app.state_.result.pins is app.state_.pins
        # pin 页新增固定区域并重融合（检查 pin 内部，避开滤波核边界）
        app.state_.add_pin(0, "rect", [20, 20, 80, 80])
        app.refresh_refusion()
        assert (app.state_.result.labels[24:76, 24:76] == 0).all()
    finally:
        app.destroy()


@pytest.mark.skipif(not _has_display(), reason="无显示环境")
def test_app_rejects_wrong_count(tmp_path):
    import cv2
    from focus_stack.app import FocusStackApp
    app = FocusStackApp()
    try:
        paths = []
        for i in range(2):  # 只有 2 张，应被拒绝
            p = tmp_path / f"x{i}.png"
            cv2.imwrite(str(p), np.zeros((32, 32, 3), np.uint8))
            paths.append(str(p))
        with pytest.raises(ValueError):
            app.state_.load_paths(paths)
    finally:
        app.destroy()
