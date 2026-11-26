import sys

print("python", sys.version.split()[0])
for name in ("numpy", "scipy", "PIL", "tkinter", "matplotlib", "cv2", "pytest"):
    try:
        mod = __import__(name)
        print(name, "OK", getattr(mod, "__version__", "?"))
    except Exception as exc:  # noqa: BLE001
        print(name, "MISSING", type(exc).__name__)

import blurlab.synth  # noqa: F401,E402

print("blurlab import OK")
