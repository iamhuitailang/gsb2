"""乙应用：本地演示客户端，使用自己的凭据访问工单系统。

用法：
  python3 app_yi.py exchange <授权码>     换取访问凭据
  python3 app_yi.py titles <访问凭据>     查看工单标题（需“只读标题”）
  python3 app_yi.py update <访问凭据> <工单ID> <状态>   更新状态（需“更新状态”）
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ticket_client import TicketClient

BASE_URL = "http://localhost:5051"
CLIENT_ID = "app-yi"
CLIENT_SECRET = "yi-secret"


def main(argv):
    client = TicketClient(BASE_URL, CLIENT_ID, CLIENT_SECRET)
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "exchange":
        print(client.exchange_code(argv[2]))
    elif cmd == "titles":
        for t in client.list_titles(argv[2]):
            print(f"#{t['id']} {t['title']}")
    elif cmd == "update":
        print(client.update_status(argv[2], int(argv[3]), argv[4]))
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
