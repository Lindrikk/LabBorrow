"""
LabBorrow - camera-based laboratory equipment borrowing system.

Backend: Flask + SQLite. Serves the phone web app (static/) and a JSON API.
Run:  python app.py            (http://localhost:5000, camera works on this PC)
      python app.py --https    (https on your Wi-Fi so phones can use the live camera)
"""
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("LAB_DATA_DIR") or os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "labborrow.db")
MODEL_PATH = os.path.join(DATA_DIR, "model.json")
SECRET_PATH = os.path.join(DATA_DIR, "secret.key")
PRETRAIN_DIR = os.path.join(BASE_DIR, "pretrain_images")  # filled by tools/fetch_pretrain_images.py
STARTER_PATH = os.path.join(BASE_DIR, "static", "starter_model.json")

DEFAULT_ADMIN_USER = os.environ.get("LAB_ADMIN_USER", "admin")
DEFAULT_ADMIN_PASS = os.environ.get("LAB_ADMIN_PASS", "admin123")
BORROW_HOURS = int(os.environ.get("LAB_BORROW_HOURS", "24"))  # due time after borrowing
UNDO_SECONDS = 15  # a student can cancel an automatic borrow within this window

os.makedirs(DATA_DIR, exist_ok=True)


def load_secret():
    if not os.path.exists(SECRET_PATH):
        with open(SECRET_PATH, "wb") as f:
            f.write(os.urandom(32))
    with open(SECRET_PATH, "rb") as f:
        return f.read()


app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = load_secret()
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # trained model JSON can be a few MB
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=7)


