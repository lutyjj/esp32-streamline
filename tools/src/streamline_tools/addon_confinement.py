"""Exercise the add-on image under an enforcing AppArmor profile."""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, cast
from urllib.error import URLError
from urllib.request import Request, urlopen

TOKEN = "confinement-test-token"
KEY_ID = "eli1-" + "12" * 16


def request(method: str, path: str, body: dict[str, object] | None = None) -> bytes:
    data = None if body is None else json.dumps(body).encode()
    headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    with urlopen(Request(f"http://127.0.0.1:8088{path}", data, headers, method=method), timeout=3) as response:
        return cast(bytes, response.read())


def api(method: str, path: str, body: dict[str, object] | None = None) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(request(method, path, body)))


def wait_for(predicate: Callable[[], bool]) -> None:
    deadline = time.monotonic() + 15
    while not predicate():
        if time.monotonic() >= deadline:
            raise RuntimeError("timed out waiting for add-on state")
        time.sleep(0.1)


@contextmanager
def running_addon() -> Iterator[None]:
    with subprocess.Popen(["/opt/venv/bin/streamline-ha-addon"]) as process:

        def healthy() -> bool:
            if process.poll() is not None:
                raise RuntimeError("add-on exited before becoming healthy")
            try:
                return request("GET", "/health") == b"ok\n"
            except (URLError, TimeoutError):
                return False

        try:
            wait_for(healthy)
            yield
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise RuntimeError("add-on failed to stop") from None
        if process.returncode not in (0, -signal.SIGTERM):
            raise RuntimeError(f"add-on exited with {process.returncode}")


def main() -> None:
    """Run inside the production image; the caller owns profile installation."""
    profile = Path("/proc/self/attr/current").read_text().strip()
    expected = os.environ["STREAMLINE_TEST_PROFILE"]
    if profile != f"{expected} (enforce)":
        raise RuntimeError(f"expected enforcing profile {expected}, got {profile}")

    options = {"recordings_enabled": True, "api_token": TOKEN}
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

    vectors = json.loads(Path("/tmp/pcm-frame-vectors.json").read_text())["valid"]
    frames = {vector["name"]: bytes.fromhex(vector["frame_hex"]) for vector in vectors}
    payload_size = next(vector["payload_bytes"] for vector in vectors if vector["name"] == "full_frame")
    with running_addon():
        api("PUT", f"/api/transport/keys/{KEY_ID}", {"psk": "34" * 32})
        with socket.create_connection(("127.0.0.1", 39000), timeout=3) as producer:
            producer.sendall(frames["sequence_zero"])
            wait_for(lambda: "127.0.0.1" in api("GET", "/status")["sources"])
            recording = api("POST", "/api/recordings", {"source": "127.0.0.1", "title": "Confinement test"})
            recording_id = recording["recording"]["id"]
            producer.sendall(frames["full_frame"])
            wait_for(lambda: any(item["bytes"] >= payload_size for item in api("GET", "/api/recordings")["active"]))
            stopped = api("POST", f"/api/recordings/{recording_id}/stop")
            if stopped["recording"]["state"] != "complete":
                raise RuntimeError("recording did not finalize")
        recorded = request("GET", f"/api/recordings/{recording_id}/file")
        if not recorded.startswith(b"RIFF") or recorded[44:] != frames["full_frame"][-payload_size:]:
            raise RuntimeError("recording did not preserve the supplied PCM")

    with running_addon():
        if KEY_ID not in api("GET", "/api/transport")["key_ids"]:
            raise RuntimeError("transport key did not survive restart")
        if request("GET", f"/api/recordings/{recording_id}/file") != recorded:
            raise RuntimeError("recording did not survive restart")
    print("AppArmor enforced: startup, key and recording persistence, download, shutdown and denials passed")


if __name__ == "__main__":
    main()
