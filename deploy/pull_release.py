#!/usr/bin/env python3
"""Pull the rolling aichat GitHub release into the OpenResty site directory.

The workflow in .github/workflows/deploy.yml publishes site.tar.gz on the
aichat release. This script downloads that archive when its identity changes,
rejects path-escaping members, and replaces the site files. It does not read
or store any deploy secret.
"""

from __future__ import annotations

import json
import os
import shutil
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

REPO = os.environ.get("AICHAT_REPO", "potatoblock-dev/DeepReplica")
TAG = os.environ.get("AICHAT_TAG", "aichat")
ASSET = os.environ.get("AICHAT_ASSET", "site.tar.gz")
SITE_ROOT = Path(os.environ.get("AICHAT_SITE_ROOT", "/opt/1panel/www/sites/aichat/index"))
STATE_DIR = Path(os.environ.get("AICHAT_STATE_DIR", "/var/lib/aichat"))
USER_AGENT = "aichat-pull"


def fetch_asset() -> dict | None:
    """Return the site asset object, or None when the release tag is not published yet."""
    url = f"https://api.github.com/repos/{REPO}/releases/tags/{TAG}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    for asset in payload.get("assets") or []:
        if asset.get("name") == ASSET:
            return asset
    return None


def asset_identity(asset: dict) -> str:
    """Stable string that changes when GitHub replaces the site archive."""
    digest = asset.get("digest") or ""
    return "|".join(
        [
            str(digest),
            str(asset.get("id") or ""),
            str(asset.get("updated_at") or ""),
            str(asset.get("size") or ""),
        ]
    )


def download_asset(url: str, destination: Path) -> None:
    """Download the release asset to destination over HTTPS."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def assert_safe_archive(archive: Path) -> None:
    """Reject archives that are not a root-level static site."""
    with tarfile.open(archive, "r:gz") as tar:
        names = []
        for member in tar.getmembers():
            parts = Path(member.name).parts
            if member.name.startswith("/") or ".." in parts:
                raise RuntimeError(f"unsafe path in site archive: {member.name}")
            if not (member.isfile() or member.isdir()):
                raise RuntimeError(f"unsupported member in site archive: {member.name}")
            names.append(member.name)
    if "index.html" not in names:
        raise RuntimeError("site archive has no index.html")


def extract_archive(archive: Path, staging: Path) -> None:
    """Extract a checked archive. Python's data filter drops links and special files."""
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(staging, filter="data")


def publish_tree(staging: Path, root: Path) -> None:
    """Replace published files and keep an in-progress ACME challenge directory."""
    root.mkdir(parents=True, exist_ok=True)
    preserved = None
    well_known = root / ".well-known"
    if well_known.exists():
        preserved = Path(tempfile.mkdtemp(prefix="aichat-well-known-"))
        shutil.copytree(well_known, preserved / ".well-known")
    for child in list(root.iterdir()):
        if child.name == ".well-known":
            continue
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    for item in staging.iterdir():
        dest = root / item.name
        if item.is_dir():
            shutil.copytree(item, dest)
        else:
            shutil.copy2(item, dest)
    if preserved is not None:
        shutil.copytree(preserved / ".well-known", root / ".well-known", dirs_exist_ok=True)
        shutil.rmtree(preserved)
    for dirpath, _dirnames, filenames in os.walk(root):
        os.chmod(dirpath, 0o755)
        for filename in filenames:
            os.chmod(os.path.join(dirpath, filename), 0o644)


def read_state(path: Path) -> str:
    """Return the last published asset identity, or an empty string."""
    try:
        return path.read_text().strip()
    except FileNotFoundError:
        return ""


def main() -> int:
    """Publish the latest site bundle when the release asset identity changes."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    state_path = STATE_DIR / "asset-id"
    asset = fetch_asset()
    if asset is None:
        print("release not published yet")
        return 0
    identity = asset_identity(asset)
    if identity == read_state(state_path):
        print("unchanged")
        return 0
    download_url = asset.get("browser_download_url")
    if not download_url:
        raise RuntimeError("release asset has no download url")
    with tempfile.TemporaryDirectory(prefix="aichat-pull-") as tmp:
        tmp_path = Path(tmp)
        archive = tmp_path / ASSET
        staging = tmp_path / "site"
        staging.mkdir()
        download_asset(str(download_url), archive)
        assert_safe_archive(archive)
        extract_archive(archive, staging)
        if not (staging / "index.html").is_file():
            raise RuntimeError("extracted site has no index.html")
        publish_tree(staging, SITE_ROOT)
    state_path.write_text(identity + "\n")
    print(f"published {identity}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
