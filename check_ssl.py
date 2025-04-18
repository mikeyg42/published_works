#!/usr/bin/env python3
import ssl
import socket
import sys
import os

def check_cert(host, port, cert_file=None, key_file=None, verify=False):
    context = ssl.create_default_context()
    
    if not verify:
        print("Certificate verification disabled")
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    
    if cert_file and key_file:
        print(f"Using certificate: {cert_file}")
        print(f"Using key: {key_file}")
        
        if not os.path.exists(cert_file):
            print(f"Error: Certificate file {cert_file} does not exist")
            return False
            
        if not os.path.exists(key_file):
            print(f"Error: Key file {key_file} does not exist")
            return False
            
        try:
            context.load_cert_chain(certfile=cert_file, keyfile=key_file)
            print("Certificate and key loaded successfully")
        except Exception as e:
            print(f"Error loading certificate and key: {e}")
            return False
    
    try:
        with socket.create_connection((host, port)) as sock:
            with context.wrap_socket(sock, server_hostname=host) as ssock:
                cert = ssock.getpeercert()
                print(f"Connection to {host}:{port} successful")
                print(f"Certificate: {cert}")
                return True
    except Exception as e:
        print(f"Error connecting to {host}:{port}: {e}")
        return False

if __name__ == "__main__":
    host = "127.0.0.1"
    port = 8000
    cert_file = "/Users/mikeglendinning/projects/maze_solver_app/frontend/ssl/server.crt"
    key_file = "/Users/mikeglendinning/projects/maze_solver_app/frontend/ssl/server.key"
    
    print(f"Checking SSL connection to {host}:{port}")
    success = check_cert(host, port, cert_file, key_file, verify=False)
    
    if success:
        print("SSL connection successful")
    else:
        print("SSL connection failed")
        sys.exit(1) 