"""演示应用共用的工单系统客户端（仅依赖标准库）。"""
import json
import urllib.error
import urllib.parse
import urllib.request


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


class TicketClient:
    def __init__(self, base_url, client_id, client_secret):
        self.base_url = base_url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret

    def _post_form(self, path, data):
        body = urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(self.base_url + path, data=body)
        return self._send(req)

    def _send(self, req):
        try:
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            try:
                message = json.loads(e.read()).get("error", "")
            except Exception:
                message = e.reason
            raise ApiError(e.code, message) from None

    # ---- OAuth ----

    def exchange_code(self, code):
        """用授权码换取访问凭据 + 续期凭据。"""
        return self._post_form("/token", {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        })

    def refresh(self, refresh_token):
        """用续期凭据换新的访问凭据。"""
        return self._post_form("/token", {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        })

    # ---- 工单 API ----

    def list_titles(self, access_token):
        req = urllib.request.Request(self.base_url + "/api/tickets")
        req.add_header("Authorization", f"Bearer {access_token}")
        return self._send(req)["tickets"]

    def update_status(self, access_token, ticket_id, status):
        req = urllib.request.Request(
            f"{self.base_url}/api/tickets/{ticket_id}/status",
            data=json.dumps({"status": status}).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {access_token}"},
            method="POST")
        return self._send(req)["ticket"]
