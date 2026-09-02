#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
国防知识竞赛 - 计分系统后端
Flask + SocketIO 实现实时同步
"""

# 必须在导入其他库之前加载 eventlet
import eventlet
eventlet.monkey_patch()

import json
import os
from flask import Flask, render_template, jsonify, request
from flask_socketio import SocketIO, emit
from questions import QUESTIONS, COMPANY_NAMES

app = Flask(__name__)
app.config['SECRET_KEY'] = 'defense-contest-2024'
app.config['TEMPLATES_AUTO_RELOAD'] = True
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'state.json')


def init_state():
    """初始化14个连队状态，基础分0"""
    return {
        'companies': [
            {'id': i + 1, 'name': COMPANY_NAMES[i], 'score': 0, 'active': True}
            for i in range(14)
        ],
        'current_slide': 0,
    }


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                s = json.load(f)
                # 修复负分：确保所有分数 >= 0
                for c in s.get('companies', []):
                    if c.get('score', 0) < 0:
                        c['score'] = 0
                return s
        except Exception:
            pass
    return init_state()


def save_state():
    try:
        with open(STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


state = load_state()


# ========== 路由 ==========
@app.route('/')
def display():
    """大屏展示页面"""
    return render_template('display.html', questions=QUESTIONS, companies=state['companies'])


@app.route('/mobile')
def mobile():
    """手机端控制页面"""
    return render_template('mobile.html', companies=state['companies'])


@app.route('/api/state')
def api_state():
    """获取当前状态 API"""
    return jsonify(state)


# ========== WebSocket 事件 ==========
@socketio.on('connect')
def on_connect():
    emit('state_sync', state)


@socketio.on('update_score')
def on_update_score(data):
    """加减分: {company_id: 1, delta: 10}"""
    cid = data.get('company_id')
    delta = data.get('delta', 0)
    for c in state['companies']:
        if c['id'] == cid:
            c['score'] = max(0, c['score'] + delta)
            break
    save_state()
    emit('state_sync', state, broadcast=True)


@socketio.on('set_score')
def on_set_score(data):
    """直接设置分数: {company_id: 1, score: 50}"""
    cid = data.get('company_id')
    score = data.get('score', 0)
    for c in state['companies']:
        if c['id'] == cid:
            c['score'] = max(0, score)
            break
    save_state()
    emit('state_sync', state, broadcast=True)


@socketio.on('toggle_active')
def on_toggle_active(data):
    """切换连队激活状态: {company_id: 1}"""
    cid = data.get('company_id')
    for c in state['companies']:
        if c['id'] == cid:
            c['active'] = not c['active']
            break
    save_state()
    emit('state_sync', state, broadcast=True)


@socketio.on('reset_scores')
def on_reset_scores():
    """重置所有分数为0"""
    for c in state['companies']:
        c['score'] = 0
    save_state()
    emit('state_sync', state, broadcast=True)


@socketio.on('reset_all')
def on_reset_all():
    """完全重置"""
    global state
    state = init_state()
    save_state()
    emit('state_sync', state, broadcast=True)


@socketio.on('set_slide')
def on_set_slide(data):
    """同步当前幻灯片索引"""
    state['current_slide'] = data.get('slide', 0)
    save_state()
    emit('slide_changed', {'slide': state['current_slide']}, broadcast=True)


if __name__ == '__main__':
    print("=" * 50)
    print("  国防知识竞赛计分系统")
    print("  大屏地址: http://0.0.0.0:5000")
    print("  手机端:   http://<内网IP>:5000/mobile")
    print("=" * 50)
    socketio.run(app, host='0.0.0.0', port=5000, debug=False)
