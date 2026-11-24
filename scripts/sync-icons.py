#!/usr/bin/env python3
"""Sync the unit icons a .zkr artifact needs into the viewer's icons dir.

Usage:
    python scripts/sync-icons.py <game-data-dir> <artifact.zkr> [--out mockup/icons]

<game-data-dir> is an extracted Zero-K game folder (contains icons/ and/or
unitpics/, e.g. from unzipping games/Zero-K.sdz). The needed iconTypes are read
from the artifact's UDEF section. Resolution order per iconType:

  1. icons/<type>.png   (the true in-game icon, ~1 KB)
  2. icons/<type>.dds   (converted with Pillow -- browsers cannot decode DDS)
  3. unitpics/<type>.png (unit-database render, larger)
  4. nothing: reported; the viewer keeps its coloured-circle fallback

Run it once per battle after regenerating the artifact; converted PNGs land in
the output dir next to index.html so the site needs zero runtime decoding.
"""
import json
import shutil
import struct
import sys
import zlib
from pathlib import Path

# IconTypes the game resolves through LuaUI/Configs/icontypes.lua to a different
# image, or whose own file is absent from game data. Keys are iconTypes emitted
# in UDEF; values are the file stem to use instead.
ICON_ALIASES = {
    "advradar": "radar",        # same radar icon, drawn larger (size 2.5 vs 2)
    "ampharty": "torparty",     # icontypes.lua maps ampharty -> torparty.png
    "commander1": "armcommander",
    "commander2": "armcommander",
    "commander3": "armcommander",
    # the five stockpiled silo missiles (Eos/Shockley/Zeno/Quake/Inferno)
    # resolve to the cruise-missile icon; the file is committed so the
    # sync must not consider it missing when the game ships no
    # cruisemissilesmall.* of its own
    "cruisemissilesmall": "cruisemissile",
}


def read_zkr_udef(data: bytes):
    if data[:3] != b"ZKR":
        raise SystemExit("not a .zkr artifact (bad magic)")
    offset = 4
    while offset + 16 <= len(data):
        section_id = data[offset:offset + 4].decode("ascii", "replace").strip()
        version, = struct.unpack_from("<H", data, offset + 4)
        codec = data[offset + 6]
        raw_size, comp_size = struct.unpack_from("<II", data, offset + 8)
        payload = data[offset + 16:offset + 16 + comp_size]
        offset += 16 + comp_size
        if section_id != "UDEF":
            continue
        if codec == 1:
            payload = zlib.decompress(payload)
        elif codec != 0:
            raise SystemExit(f"UDEF codec {codec} not supported by this script")
        udef = json.loads(payload.decode("utf-8"))
        return sorted({row[5] for row in udef["units"] if row[5]})
    return []


def find_file(directory: Path, filename: str) -> Path | None:
    """Locate filename in directory, tolerating case differences (Windows game
    installs are case-insensitive; the real file may be e.g. walkerLRarty.dds
    while the iconType is walkerlrarty)."""
    direct = directory / filename
    if direct.exists():
        return direct
    lower = filename.lower()
    for entry in directory.iterdir():
        if entry.name.lower() == lower:
            return entry
    return None


def main() -> None:
    argv = sys.argv[1:]
    out_dir = Path("mockup/icons")
    if "--out" in argv:
        index = argv.index("--out")
        out_dir = Path(argv[index + 1])
        del argv[index:index + 2]
    if len(argv) != 2:
        raise SystemExit(__doc__)
    game_dir = Path(argv[0])
    artifact = Path(argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)

    icon_types = read_zkr_udef(artifact.read_bytes())
    print(f"{len(icon_types)} distinct iconTypes in {artifact.name}")

    from PIL import Image  # noqa: PLC0415 -- only needed for dds conversion

    used, missing = [], []
    for icon_type in icon_types:
        target = out_dir / f"{icon_type}.png"
        resolution = ICON_ALIASES.get(icon_type, icon_type)
        icons_dir = game_dir / "icons"
        png = find_file(icons_dir, f"{resolution}.png")
        dds = find_file(icons_dir, f"{resolution}.dds")
        unitpic = find_file(game_dir / "unitpics", f"{resolution}.png")
        if png and png.exists():
            shutil.copyfile(png, target)
            used.append(f"{icon_type}.png" + (" (alias)" if resolution != icon_type else ""))
        elif dds and dds.exists():
            flip = getattr(getattr(Image, "Transpose", Image), "FLIP_TOP_BOTTOM")
            Image.open(dds).transpose(flip).save(target)
            used.append(f"{icon_type}.png (from dds, flipped{', alias' if resolution != icon_type else ''})")
        elif unitpic and unitpic.exists():
            shutil.copyfile(unitpic, target)
            used.append(f"{icon_type}.png (unitpics{', alias' if resolution != icon_type else ''})")
        else:
            missing.append(icon_type)

    print(f"written {len(used)} icons -> {out_dir}")
    if missing:
        print(f"no icon file (viewer falls back to circles): {', '.join(missing)}")


if __name__ == "__main__":
    main()
