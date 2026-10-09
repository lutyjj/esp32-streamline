"""Exercise the add-on image under an enforcing AppArmor profile."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


def main() -> None:
    """Run inside the production image; the caller owns profile installation."""
    profile = Path("/proc/self/attr/current").read_text().strip()
    expected = os.environ["STREAMLINE_TEST_PROFILE"]
    if profile != f"{expected} (enforce)":
        raise RuntimeError(f"expected enforcing profile {expected}, got {profile}")

    options = {"recordings_enabled": True, "api_token": "confinement-test-token"}
    Path("/data/options.json").write_text(json.dumps(options))
    Path("/tmp/streamline-probe").write_text("scratch")
    for path in ("/etc/streamline-probe", "/usr/local/lib/streamline-probe"):
        try:
            Path(path).write_text("must be denied")
        except PermissionError:
            pass
        else:
            raise RuntimeError(f"profile allowed writing {path}")
    try:
        subprocess.run(["/bin/sh", "-c", "exit 0"], check=True)
    except PermissionError:
        pass
    else:
        raise RuntimeError("profile allowed shell execution")

    with subprocess.Popen(["/opt/venv/bin/streamline-ha-addon"]) as process:
        try:
            deadline = time.monotonic() + 15
            while True:
                if process.poll() is not None:
                    raise RuntimeError("add-on exited before becoming healthy")
                try:
                    with urlopen("http://127.0.0.1:8088/health", timeout=1) as response:
                        if response.status != 200:
                            raise RuntimeError("add-on is unhealthy")
                    break
                except (URLError, TimeoutError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError("add-on did not become healthy") from None
                    time.sleep(0.1)
            if not Path("/data/recordings").is_dir():
                raise RuntimeError("add-on did not initialize recording storage")
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise RuntimeError("add-on failed to stop gracefully") from None
        if process.returncode not in (0, -signal.SIGTERM):
            raise RuntimeError(f"add-on exited with {process.returncode}")
    print("AppArmor enforced: runtime startup, storage, HTTP, shutdown and denials passed")


if __name__ == "__main__":
    main()
