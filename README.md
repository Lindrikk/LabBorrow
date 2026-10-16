# LabBorrow

A phone app that uses the camera to recognise **laboratory materials only** and records them as
borrowed by the logged-in student. Admins see who borrowed what, what is overdue, and what was returned.

It is a web app (PWA). Students open it in the phone browser and can tap **Add to Home screen**,
so it works like an installed app. One Python server holds the accounts and records for everyone.

## Run it

```bash
pip install -r requirements.txt
python app.py
```

Open http://localhost:5000 on the PC.

**On phones (same Wi-Fi as the PC):** browsers only allow the live camera over HTTPS, so start with:

```bash
python app.py --https
```

Then open `https://<PC-IP-address>:5000` on the phone (find the IP with `ipconfig`) and accept the
"not secure" certificate warning. Without HTTPS the **Use a photo** button still works.

Default admin: `admin` / `admin123`. Change it in **Account** after the first login
(or set `LAB_ADMIN_USER` / `LAB_ADMIN_PASS` before the first run).

## How to use

1. **Admin → Items**: add each item type and how many the lab owns.
2. **Admin → Train AI**: choose an item, point the camera at it and **hold** *Hold to capture*
   while turning it (30+ samples per item, different angles and lighting). Then train
   **Not a lab item** with hands, faces, phones, bags and the empty table. Tap **Save AI model**.
3. **Student → Sign up**, then **Scan**. Hold one item in the frame. When the AI recognises it for
   about a second, it is **recorded as borrowed automatically**. There is a 15-second Undo in case it was wrong.
4. To give an item back: **Scan → Return** and scan it. Admins can also tap **Mark returned**.
5. **Admin → Dashboard / Records**: live list of borrowed and overdue items, search, CSV export.

## How the AI works (`static/detector.js`)

- **MobileNet v2** (pretrained, runs on the phone with TensorFlow.js) turns each camera frame into
  a 1280-number "fingerprint".
- The admin's training photos are stored as fingerprints in `data/model.json`.
- A new frame is compared with all samples (k-nearest-neighbours, k = 7). It counts as a detection
  only if most neighbours agree (`MIN_CONFIDENCE` 70%), the closest match is similar enough
  (`MIN_SIMILARITY` 0.7), and it is not the "Not a lab item" class. That is how non-lab objects are rejected.
- The same item must be recognised for 4 frames in a row (`STABLE_FRAMES` in `app.js`) before it is recorded.

If the AI mixes up items, add more samples of both. If it accepts random objects, add more
*Not a lab item* samples or raise `MIN_SIMILARITY`.

## Files

| File | What it does |
|---|---|
| `app.py` | Flask server: accounts, items, borrow/return records, admin API, saves the AI model |
| `static/app.js` | All screens (login, scan, my items, dashboard, records, items, train AI, students) |
| `static/detector.js` | AI detector + camera helper |
| `static/styles.css` | Mobile-first styles, light/dark mode |
| `data/` | Created on first run: `labborrow.db` (SQLite), `model.json`, session secret |

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `LAB_BORROW_HOURS` | `24` | Hours until a borrowed item is overdue |
| `LAB_ADMIN_USER` / `LAB_ADMIN_PASS` | `admin` / `admin123` | First admin account |
| `PORT` | `5000` | Server port |

## Ideas for your modifications

- Put it on a free host (Render, PythonAnywhere, Railway) for real HTTPS so phones don't get the certificate warning
- Borrow several of the same item at once (quantity picker)
- Admin approval before a borrow counts
- Email or SMS reminders for overdue items
- A stronger detector: train a YOLO model on your own photos and export it to TensorFlow.js
