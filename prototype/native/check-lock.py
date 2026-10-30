#!/usr/bin/env python3
"""Focused executable checks for the throwaway #9 lock helper."""
import os
from pathlib import Path
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[2]
HELPER = REPO / ".local-test/prototype/native/session-lock"
WORK = REPO / ".local-test/prototype/lock-check"
WORK.mkdir(parents=True, exist_ok=True)

def start(path):
    return subprocess.Popen([str(HELPER), str(path)], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def locked(path):
    p = start(path)
    assert p.stdout.readline() == b"LOCKED\n"
    assert p.poll() is None
    return p

def blocked(path):
    p = start(path)
    out, err = p.communicate(timeout=3)
    assert p.returncode != 0 and out == b"" and err == b"Session lock unavailable.\n"

with tempfile.TemporaryDirectory(dir=WORK) as directory:
    root = Path(directory)
    lock = root / "session.lock"
    p = locked(lock)
    assert lock.stat().st_mode & 0o777 == 0o600
    blocked(lock)
    p.stdin.close()
    assert p.wait(timeout=3) == 0
    p = locked(lock)
    p.kill()
    assert p.wait(timeout=3) < 0
    p = locked(lock)
    p.stdin.close()
    assert p.wait(timeout=3) == 0
    (root / "symlink").symlink_to(lock)
    blocked(root / "symlink")
    (root / "dir-link").symlink_to(root, target_is_directory=True)
    blocked(root / "dir-link" / "session.lock")
    os.link(lock, root / "hardlink")
    blocked(lock)
    (root / "hardlink").unlink()
    lock.chmod(0o644)
    blocked(lock)
    lock.chmod(0o600)
    os.mkfifo(root / "fifo", 0o600)
    blocked(root / "fifo")
    (root / "directory").mkdir()
    blocked(root / "directory")
    blocked(root / ".." / root.name / "session.lock")
    blocked("relative.lock")
print("PASS: exclusive acquisition, EOF/death release, mode/type and symlink/hardlink checks")
