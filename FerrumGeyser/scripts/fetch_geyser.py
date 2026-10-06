"""Download the pinned official Geyser test fixture and verify its checksum."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import tempfile
import urllib.request


def main():
    scripts = Path(__file__).resolve().parent
    fixture = json.loads((scripts / "geyser-fixture.json").read_text())
    destination = scripts.parent / ".deps" / "Geyser-Standalone.jar"
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and hashlib.sha256(destination.read_bytes()).hexdigest() == fixture["sha256"]:
        print("Pinned Geyser fixture already verified")
        return
    url = (f'https://download.geysermc.org/v2/projects/{fixture["project"]}'
           f'/versions/{fixture["version"]}/builds/{fixture["build"]}/downloads/standalone')
    temporary = None
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "FerrumGeyser-CI"})
        with urllib.request.urlopen(request, timeout=60) as response, tempfile.NamedTemporaryFile(
                dir=destination.parent, prefix="geyser-", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            shutil.copyfileobj(response, output)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != fixture["sha256"]:
            raise RuntimeError("Official Geyser fixture checksum mismatch")
        os.replace(temporary, destination)
        print(f'Verified Geyser preview {fixture["version"]} build {fixture["build"]}')
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
