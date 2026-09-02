#!/bin/bash
# 国防知识竞赛计分系统 - 启动脚本
cd "$(dirname "$0")"
echo "============================================"
echo "  国防知识竞赛计分系统"
echo "============================================"
# 安装依赖
pip3 install -r requirements.txt --break-system-packages -q 2>/dev/null || pip install -r requirements.txt -q 2>/dev/null
# 启动服务
python3 app.py
