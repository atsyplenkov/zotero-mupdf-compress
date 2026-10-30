#!/usr/bin/env python3
"""Install the two local XPIs only into the stopped #8 disposable profile."""
import json
import pathlib
import shutil
import zipfile

repo = pathlib.Path(__file__).resolve().parent.parent
local = repo / ".local-test"
profile = local / "zotero/profile"
runtime = local / "zotero/runtime"
if not profile.is_dir() or not runtime.is_dir():
    raise SystemExit("Prepare the isolated environment from #8 first")
for executable in pathlib.Path("/proc").glob("[0-9]*/exe"):
    try:
        target = executable.readlink()
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
    if target.is_relative_to(runtime):
        raise SystemExit("Close the isolated Zotero process before installing")
packages = {
    "mupdf-compress-prototype.xpi": "mupdf-compress-prototype@zotero.local",
    "integration-test-driver.xpi": "mupdf-compress-test-driver@prototype.invalid",
}
for filename, addon_id in packages.items():
    source = local / "prototype" / filename
    with zipfile.ZipFile(source) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        app = manifest["applications"]["zotero"]
        assert app["id"] == addon_id
        assert app["update_url"].startswith("https://example.invalid/")
        assert app["strict_max_version"]
    destination = profile / "extensions" / (addon_id + ".xpi")
    destination.parent.mkdir(exist_ok=True)
    shutil.copyfile(source, destination)
backups = local / "zotero/session-backups"
backups.mkdir(exist_ok=True, mode=0o700)
prefs = {
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 15,
    "extensions.startupScanScopes": 15,
    "extensions.mupdf-compress-prototype.testMode": True,
    "extensions.mupdf-compress-prototype.temporaryFolder": str(backups),
}
with (profile / "prefs.js").open("a") as stream:
    stream.write("\n// Local prototype test installation; isolated profile only.\n")
    for key, value in prefs.items():
        stream.write(f"user_pref({json.dumps(key)}, {json.dumps(value)});\n")
print("Installed local XPIs into", profile)
