#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WSGI 入口文件 - 供宝塔面板 Gunicorn 调用
"""

import eventlet
eventlet.monkey_patch()

from app import app, socketio

# Gunicorn 会使用这个 callable
application = app

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000)
