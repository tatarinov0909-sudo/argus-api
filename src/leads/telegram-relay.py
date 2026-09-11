#!/usr/bin/env python3
"""Private WireGuard relay for Argus landing-lead Telegram notifications."""

import json
import os
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN_HOST = os.environ.get('ARGUS_RELAY_LISTEN_HOST', '10.77.0.2')
LISTEN_PORT = int(os.environ.get('ARGUS_RELAY_LISTEN_PORT', '8787'))
TOKEN_FILE = os.environ.get('ARGUS_RELAY_TOKEN_FILE', '/etc/argus-relay/token')
MAX_BODY = 128 * 1024
MAX_TELEGRAM_RESPONSE = 1024 * 1024
ALLOWED_METHODS = {'getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage'}
BOT_TOKEN = re.compile(r'^\d{5,20}:[A-Za-z0-9_-]{25,100}$')


def load_relay_token():
    with open(TOKEN_FILE, encoding='ascii') as token_file:
        token = token_file.read().strip()
    if len(token) < 32:
        raise RuntimeError('relay token is too short')
    return token


RELAY_TOKEN = load_relay_token()


class RelayHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, _format, *_args):
        # Requests contain bot tokens and applicant text. Do not log either.
        return

    def respond(self, status, data):
        encoded = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path == '/health':
            self.respond(200, {'ok': True})
        else:
            self.respond(404, {'ok': False})

    def do_POST(self):
        method = self.path.removeprefix('/telegram/')
        if self.path != '/telegram/' + method or method not in ALLOWED_METHODS:
            self.respond(404, {'ok': False})
            return
        if self.headers.get('Authorization') != 'Bearer ' + RELAY_TOKEN:
            self.respond(401, {'ok': False})
            return
        try:
            length = int(self.headers.get('Content-Length', ''))
            if length < 2 or length > MAX_BODY:
                raise ValueError
            request = json.loads(self.rfile.read(length))
            token, body = request['token'], request['body']
            if not isinstance(body, dict) or not isinstance(token, str) or not BOT_TOKEN.fullmatch(token):
                raise ValueError
        except (KeyError, ValueError, TypeError, json.JSONDecodeError):
            self.respond(400, {'ok': False})
            return

        payload = json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        telegram_request = urllib.request.Request(
            f'https://api.telegram.org/bot{token}/{method}', data=payload,
            headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(telegram_request, timeout=10) as response:
                status = response.status
                raw = response.read(MAX_TELEGRAM_RESPONSE + 1)
        except urllib.error.HTTPError as error:
            status = error.code
            raw = error.read(MAX_TELEGRAM_RESPONSE + 1)
        except Exception:
            self.respond(503, {'ok': False})
            return
        if len(raw) > MAX_TELEGRAM_RESPONSE:
            self.respond(502, {'ok': False})
            return
        try:
            response = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError):
            self.respond(502, {'ok': False})
            return
        self.respond(status, response)


if __name__ == '__main__':
    ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), RelayHandler).serve_forever()
