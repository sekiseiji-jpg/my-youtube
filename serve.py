"""MyPlayer のローカルサーバー。

同じ Wi-Fi につないだスマホ（Android / iPhone）からも開けるように、
PC のすべてのネットワークインターフェースで待ち受け、
スマホで入力するURLを画面に表示する。

    python serve.py [ポート番号]      （既定: 8787）
"""
import http.server
import socket
import socketserver
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_PORT = 8787


class Handler(http.server.SimpleHTTPRequestHandler):
    # .webmanifest を正しい MIME タイプで返す（PWA に必要）
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.webmanifest': 'application/manifest+json',
        '.json': 'application/json',
        '.js': 'text/javascript',
        '.css': 'text/css',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # 編集した内容がすぐ反映されるようにキャッシュさせない
        # （Service Worker 本体は no-store を付けない）
        if not self.path.startswith('/sw.js'):
            self.send_header('Cache-Control', 'no-store')
        self.send_header('Service-Worker-Allowed', '/')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # アクセスログは出さない


def lan_ip():
    """このPCがLANで使っているIPアドレスを調べる（実際の通信は発生しない）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT

    httpd = None
    for p in range(port, port + 10):
        try:
            socketserver.TCPServer.allow_reuse_address = True
            httpd = socketserver.TCPServer(('0.0.0.0', p), Handler)
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        print('ポート %d 付近が使用中です。別のポートを指定してください。' % port)
        return 1

    ip = lan_ip()
    bar = '=' * 54
    print(bar)
    print('  MyPlayer  -  サーバーを起動しました')
    print(bar)
    print('  このPC          :  http://localhost:%d/' % port)
    if ip:
        print('  スマホ・タブレット:  http://%s:%d/' % (ip, port))
        print()
        print('  ※ スマホはこのPCと同じWi-Fiにつないでください。')
        print('  ※ 初回は Windows のファイアウォール確認が出ることがあります。')
        print('     「プライベート ネットワーク」を許可してください。')
    else:
        print('  （LANのIPアドレスを取得できませんでした）')
    print()
    print('  終了するには、この画面で Ctrl+C を押すか、ウィンドウを閉じてください。')
    print(bar)

    try:
        webbrowser.open('http://localhost:%d/' % port)
    except Exception:
        pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n停止しました。')
    finally:
        httpd.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