# ---------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    student_no TEXT,
    section TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'admin')),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    category TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS borrows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    item_id INTEGER NOT NULL REFERENCES items(id),
    borrowed_at TEXT NOT NULL,
    due_at TEXT NOT NULL,
    returned_at TEXT,
    confidence REAL,
    returned_by TEXT
);
"""

STARTER_ITEMS = [
    ("Beaker", "Glassware", 10),
    ("Erlenmeyer Flask", "Glassware", 10),
    ("Test Tube", "Glassware", 30),
    ("Graduated Cylinder", "Glassware", 8),
    ("Bunsen Burner", "Heating", 5),
    ("Microscope", "Optics", 4),
]


def now():
    return datetime.now().replace(microsecond=0)


def iso(dt):
    return dt.isoformat(sep=" ")


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    if not db.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():
        db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, created_at) VALUES (?,?,?,?,?)",
            (DEFAULT_ADMIN_USER, "Laboratory Admin", generate_password_hash(DEFAULT_ADMIN_PASS), "admin", iso(now())),
        )
        print(f"[LabBorrow] Created admin account  user: {DEFAULT_ADMIN_USER}  pass: {DEFAULT_ADMIN_PASS}  (change it!)")
    if not db.execute("SELECT 1 FROM items").fetchone():
        db.executemany(
            "INSERT INTO items (name, category, quantity, created_at) VALUES (?,?,?,?)",
            [(n, c, q, iso(now())) for n, c, q in STARTER_ITEMS],
        )
    db.commit()
    db.close()


# ---------------------------------------------------------------- helpers

def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    return get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def login_required(role=None):
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = current_user()
            if not user:
                return jsonify(error="Please log in."), 401
            if role and user["role"] != role:
                return jsonify(error="Not allowed."), 403
            g.user = user
            return fn(*args, **kwargs)
        return wrapper
    return deco


def user_json(u):
    return {k: u[k] for k in ("id", "username", "full_name", "student_no", "section", "role")}


def item_availability(db):
    rows = db.execute(
        """SELECT i.*, COUNT(b.id) AS out
           FROM items i LEFT JOIN borrows b ON b.item_id=i.id AND b.returned_at IS NULL
           GROUP BY i.id ORDER BY i.name"""
    ).fetchall()
    return [
        {"id": r["id"], "name": r["name"], "category": r["category"], "quantity": r["quantity"],
         "borrowed": r["out"], "available": r["quantity"] - r["out"]}
        for r in rows
    ]


BORROW_SELECT = """
SELECT b.*, i.name AS item_name, i.category, u.full_name, u.username, u.student_no, u.section
FROM borrows b JOIN items i ON i.id=b.item_id JOIN users u ON u.id=b.user_id
"""


def borrow_json(r):
    status = "returned" if r["returned_at"] else ("overdue" if r["due_at"] < iso(now()) else "borrowed")
    return {
        "id": r["id"], "item_id": r["item_id"], "item_name": r["item_name"], "category": r["category"],
        "user_id": r["user_id"], "full_name": r["full_name"], "username": r["username"],
        "student_no": r["student_no"], "section": r["section"],
        "borrowed_at": r["borrowed_at"], "due_at": r["due_at"], "returned_at": r["returned_at"],
        "returned_by": r["returned_by"], "confidence": r["confidence"], "status": status,
    }


# ---------------------------------------------------------------- auth

@app.post("/api/register")
def register():
    d = request.get_json(force=True)
    username = (d.get("username") or "").strip().lower()
    full_name = (d.get("full_name") or "").strip()
    password = d.get("password") or ""
    if len(username) < 3 or not full_name or len(password) < 6:
        return jsonify(error="Username (3+ chars), full name and password (6+ chars) are required."), 400
    db = get_db()
    try:
        cur = db.execute(
            "INSERT INTO users (username, full_name, student_no, section, password_hash, role, created_at)"
            " VALUES (?,?,?,?,?, 'student', ?)",
            (username, full_name, (d.get("student_no") or "").strip(), (d.get("section") or "").strip(),
             generate_password_hash(password), iso(now())),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify(error="That username is already taken."), 409
    session.permanent = True
    session["uid"] = cur.lastrowid
    return jsonify(user=user_json(current_user()))


@app.post("/api/login")
def login():
    d = request.get_json(force=True)
    user = get_db().execute("SELECT * FROM users WHERE username=?",
                            ((d.get("username") or "").strip().lower(),)).fetchone()
    if not user or not check_password_hash(user["password_hash"], d.get("password") or ""):
        return jsonify(error="Wrong username or password."), 401
    session.permanent = True
    session["uid"] = user["id"]
    return jsonify(user=user_json(user))


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
def me():
    user = current_user()
    return jsonify(user=user_json(user) if user else None)


@app.post("/api/change-password")
@login_required()
def change_password():
    d = request.get_json(force=True)
    if not check_password_hash(g.user["password_hash"], d.get("old_password") or ""):
        return jsonify(error="Current password is wrong."), 400
    if len(d.get("new_password") or "") < 6:
        return jsonify(error="New password must be 6+ characters."), 400
    db = get_db()
    db.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(d["new_password"]), g.user["id"]))
    db.commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- items & AI model

@app.get("/api/items")
@login_required()
def list_items():
    return jsonify(items=item_availability(get_db()))


@app.post("/api/items")
@login_required("admin")
def add_item():
    d = request.get_json(force=True)
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify(error="Item name is required."), 400
    db = get_db()
    try:
        db.execute("INSERT INTO items (name, category, quantity, created_at) VALUES (?,?,?,?)",
                   (name, (d.get("category") or "").strip(), max(0, int(d.get("quantity") or 1)), iso(now())))
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify(error="An item with that name already exists."), 409
    return jsonify(items=item_availability(db))


@app.put("/api/items/<int:item_id>")
@login_required("admin")
def update_item(item_id):
    d = request.get_json(force=True)
    db = get_db()
    db.execute("UPDATE items SET name=COALESCE(?, name), category=COALESCE(?, category), quantity=COALESCE(?, quantity) WHERE id=?",
               (d.get("name"), d.get("category"), d.get("quantity"), item_id))
    db.commit()
    return jsonify(items=item_availability(db))


@app.delete("/api/items/<int:item_id>")
@login_required("admin")
def delete_item(item_id):
    db = get_db()
    if db.execute("SELECT 1 FROM borrows WHERE item_id=?", (item_id,)).fetchone():
        return jsonify(error="This item has borrow history, so it can't be deleted. Set its quantity to 0 instead."), 400
    db.execute("DELETE FROM items WHERE id=?", (item_id,))
    db.commit()
    return jsonify(items=item_availability(db))


@app.get("/api/model")
@login_required()
def get_model():
    if not os.path.exists(MODEL_PATH):
        return jsonify(model=None)
    if g.user["role"] == "admin":
        return send_from_directory(DATA_DIR, "model.json", mimetype="application/json", max_age=0)
    # Students only need the trained classifier head, not every training sample (much smaller download).
    with open(MODEL_PATH) as f:
        model = json.load(f)["model"]
    if model.get("head"):
        for c in model["classes"].values():
            c.pop("samples", None)
    return jsonify(model=model)


@app.post("/api/model")
@login_required("admin")
def save_model():
    model = request.get_json(force=True)
    if not isinstance(model, dict) or "classes" not in model:
        return jsonify(error="Invalid model data."), 400
    model["saved_at"] = iso(now())
    with open(MODEL_PATH, "w") as f:
        json.dump({"model": model}, f)
    return jsonify(ok=True, saved_at=model["saved_at"])


@app.get("/api/admin/pretrain-images")
@login_required("admin")
def pretrain_images():
    """Lists the downloaded starter photos, so the admin page can rebuild the starter AI from them."""
    classes = {}
    if os.path.isdir(PRETRAIN_DIR):
        for name in sorted(os.listdir(PRETRAIN_DIR)):
            folder = os.path.join(PRETRAIN_DIR, name)
            if os.path.isdir(folder):
                files = sorted(f for f in os.listdir(folder) if f.lower().endswith(".jpg"))
                if files:
                    classes[name] = files
    return jsonify(classes=classes)


@app.get("/pretrain/<path:path>")
@login_required("admin")
def pretrain_file(path):
    return send_from_directory(PRETRAIN_DIR, path)


@app.post("/api/admin/starter-model")
@login_required("admin")
def save_starter_model():
    model = request.get_json(force=True)
    if not isinstance(model, dict) or "classes" not in model:
        return jsonify(error="Invalid model data."), 400
    model["built_at"] = iso(now())
    with open(STARTER_PATH, "w") as f:
        json.dump(model, f)
    return jsonify(ok=True)


# ---------------------------------------------------------------- borrowing

@app.post("/api/borrow")
@login_required("student")
def borrow():
    d = request.get_json(force=True)
    db = get_db()
    item = next((i for i in item_availability(db) if i["id"] == d.get("item_id")), None)
    if not item:
        return jsonify(error="Unknown item."), 404
    if item["available"] <= 0:
        return jsonify(error=f"No {item['name']} available right now (all {item['quantity']} are borrowed)."), 409
    t = now()
    cur = db.execute(
        "INSERT INTO borrows (user_id, item_id, borrowed_at, due_at, confidence) VALUES (?,?,?,?,?)",
        (g.user["id"], item["id"], iso(t), iso(t + timedelta(hours=BORROW_HOURS)), d.get("confidence")),
    )
    db.commit()
    row = db.execute(BORROW_SELECT + " WHERE b.id=?", (cur.lastrowid,)).fetchone()
    return jsonify(borrow=borrow_json(row), undo_seconds=UNDO_SECONDS)


@app.post("/api/borrow/<int:borrow_id>/undo")
@login_required("student")
def undo_borrow(borrow_id):
    db = get_db()
    row = db.execute("SELECT * FROM borrows WHERE id=? AND user_id=? AND returned_at IS NULL",
                     (borrow_id, g.user["id"])).fetchone()
    if not row:
        return jsonify(error="Nothing to undo."), 404
    if datetime.fromisoformat(row["borrowed_at"]) < now() - timedelta(seconds=UNDO_SECONDS + 5):
        return jsonify(error="Too late to undo. Return the item instead."), 400
    db.execute("DELETE FROM borrows WHERE id=?", (borrow_id,))
    db.commit()
    return jsonify(ok=True)


@app.post("/api/return")
@login_required()
def return_item():
    """Students return by scanning (item_id); admins can close any record (borrow_id)."""
    d = request.get_json(force=True)
    db = get_db()
    if g.user["role"] == "admin" and d.get("borrow_id"):
        row = db.execute("SELECT * FROM borrows WHERE id=? AND returned_at IS NULL", (d["borrow_id"],)).fetchone()
    else:
        row = db.execute(
            "SELECT * FROM borrows WHERE user_id=? AND item_id=? AND returned_at IS NULL ORDER BY borrowed_at LIMIT 1",
            (g.user["id"], d.get("item_id")),
        ).fetchone()
    if not row:
        return jsonify(error="You have no borrowed item of this kind to return."), 404
    who = "admin" if g.user["role"] == "admin" else "scan"
    db.execute("UPDATE borrows SET returned_at=?, returned_by=? WHERE id=?", (iso(now()), who, row["id"]))
    db.commit()
    row = db.execute(BORROW_SELECT + " WHERE b.id=?", (row["id"],)).fetchone()
    return jsonify(borrow=borrow_json(row))


@app.get("/api/my-borrows")
@login_required()
def my_borrows():
    rows = get_db().execute(BORROW_SELECT + " WHERE b.user_id=? ORDER BY b.borrowed_at DESC", (g.user["id"],)).fetchall()
    return jsonify(borrows=[borrow_json(r) for r in rows])


# ---------------------------------------------------------------- admin

@app.get("/api/admin/borrows")
@login_required("admin")
def admin_borrows():
    status = request.args.get("status", "all")
    rows = get_db().execute(BORROW_SELECT + " ORDER BY b.borrowed_at DESC LIMIT 1000").fetchall()
    data = [borrow_json(r) for r in rows]
    if status == "active":
        data = [b for b in data if b["status"] != "returned"]
    elif status in ("borrowed", "overdue", "returned"):
        data = [b for b in data if b["status"] == status]
    return jsonify(borrows=data)


@app.get("/api/admin/summary")
@login_required("admin")
def admin_summary():
    db = get_db()
    rows = [borrow_json(r) for r in db.execute(BORROW_SELECT).fetchall()]
    today = now().date().isoformat()
    return jsonify(
        borrowed=sum(b["status"] == "borrowed" for b in rows),
        overdue=sum(b["status"] == "overdue" for b in rows),
        returned_today=sum(bool(b["returned_at"]) and b["returned_at"].startswith(today) for b in rows),
        students=db.execute("SELECT COUNT(*) FROM users WHERE role='student'").fetchone()[0],
        items=item_availability(db),
    )


@app.get("/api/admin/students")
@login_required("admin")
def admin_students():
    rows = get_db().execute(
        """SELECT u.*, SUM(b.id IS NOT NULL AND b.returned_at IS NULL) AS active, COUNT(b.id) AS total
           FROM users u LEFT JOIN borrows b ON b.user_id=u.id
           WHERE u.role='student' GROUP BY u.id ORDER BY u.full_name"""
    ).fetchall()
    return jsonify(students=[{**user_json(r), "active": r["active"] or 0, "total": r["total"]} for r in rows])


init_db()


# ---------------------------------------------------------------- static app

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    use_https = "--https" in sys.argv
    port = int(os.environ.get("PORT", "5000"))
    print(f"[LabBorrow] Open {'https' if use_https else 'http'}://localhost:{port}")
    if use_https:
        print("[LabBorrow] On your phone (same Wi-Fi) open https://<this-PC-IP>:%d and accept the certificate warning." % port)
    app.run(host="0.0.0.0", port=port, debug=False, ssl_context="adhoc" if use_https else None)
