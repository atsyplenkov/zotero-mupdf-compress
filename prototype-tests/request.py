#!/usr/bin/env python3
"""Create an explicit one-shot request. Does not install or launch Zotero."""
import argparse
import json
import pathlib
import re

p = argparse.ArgumentParser()
p.add_argument("run_id")
p.add_argument("--mode", choices=("suite", "seed-session", "restart-check", "review-session", "shutdown-busy"), default="suite")
p.add_argument("--previous-run")
p.add_argument("--faults", action="store_true", help="Include gated safety fault-injection checks")
p.add_argument("--ui", action="store_true", help="Include progress-window close/reopen and timed-dismissal checks (about 35 seconds)")
args = p.parse_args()
if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", args.run_id):
    p.error("run_id must contain 1-80 ASCII letters, digits, underscores, or hyphens")
repo = pathlib.Path(__file__).resolve().parent.parent
local = repo / ".local-test"
work = local / "prototype"
work.mkdir(parents=True, exist_ok=True)
request = work / "integration-request.json"
if request.exists():
    p.error("An unconsumed request already exists")
if (work / f"integration-request-{args.run_id}.claimed.json").exists():
    p.error("run_id already used; choose another")
if args.mode == "restart-check" and not args.previous_run:
    p.error("--previous-run is required for restart-check")
payload = {
    "runID": args.run_id,
    "mode": args.mode,
    "previousRun": args.previous_run,
    "faults": args.faults,
    "ui": args.ui,
    "allowDisposableLibraryChanges": True,
    "expectedProfile": str(local / "zotero" / "profile"),
    "expectedData": str(local / "zotero" / "data"),
}
with request.open("x") as stream:
    json.dump(payload, stream, indent=2)
    stream.write("\n")
print(request)
