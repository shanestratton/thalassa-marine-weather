#!/usr/bin/env python3
"""Prepare reviewed Docker context outside the checkout; never builds/installs.
The download is opt-in and only the pinned official Node archive is fetched.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request

BASE_ID = "sha256:57b20fcd82df868582b1a024f7b00f181e0614950b7a7046b02a5d5cd3c2bb2e"
NODE_FILE = "node-v24.20.0-linux-x64.tar.xz"
NODE_URL = "https://nodejs.org/dist/v24.20.0/" + NODE_FILE
NODE_SHA = "2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Official runtime download redirected")

def prepare(directory, cli, download=False, verify_docker=False):
    original_cli = Path(cli)
    directory, cli = Path(directory).resolve(), original_cli.resolve()
    if original_cli.is_symlink() or not cli.is_file() or cli.stat().st_size > 128 * 1024:
        raise ValueError("Expected reviewed standalone converter bundle")
    source = Path(__file__).resolve().parent
    checkout = source.parents[1]
    if directory == checkout or checkout in directory.parents:
        raise ValueError("Image context must be outside source checkout")
    converter = cli.read_bytes()
    if b'Source dataset revision differs from reviewed NOAA catalogue' not in converter or b'sbdarePoints' not in converter:
        raise ValueError("Not the NOAA-only converter bundle")
    if verify_docker:
        actual = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}}", "thalassa-relief:1"], check=True, capture_output=True, text=True).stdout.strip()
        if actual != BASE_ID: raise ValueError("Local GDAL base changed; review before building")
    result = {"download": download, "nodeUrl": NODE_URL, "nodeSha256": NODE_SHA, "gdalBaseId": BASE_ID,
              "converterSha256": hashlib.sha256(cli.read_bytes()).hexdigest(), "context": str(directory),
              "build": ["docker", "build", "--pull=false", "--network=none", "-t", "thalassa-noaa:135", str(directory)],
              "activation": False}
    if not download: return result
    directory.mkdir(parents=True, exist_ok=False)
    archive = directory / NODE_FILE
    digest, total = hashlib.sha256(), 0
    with urllib.request.build_opener(NoRedirect()).open(NODE_URL, timeout=30) as response, archive.open("xb") as output:
        if response.status != 200: raise ValueError("Official runtime download failed")
        while chunk := response.read(256 * 1024):
            total += len(chunk)
            if total > 48 * 1024**2: raise ValueError("Official runtime exceeds cap")
            digest.update(chunk); output.write(chunk)
    if digest.hexdigest() != NODE_SHA: raise ValueError("Official runtime checksum mismatch")
    shutil.copyfile(source / "Dockerfile", directory / "Dockerfile")
    shutil.copyfile(cli, directory / "convert-cli.mjs")
    result["nodeBytes"] = total
    (directory / "review.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--cli", required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--verify-docker", action="store_true")
    args = parser.parse_args()
    print(json.dumps(prepare(args.directory, args.cli, args.download, args.verify_docker), indent=2))
