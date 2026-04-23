"""
PDF 电子签名 - Flask 后端服务
零依赖（仅需 flask），数据存储在 SQLite
"""
import os
import sqlite3
import hashlib
import secrets
import time
import uuid
import re
from datetime import datetime, timedelta, timezone

from flask import Flask, request, jsonify, send_from_directory, g

# ─── App Setup ────────────────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.path.join(BASE_DIR, "signatures.db")

app = Flask(__name__, static_folder=".", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10MB max

# ─── Database Helpers ─────────────────────────────────────────────────────────
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(e=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()

def init_db():
    """创建数据表（如果不存在）"""
    db = sqlite3.connect(DATABASE)
    db.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id         TEXT PRIMARY KEY,
        username   TEXT UNIQUE NOT NULL,
        password   TEXT NOT NULL,
        salt       TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
        token   TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signatures (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        name       TEXT NOT NULL,
        sig_type   TEXT NOT NULL,   -- 'draw' | 'text' | 'date'
        content    TEXT NOT NULL,   -- base64 图片 或 文字内容
        color      TEXT NOT NULL,
        extra      TEXT,            -- JSON: 粗细/字体/大小等
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sigs_user ON signatures(user_id);
    """)
    db.commit()
    db.close()

# ─── Auth Helpers ─────────────────────────────────────────────────────────────
def hash_pw(password: str, salt: str) -> str:
    return hashlib.sha256((password + salt).encode()).hexdigest()

def create_token(user_id: str) -> str:
    """生成简单的 session token（存 DB）"""
    db = get_db()
    token = secrets.token_hex(32)
    expires = int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp())
    db.execute(
        "INSERT OR REPLACE INTO auth_tokens (token, user_id, expires) VALUES (?, ?, ?)",
        (token, user_id, expires)
    )
    db.commit()
    return token

def verify_token(token: str):
    db = get_db()
    row = db.execute(
        "SELECT user_id, expires FROM auth_tokens WHERE token = ?",
        (token,)
    ).fetchone()
    if not row:
        return None
    if int(datetime.now(timezone.utc).timestamp()) > row["expires"]:
        return None
    return row["user_id"]

# ─── Auth Middleware ──────────────────────────────────────────────────────────
def require_auth(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("Authorization", "").replace("Bearer ", "")
        user_id = verify_token(token)
        if not user_id:
            return jsonify({"error": "Unauthorized"}), 401
        g.user_id = user_id
        return f(*args, **kwargs)
    return decorated

# ─── Auth Routes ──────────────────────────────────────────────────────────────
@app.route("/api/register", methods=["POST"])
def register():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not username or not password:
        return jsonify({"error": "用户名和密码不能为空"}), 400
    if len(username) < 2 or len(username) > 30:
        return jsonify({"error": "用户名长度需在 2-30 字之间"}), 400
    if len(password) < 6:
        return jsonify({"error": "密码至少 6 位"}), 400

    db = get_db()
    existing = db.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    if existing:
        return jsonify({"error": "用户名已存在"}), 409

    salt = secrets.token_hex(16)
    pw_hash = hash_pw(password, salt)
    user_id = str(uuid.uuid4())
    now = int(datetime.now(timezone.utc).timestamp())

    db.execute(
        "INSERT INTO users (id, username, password, salt, created_at) VALUES (?, ?, ?, ?, ?)",
        (user_id, username, pw_hash, salt, now)
    )
    db.commit()

    token = create_token(user_id)
    return jsonify({"token": token, "username": username, "userId": user_id})

@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not username or not password:
        return jsonify({"error": "用户名和密码不能为空"}), 400

    db = get_db()
    user = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not user or hash_pw(password, user["salt"]) != user["password"]:
        return jsonify({"error": "用户名或密码错误"}), 401

    token = create_token(user["id"])
    return jsonify({
        "token": token,
        "username": user["username"],
        "userId": user["id"]
    })

@app.route("/api/me", methods=["GET"])
@require_auth
def me():
    db = get_db()
    user = db.execute("SELECT id, username FROM users WHERE id = ?", (g.user_id,)).fetchone()
    return jsonify({"userId": user["id"], "username": user["username"]})

# ─── Signature CRUD ────────────────────────────────────────────────────────────
@app.route("/api/signatures", methods=["GET"])
@require_auth
def list_signatures():
    db = get_db()
    rows = db.execute(
        "SELECT id, name, sig_type, content, color, extra, created_at "
        "FROM signatures WHERE user_id = ? ORDER BY created_at DESC",
        (g.user_id,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/signatures", methods=["POST"])
@require_auth
def save_signature():
    data = request.get_json() or {}
    name = (data.get("name") or "").strip() or "未命名签名"
    sig_type = data.get("sig_type") or "draw"
    content = data.get("content") or ""
    color = data.get("color") or "#1a1a2e"
    extra = data.get("extra") or ""

    if not content:
        return jsonify({"error": "签名内容不能为空"}), 400

    sig_id = str(uuid.uuid4())
    now = int(datetime.now(timezone.utc).timestamp())

    db = get_db()
    db.execute(
        "INSERT INTO signatures (id, user_id, name, sig_type, content, color, extra, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (sig_id, g.user_id, name, sig_type, content, color, extra, now)
    )
    db.commit()

    return jsonify({"id": sig_id, "name": name, "created_at": now})

@app.route("/api/signatures/<sig_id>", methods=["DELETE"])
@require_auth
def delete_signature(sig_id):
    db = get_db()
    cur = db.execute(
        "DELETE FROM signatures WHERE id = ? AND user_id = ?",
        (sig_id, g.user_id)
    )
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "签名不存在"}), 404
    return jsonify({"ok": True})

@app.route("/api/signatures/<sig_id>", methods=["PUT"])
@require_auth
def rename_signature(sig_id):
    data = request.get_json() or {}
    name = (data.get("name") or "").strip() or "未命名签名"
    db = get_db()
    cur = db.execute(
        "UPDATE signatures SET name = ? WHERE id = ? AND user_id = ?",
        (name, sig_id, g.user_id)
    )
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "签名不存在"}), 404
    return jsonify({"ok": True})

# ─── Serve Frontend ───────────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(".", "index.html")

# ─── Init ─────────────────────────────────────────────────────────────────────
init_db()

if __name__ == "__main__":
    print("✅ PDF 电子签名后端已启动")
    print("📍 访问地址：http://localhost:5050")
    print("🔧 API 端口：5050")
    app.run(host="0.0.0.0", port=5050, debug=False)
