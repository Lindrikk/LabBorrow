# STEM STARR LabBorrow

Laboratory equipment borrowing system of **STEM STARR, Aurelio Arago Memorial National High School**.
Developed by **Lindrik Agabas**.

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

1. **Admin → Train AI → Add starter AI**: the app instantly knows 23 standard lab items
   (glassware, Bunsen burner, microscope, pipette, balance…) and adds them to Items.
   Set the real quantities in **Admin → Items** and delete items your lab doesn't have.
2. **Admin → Train AI**: for best results, also teach it *your* items. Choose an item, point the
   camera at it and **hold** *Hold to capture* while turning it (10–30 samples per item, different
   angles and lighting). Add **Not a lab item** samples of your own room, hands and bags too.
   Tap **Save AI model** (it trains for a few seconds, then saves).
3. **Student → Sign up**, then **Scan**. Hold one item in the frame. When the AI recognises it for
   about a second, it is **recorded as borrowed automatically**. There is a 15-second Undo in case it was wrong.
4. To give an item back: **Scan → Return** and scan it. Admins can also tap **Mark returned**.
5. **Admin → Dashboard / Records**: live list of borrowed and overdue items, search, CSV export.

## How the AI works (`static/detector.js`)

- **MobileNet v2** (pretrained, runs on the phone with TensorFlow.js) turns each camera frame into
  a 1280-number "fingerprint".
- Every training photo is stored as a fingerprint in `data/model.json`. When the admin saves, a small
  classifier layer is trained on top of all fingerprints to tell the items apart.
- A frame counts as a detection only if that layer is at least 60% sure (`MIN_PROBABILITY`) and the
  answer is not "Not a lab item". That is how non-lab objects are rejected.
- The same item must be recognised for 4 frames in a row (`STABLE_FRAMES` in `app.js`) before it is recorded.
- Students download only the trained layer (small), not the stored samples.

If the AI mixes up items, add more samples of both. If it accepts random objects, add more
*Not a lab item* samples or raise `MIN_PROBABILITY`.

### Starter AI

`static/starter_model.json` holds fingerprints of about 30 free photos per item from
Wikimedia Commons (authors and licenses: `tools/starter_photo_credits.csv`). To rebuild it:

```
python tools/fetch_pretrain_images.py
```

Then **Admin → Train AI → Rebuild starter AI from downloaded photos**. It reports accuracy on
photos it never saw (every 5th photo is held back for this test).

## Files

| File | What it does |
|---|---|
| `app.py` | Flask server: accounts, items, borrow/return records, admin API, saves the AI model |
| `static/app.js` | All screens (login, scan, my items, dashboard, records, items, train AI, students) |
| `static/detector.js` | AI detector + camera helper |
| `static/starter_model.json` | Starter AI for 23 standard lab items |
| `tools/fetch_pretrain_images.py` | Downloads the starter photos from Wikimedia Commons |
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
