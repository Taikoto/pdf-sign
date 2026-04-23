"""
Flask 后端 - 用户注册/登录 + 签名 CRUD
"""
import sqlite3, hashlib, uuid, os
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder='.')
CORS(app)
DB = os.path.join(os.path.dirname(__file__), 'signatures.db')


# ─── DB 初始化 ───────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as db:
        db.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id      TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                pw_hash  TEXT NOT NULL
            )
        ''')
        db.execute('''
            CREATE TABLE IF NOT EXISTS signatures (
                id        TEXT PRIMARY KEY,
                user_id   TEXT NOT NULL,
                name      TEXT NOT NULL,
                sig_type  TEXT NOT NULL,
                content   TEXT NOT NULL,
                color     TEXT DEFAULT '',
                extra     TEXT DEFAULT '{}',
                created_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        ''')
        db.commit()


init_db()


# ─── 工具函数 ────────────────────────────────────────────
def hash_pw(pw: str) -> str:
    return hashlib.sha256(pw.encode()).hexdigest()


def make_token(uid: str) -> str:
    raw = f"{uid}:{uuid.uuid4().hex}"
    return raw + ':' + hash_pw(raw)


def verify_token(token: str) -> str | None:
    try:
        body, sig = token.rsplit(':', 1)
        if sig == hash_pw(body):
            return body.split(':')[0]
    except Exception:
        pass
    return None


# ─── 认证装饰器 ──────────────────────────────────────────
def auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        uid = verify_token(token)
        if not uid:
            return jsonify({'error': '未授权'}), 401
        return f(uid, *args, **kwargs)
    return wrapper


# ─── 静态文件 & 健康检查 ─────────────────────────────────
@app.route('/api/health')
def health():
    return jsonify({'status': 'ok'})


@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory('.', filename)


# ─── 注册 ────────────────────────────────────────────────
@app.route('/api/register', methods=['POST'])
def register():
    data = request.json
    username = data.get('username', '').strip()
    password = data.get('password', '')

    if len(username) < 2:
        return jsonify({'error': '用户名至少 2 个字符'}), 400
    if len(password) < 6:
        return jsonify({'error': '密码至少 6 位'}), 400

    uid = uuid.uuid4().hex
    pw_hash = hash_pw(password)
    try:
        with get_db() as db:
            db.execute(
                'INSERT INTO users (id, username, pw_hash) VALUES (?, ?, ?)',
                (uid, username, pw_hash)
            )
            db.commit()
        token = make_token(uid)
        return jsonify({'token': token, 'username': username})
    except sqlite3.IntegrityError:
        return jsonify({'error': '用户名已被占用'}), 409


# ─── 登录 ────────────────────────────────────────────────
@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('username', '').strip()
    password = data.get('password', '')

    with get_db() as db:
        row = db.execute(
            'SELECT id, pw_hash FROM users WHERE username = ?', (username,)
        ).fetchone()

    if not row or row['pw_hash'] != hash_pw(password):
        return jsonify({'error': '用户名或密码错误'}), 401

    token = make_token(row['id'])
    return jsonify({'token': token, 'username': username})


# ─── 获取签名列表 ────────────────────────────────────────
@app.route('/api/signatures', methods=['GET'])
@auth
def get_sigs(uid):
    with get_db() as db:
        rows = db.execute(
            'SELECT id, name, sig_type, content, color, extra, created_at '
            'FROM signatures WHERE user_id = ? ORDER BY created_at DESC',
            (uid,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])


# ─── 保存签名 ────────────────────────────────────────────
@app.route('/api/signatures', methods=['POST'])
@auth
def save_sig(uid):
    data = request.json
    name     = (data.get('name') or '未命名').strip()
    sig_type = data.get('sig_type', 'draw')
    content  = data.get('content', '')
    color    = data.get('color', '')
    extra    = data.get('extra', '{}')

    if not content:
        return jsonify({'error': '签名内容不能为空'}), 400

    sid  = uuid.uuid4().hex
    ts   = int(__import__('time').time())

    with get_db() as db:
        db.execute(
            'INSERT INTO signatures (id, user_id, name, sig_type, content, color, extra, created_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (sid, uid, name, sig_type, content, color, extra, ts)
        )
        db.commit()

    return jsonify({'id': sid, 'created_at': ts})


# ─── 删除签名 ────────────────────────────────────────────
@app.route('/api/signatures/<sid>', methods=['DELETE'])
@auth
def del_sig(uid, sid):
    with get_db() as db:
        cur = db.execute(
            'DELETE FROM signatures WHERE id = ? AND user_id = ?', (sid, uid)
        )
        db.commit()
    if cur.rowcount == 0:
        return jsonify({'error': '签名不存在'}), 404
    return jsonify({'ok': True})


# ─── 启动 ────────────────────────────────────────────────
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5050, debug=False)
