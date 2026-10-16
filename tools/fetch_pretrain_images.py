"""
Download freely licensed example photos of standard lab equipment from Wikimedia Commons.
They are used to pretrain LabBorrow's AI (Admin -> Train AI -> "Pretrain with starter photos").

Run from the LabBorrow folder:   python tools/fetch_pretrain_images.py
Photos go to pretrain_images/<Item name>/, with authors and licenses in pretrain_images/CREDITS.csv.
Already-downloaded classes are skipped, so it is safe to run again.
"""
import csv
import os
import re
import sys
import time

import requests

PER_CLASS = 30
THUMB_WIDTH = 330  # a standard Wikimedia thumbnail size (served from cache, not rate-limited as much)
BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pretrain_images")
API = "https://commons.wikimedia.org/w/api.php"
S = requests.Session()
S.headers["User-Agent"] = "LabBorrow-pretrain/1.0 (school lab borrowing project)"

# item name -> (Commons categories, extra file-search phrases used if the categories are too small)
CLASSES = {
    "Beaker": (["Glass beakers (laboratory equipment)"], ["laboratory beaker"]),
    "Erlenmeyer Flask": (["Erlenmeyer flasks"], []),
    "Test Tube": (["Test tubes"], []),
    "Graduated Cylinder": (["Graduated cylinders"], []),
    "Volumetric Flask": (["Volumetric flasks"], []),
    "Round-bottom Flask": (["Round-bottom flasks", "Florence flasks"], []),
    "Funnel": (["Laboratory funnels"], ["laboratory funnel glass"]),
    "Watch Glass": (["Watch glasses (laboratory)"], []),
    "Bunsen Burner": (["Bunsen burners"], []),
    "Test Tube Rack": (["Tube racks", "Test tube holders"], ["test tube rack"]),
    "Crucible Tongs": (["Crucible tongs"], ["crucible tongs", "laboratory tongs"]),
    "Tripod Stand": (["Laboratory tripods"], ["laboratory tripod", "tripod wire gauze", "bunsen burner tripod"]),
    "Spatula": (["Spatulas"], ["laboratory spatula", "spatula spoon chemistry"]),
    "Mortar and Pestle": (["Mortars and pestles"], []),
    "Thermometer": (["Liquid-in-glass laboratory thermometers", "Liquid-in-glass thermometers"], []),
    "Pipette": (["Pipettes", "Pasteur pipettes"], []),
    "Burette": (["Burettes"], []),
    "Dropper": (["Eye droppers"], ["dropper bottle pipette"]),
    "Petri Dish": (["Petri dishes"], []),
    "Triple Beam Balance": (["Triple beam balances"], ["triple beam balance", "beam balance laboratory"]),
    "Microscope": (["Light microscopes", "Compound microscopes"], []),
    "Magnifying Glass": (["Magnifying glasses"], []),
    "Microscope Slide": (["Microscope slides and coverslips"], []),
    # everyday things that must NOT count as lab items
    "__unknown__": (["Human hands", "Smartphones", "Backpacks", "Classrooms", "Computer keyboards",
                     "Water bottles", "Notebooks", "Desks", "Mugs", "Wallets"], []),
}
UNKNOWN_PER_CATEGORY = 8  # 10 categories x 8 = 80 "not a lab item" photos
SKIP_WORDS = re.compile(r"icon|diagram|drawing|logo|svg|clipart|symbol|scheme|sketch|illustration|stamp|coat of arms|3d", re.I)


def get(url, **kw):
    """GET with patient retries when Wikimedia says we are going too fast (HTTP 429)."""
    for attempt in range(8):
        r = S.get(url, timeout=30, **kw)
        if r.status_code != 429:
            r.raise_for_status()
            time.sleep(0.5)
            return r
        wait = int(r.headers.get("Retry-After", 0) or 0) or 10 * (attempt + 1)
        print(f"  Wikimedia asked us to slow down, waiting {wait}s")
        time.sleep(wait)
    raise RuntimeError("Wikimedia keeps rate-limiting; try again later (finished items are kept)")


