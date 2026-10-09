#!/usr/bin/env python3
"""Continum web server com PostgreSQL (Supabase) e biblioteca partilhada."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from http.cookies import CookieError, SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

# Carrega as variáveis de ambiente do ficheiro .env
load_dotenv()

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8001"))
HOST = os.environ.get(
    "HOST",
    "0.0.0.0" if os.environ.get("RENDER", "").lower() == "true" else "127.0.0.1",
)
COOKIE_NAME = "continum_session"
LEGACY_COOKIE_NAME = "estante_session"
SESSION_LIFETIME = 7 * 24 * 60 * 60
PASSWORD_ITERATIONS = 600_000
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{3,30}$")
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
BOOK_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
MAX_PDF_BYTES = 100 * 1024 * 1024
MAX_BOOK_METADATA_BYTES = 2 * 1024 * 1024


def connect_database():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL não configurada no ficheiro .env")
    conn = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
    return conn


def hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)


class ContinumHandler(SimpleHTTPRequestHandler):
    server_version = "ContinumServer/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/session":
            user = self.get_session_user()
            if user is None:
                self.send_json(200, {"authenticated": False})
            else:
                self.send_json(
                    200,
                    {
                        "authenticated": True,
                        "user": {"username": user["username"]},
                    },
                )
            return
        if path == "/api/books":
            self.list_books()
            return
        pdf_match = re.fullmatch(r"/api/books/([A-Za-z0-9_-]{1,100})/pdf", path)
        if pdf_match:
            self.get_pdf(pdf_match.group(1))
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path not in {
            "/api/register",
            "/api/login",
            "/api/logout",
            "/api/books",
            "/api/books/upload",
        }:
            self.send_json(404, {"error": "Endpointo não encontrado."})
            return
        if not self.is_same_origin():
            self.send_json(403, {"error": "Solicitação de origem inválida."})
            return
        if path == "/api/books/upload":
            self.upload_book()
            return
        payload = self.read_json(
            MAX_BOOK_METADATA_BYTES if path == "/api/books" else 8192
        )
        if payload is None:
            return
        if path == "/api/register":
            self.register(payload)
        elif path == "/api/login":
            self.login(payload)
        elif path == "/api/books":
            self.save_book_metadata(payload)
        else:
            self.logout()

    def list_books(self) -> None:
        with connect_database() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT library_books.metadata_json, library_books.uploaded_at,
                           EXISTS(
                               SELECT 1 FROM library_pdfs
                               WHERE library_pdfs.book_id = library_books.id
                           ) AS has_pdf
                    FROM library_books
                    ORDER BY library_books.uploaded_at DESC, library_books.id
                    """
                )
                rows = cursor.fetchall()
        books = []
        for row in rows:
            book = json.loads(row["metadata_json"])
            book["uploadedAt"] = row["uploaded_at"]
            book["hasPdf"] = bool(row["has_pdf"])
            books.append(book)
        self.send_json(200, {"books": books})

    def get_pdf(self, book_id: str) -> None:
        with connect_database() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT content FROM library_pdfs WHERE book_id = %s", (book_id,)
                )
                row = cursor.fetchone()
        if row is None:
            self.send_json(404, {"error": "O PDF deste livro não está disponível."})
            return
        content = bytes(row["content"])
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "private, max-age=3600")
        self.end_headers()
        self.wfile.write(content)

    @staticmethod
    def clean_book_metadata(payload: object) -> dict | None:
        if not isinstance(payload, dict):
            return None
        book_id = payload.get("id")
        title = payload.get("title")
        book_type = payload.get("type")
        if (
            not isinstance(book_id, str)
            or not BOOK_ID_PATTERN.fullmatch(book_id)
            or not isinstance(title, str)
            or not title.strip()
            or len(title) > 500
            or not isinstance(book_type, str)
            or book_type not in {"single", "collection", "volume"}
        ):
            return None
        metadata = {
            key: payload[key]
            for key in (
                "id", "title", "author", "genre", "lang", "type", "reads",
                "rating", "added", "pages", "cover", "tags", "desc", "coll", "n",
            )
            if key in payload
        }
        metadata["title"] = title.strip()
        metadata.pop("fav", None)
        if len(json.dumps(metadata, ensure_ascii=False).encode("utf-8")) > MAX_BOOK_METADATA_BYTES:
            return None
        return metadata

    def save_book_metadata(self, payload: dict) -> None:
        metadata = self.clean_book_metadata(payload)
        if metadata is None:
            self.send_json(400, {"error": "Os dados do livro são inválidos."})
            return
        uploaded_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        with connect_database() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO library_books (id, metadata_json, uploaded_at)
                    VALUES (%s, %s, %s)
                    ON CONFLICT(id) DO UPDATE SET metadata_json = EXCLUDED.metadata_json
                    """,
                    (metadata["id"], json.dumps(metadata, ensure_ascii=False), uploaded_at),
                )
            connection.commit()
        self.send_json(200, {"saved": True, "uploadedAt": uploaded_at})

    def upload_book(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Tamanho de solicitação inválido."})
            return
        if length < 1 or length > MAX_PDF_BYTES + MAX_BOOK_METADATA_BYTES:
            self.send_json(413, {"error": "O PDF excede o limite de 100 MB ou está vazio."})
            return
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data;"):
            self.send_json(415, {"error": "Envie os dados do livro e o PDF em formato multipart."})
            return
        body = self.rfile.read(length)
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii")
            + body
        )
        if not message.is_multipart():
            self.send_json(400, {"error": "O formulário do PDF é inválido."})
            return
        fields = {}
        for part in message.iter_parts():
            field_name = part.get_param("name", header="content-disposition")
            if field_name in {"metadata", "pdf"}:
                fields[field_name] = part.get_payload(decode=True)
        try:
            metadata_payload = json.loads(fields.get("metadata", b""))
        except (UnicodeDecodeError, json.JSONDecodeError):
            metadata_payload = None
        metadata = self.clean_book_metadata(metadata_payload)
        pdf_content = fields.get("pdf")
        if metadata is None or not isinstance(pdf_content, bytes):
            self.send_json(400, {"error": "Informe os dados do livro e selecione um PDF válido."})
            return
        if not pdf_content.startswith(b"%PDF-"):
            self.send_json(400, {"error": "O arquivo enviado não parece ser um PDF válido."})
            return
        if len(pdf_content) > MAX_PDF_BYTES:
            self.send_json(413, {"error": "O PDF excede o limite de 100 MB."})
            return
        uploaded_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        with connect_database() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO library_books (id, metadata_json, uploaded_at)
                    VALUES (%s, %s, %s)
                    ON CONFLICT(id) DO UPDATE SET metadata_json = EXCLUDED.metadata_json
                    """,
                    (metadata["id"], json.dumps(metadata, ensure_ascii=False), uploaded_at),
                )
                cursor.execute(
                    """
                    INSERT INTO library_pdfs (book_id, content) VALUES (%s, %s)
                    ON CONFLICT(book_id) DO UPDATE SET content = EXCLUDED.content
                    """,
                    (metadata["id"], psycopg2.Binary(pdf_content)),
                )
            connection.commit()
        self.send_json(200, {"saved": True, "uploadedAt": uploaded_at})

    def is_same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        parsed = urlsplit(origin)
        return parsed.scheme in {"http", "https"} and parsed.netloc.lower() == self.headers.get(
            "Host", ""
        ).lower()

    def read_json(self, max_bytes: int = 8192) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Tamanho de solicitação inválido."})
            return None
        if length < 1 or length > max_bytes:
            self.send_json(413, {"error": "Solicitação vazia ou grande demais."})
            return None
        try:
            payload = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "O conteúdo enviado não é um JSON válido."})
            return None
        if not isinstance(payload, dict):
            self.send_json(400, {"error": "Formato de solicitação inválido."})
            return None
        return payload

    def register(self, payload: dict) -> None:
        email = payload.get("email")
        username = payload.get("username")
        password = payload.get("password")
        if not all(isinstance(value, str) for value in (email, username, password)):
            self.send_json(400, {"error": "Preencha e-mail, nome de usuário e senha."})
            return
        email = email.strip().lower()
        username = username.strip()
        if len(email) > 254 or not EMAIL_PATTERN.fullmatch(email):
            self.send_json(400, {"error": "Informe um e-mail válido."})
            return
        if not USERNAME_PATTERN.fullmatch(username):
            self.send_json(
                400,
                {"error": "O nome de usuário deve ter de 3 a 30 caracteres (letras, números, . _ -)."},
            )
            return
        if not 8 <= len(password) <= 128:
            self.send_json(400, {"error": "A senha deve ter entre 8 e 128 caracteres."})
            return

        salt = secrets.token_bytes(16)
        try:
            with connect_database() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO users (email, username, password_salt, password_hash, created_at)
                        VALUES (%s, %s, %s, %s, %s)
                        RETURNING id
                        """,
                        (email, username, psycopg2.Binary(salt), psycopg2.Binary(hash_password(password, salt)), int(time.time())),
                    )
                    user_id = cursor.fetchone()["id"]
                connection.commit()
        except psycopg2.IntegrityError:
            self.send_json(409, {"error": "Esse e-mail ou nome de usuário já está cadastrado."})
            return
        self.create_session(user_id)

    def login(self, payload: dict) -> None:
        identifier = payload.get("identifier")
        password = payload.get("password")
        if not isinstance(identifier, str) or not isinstance(password, str):
            self.send_json(400, {"error": "Informe seu e-mail ou nome de usuário e sua senha."})
            return
        identifier = identifier.strip()
        with connect_database() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, password_salt, password_hash FROM users
                    WHERE LOWER(email) = LOWER(%s) OR LOWER(username) = LOWER(%s)
                    """,
                    (identifier, identifier),
                )
                user = cursor.fetchone()
        if (
            user is None
            or len(password) > 128
            or not hmac.compare_digest(hash_password(password, bytes(user["password_salt"])), bytes(user["password_hash"]))
        ):
            self.send_json(401, {"error": "E-mail/nome de usuário ou senha incorretos."})
            return
        self.create_session(user["id"])

    def create_session(self, user_id: int) -> None:
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("ascii")).digest()
        expires_at = int(time.time()) + SESSION_LIFETIME
        with connect_database() as connection:
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM sessions WHERE expires_at <= %s", (int(time.time()),))
                cursor.execute(
                    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (%s, %s, %s)",
                    (psycopg2.Binary(token_hash), user_id, expires_at),
                )
            connection.commit()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header(
            "Set-Cookie",
            f"{COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_LIFETIME}",
        )
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(json.dumps({"authenticated": True}).encode("utf-8"))

    def get_session_user(self) -> dict | None:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError:
            return None
        morsel = cookie.get(COOKIE_NAME) or cookie.get(LEGACY_COOKIE_NAME)
        if morsel is None:
            return None
        token_hash = hashlib.sha256(morsel.value.encode("ascii", errors="ignore")).digest()
        with connect_database() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT users.username FROM sessions
                    JOIN users ON users.id = sessions.user_id
                    WHERE sessions.token_hash = %s AND sessions.expires_at > %s
                    """,
                    (psycopg2.Binary(token_hash), int(time.time())),
                )
                return cursor.fetchone()

    def logout(self) -> None:
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        for cookie_name in (COOKIE_NAME, LEGACY_COOKIE_NAME):
            morsel = cookie.get(cookie_name)
            if morsel is None:
                continue
            token_hash = hashlib.sha256(morsel.value.encode("ascii", errors="ignore")).digest()
            with connect_database() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("DELETE FROM sessions WHERE token_hash = %s", (psycopg2.Binary(token_hash),))
                connection.commit()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Set-Cookie", f"{COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
        self.send_header("Set-Cookie", f"{LEGACY_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b'{"authenticated":false}')

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"Continum disponível em http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), ContinumHandler).serve_forever()
