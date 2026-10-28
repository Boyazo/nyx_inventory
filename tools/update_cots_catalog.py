#!/usr/bin/env python3
"""Refresh the COTS part list in js/parts_catalog.js from the FRCDesign library.

Usage:  python3 tools/update_cots_catalog.py
Keeps TEAM_PRESETS as-is; rewrites COTS_CATEGORIES and COTS_PARTS.
COTS = every visible library part except custom/generic/"block" models, deprecated parts,
3D prints, block models and the KrayonCAD set.
"""
import json, re, urllib.request, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CATALOG = ROOT / "js" / "parts_catalog.js"
API = "https://app.frcdesign.org/api"
SKIP_GROUPS = {"Block Models", "Useful 3D Prints", "KrayonCAD"}

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "nyx-inventory-catalog-updater/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

version = get(f"{API}/library-version/library/frc-design-lib")
v = version.get("version", version) if isinstance(version, dict) else version
lib = get(f"{API}/library-data/library/frc-design-lib?v={v}")

gname = {k: g["name"] for k, g in lib["groups"].items()}
groups = [gname[g] for g in lib["groupOrder"] if gname[g] not in SKIP_GROUPS]
gidx = {g: i for i, g in enumerate(groups)}
order = {iid: n for g in lib["groupOrder"] for n, iid in enumerate(lib["groups"][g].get("insertableOrder", []))}

src = CATALOG.read_text()
vendors = json.loads(re.search(r"export const VENDORS = (\{.*?\});", src, re.S).group(1))

def is_cots(i):
    if not i["isVisible"] or gname.get(i["groupId"]) in SKIP_GROUPS or "Custom" in i["vendors"]:
        return False
    return not re.search(r"\bgeneric\b|\(block\)|^block |deprecated|^custom ", i["name"], re.I)

parts, seen = [], set()
for i in sorted(lib["insertables"].values(), key=lambda i: (gidx.get(gname.get(i["groupId"]), 99), order.get(i["id"], 9999))):
    if not is_cots(i) or i["name"].lower() in seen:
        continue
    seen.add(i["name"].lower())
    unknown = [x for x in i["vendors"] if x not in vendors]
    if unknown:
        print("note: unknown vendor code(s)", unknown, "on", i["name"], "- add them to VENDORS")
    parts.append([i["name"], gidx[gname[i["groupId"]]], [x for x in i["vendors"] if x in vendors]])

src = re.sub(r"export const COTS_CATEGORIES = .*?;\n", lambda _: f"export const COTS_CATEGORIES = {json.dumps(groups)};\n", src, count=1, flags=re.S)
src = re.sub(r"export const COTS_PARTS = \[\n.*?\n\];\n",
             lambda _: "export const COTS_PARTS = [\n" + ",\n".join(json.dumps(p, ensure_ascii=False) for p in parts) + "\n];\n",
             src, count=1, flags=re.S)
CATALOG.write_text(src)
print(f"{len(parts)} COTS parts across {len(groups)} categories (library v{v})")