def api(**params):
    params.update(format="json", formatversion=2)
    return get(API, params=params).json()


def category_files(cat, depth=1):
    titles, cont = [], {}
    while True:
        d = api(action="query", list="categorymembers", cmtitle=f"Category:{cat}", cmtype="file|subcat", cmlimit=500, **cont)
        for m in d["query"]["categorymembers"]:
            if m["ns"] == 6:
                titles.append(m["title"])
            elif m["ns"] == 14 and depth > 0:
                titles += category_files(m["title"].split(":", 1)[1], depth - 1)
        if "continue" not in d:
            return titles
        cont = d["continue"]


def search_files(phrase):
    d = api(action="query", list="search", srsearch=f"{phrase} filetype:bitmap", srnamespace=6, srlimit=50)
    return [x["title"] for x in d["query"]["search"]]


def file_info(titles):
    """Thumbnail URL + credit for up to 50 files; keeps only JPEG photos, in the original order."""
    d = api(action="query", prop="imageinfo", titles="|".join(titles[:50]),
            iiprop="url|mime|extmetadata|size", iiurlwidth=THUMB_WIDTH)
    by_title = {}
    for p in d["query"]["pages"]:
        ii = (p.get("imageinfo") or [None])[0]
        if not ii or ii.get("mime") != "image/jpeg" or ii.get("width", 0) < 250:
            continue
        meta = ii.get("extmetadata", {})
        author = re.sub("<[^>]+>", "", meta.get("Artist", {}).get("value", "")).strip()
        by_title[p["title"]] = {"title": p["title"], "thumb": ii.get("thumburl") or ii["url"], "page": ii["descriptionurl"],
                                "author": author, "license": meta.get("LicenseShortName", {}).get("value", "")}
    return [by_title[t] for t in titles[:50] if t in by_title]


def title_groups(name, cats, phrases):
    """[(titles, how many photos to take from them)] for one class."""
    seen = set()
    def fresh(ts):
        out = [t for t in dict.fromkeys(ts) if t not in seen and not SKIP_WORDS.search(t)]
        seen.update(out)
        return out
    if name == "__unknown__":  # a few photos from each everyday category
        return [(fresh(category_files(c, depth=0)), UNKNOWN_PER_CATEGORY) for c in cats]
    titles = []
    for c in cats:
        titles += fresh(category_files(c))
    if len(titles) < PER_CLASS * 2:
        for ph in phrases:
            titles += fresh(search_files(ph))
    return [(titles, PER_CLASS)]


def main():
    os.makedirs(BASE, exist_ok=True)
    credits_path = os.path.join(BASE, "CREDITS.csv")
    new_file = not os.path.exists(credits_path)
    with open(credits_path, "a", newline="", encoding="utf-8") as cf:
        w = csv.writer(cf)
        if new_file:
            w.writerow(["class", "file", "author", "license", "source"])
        for name, (cats, phrases) in CLASSES.items():
            folder = os.path.join(BASE, name)
            if os.path.isdir(folder) and len(os.listdir(folder)) >= 10:
                print(f"{name}: already downloaded, skipping")
                continue
            os.makedirs(folder, exist_ok=True)
            for f in os.listdir(folder):  # clear a half-finished earlier attempt
                os.remove(os.path.join(folder, f))
            got = 0
            for titles, want in title_groups(name, cats, phrases):
                took = 0
                for i in range(0, len(titles), 50):  # ask for details only as far as we need
                    for info in file_info(titles[i:i + 50]):
                        if took >= want:
                            break
                        try:
                            data = get(info["thumb"]).content
                        except requests.RequestException as e:
                            print(f"  skip {info['title']}: {e}")
                            continue
                        got += 1; took += 1
                        fn = f"{got:02d}.jpg"
                        with open(os.path.join(folder, fn), "wb") as f:
                            f.write(data)
                        w.writerow([name, f"{name}/{fn}", info["author"], info["license"], info["page"]])
                        cf.flush()
                    if took >= want:
                        break
            print(f"{name}: {got} photos", flush=True)
    print("Done. Photos are in", BASE)


if __name__ == "__main__":
    sys.exit(main())
