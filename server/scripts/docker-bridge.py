#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 172.17.0.1:3000（docker 网桥）转发到 127.0.0.1:3000。
为什么需要：kb-web 按项目规矩只绑 127.0.0.1（不许 0.0.0.0），
容器里的 agent 通过 docker0 网关进不来，所以加这一层只绑网桥的转发。
安全性：只监听 docker0 网桥地址，局域网/公网都到不了；不改变 kb-web 的绑定。
"""
import socket
import threading

LISTEN = ('172.17.0.1', 3000)
TARGET = ('127.0.0.1', 3000)


def pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass


def handle(client: socket.socket) -> None:
    try:
        upstream = socket.create_connection(TARGET, timeout=10)
    except OSError:
        client.close()
        return
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()


def main() -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(64)
    print('bridge listening on %s:%d -> %s:%d' % (*LISTEN, *TARGET), flush=True)
    while True:
        client, _ = srv.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == '__main__':
    main()
