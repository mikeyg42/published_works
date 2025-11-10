from http.server import HTTPServer, SimpleHTTPRequestHandler
import ssl
import os

class CORSRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

def run(server_class=HTTPServer, handler_class=CORSRequestHandler, port=8443):
    server_address = ('', port)
    httpd = server_class(server_address, handler_class)
    
    # Configure SSL
    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_context.load_cert_chain(
        certfile='ssl/server.crt',
        keyfile='ssl/server.key'
    )
    httpd.socket = ssl_context.wrap_socket(httpd.socket, server_side=True)
    
    print(f"Serving test page at https://localhost:{port}/websocket-test.html")
    httpd.serve_forever()

if __name__ == '__main__':
    run() 