# 2025级本科生军训国防知识竞赛系统 | 2025 Undergraduate Military Training National Defense Knowledge Competition System

## 中文介绍

本项目是一个完整的知识竞赛活动系统，专为高校军训期间的国防知识竞赛活动设计。系统包含管理端和展示端，支持完整的竞赛流程管理和实时展示。

### 功能特性

- **多阶段竞赛流程**：必答题 → 抢答题 → 八进四PK → 半决赛 → 决赛 → 加赛
- **抢答器集成**：通过 WebSocket 与硬件抢答器对接，支持抢答判定、犯规检测
- **实时同步**：管理端操作实时同步到展示端，基于 WebSocket 双向通信
- **对阵图展示**：八强淘汰赛对阵图自动生成与更新
- **加赛机制**：决赛平局时自动进入加赛环节
- **排名与颁奖**：实时排名更新，颁奖页展示获奖队伍
- **状态持久化**：自动保存比赛进度，支持断电恢复
- **导出功能**：比赛数据一键导出

### 技术栈

- Node.js + Express（服务端）
- WebSocket（实时通信）
- 原生 HTML/CSS/JavaScript（前端，无框架依赖）
- 硬件抢答器 TCP 接口（端口 9998/9999）

### 快速开始

```bash
# 安装依赖
npm install

# 启动服务器
node server.js
```

- 展示端：http://localhost:3000/display.html
- 管理端：http://localhost:3000/admin.html

---

## English Description

A complete quiz competition system designed for university military training national defense knowledge competitions. The system includes an admin panel and a display interface, supporting full competition flow management and real-time presentation.

### Features

- **Multi-stage competition flow**: Mandatory questions → Buzzer questions → Quarterfinals PK → Semifinals → Finals → Tiebreaker
- **Buzzer hardware integration**: Connects with hardware buzzer via TCP, supporting buzz detection and foul monitoring
- **Real-time sync**: Admin operations sync to the display in real time via WebSocket
- **Bracket display**: Auto-generated and updated knockout bracket for quarterfinals
- **Tiebreaker mechanism**: Automatically enters tiebreaker round when the final ends in a tie
- **Ranking & awards**: Live ranking updates and an awards ceremony page
- **State persistence**: Auto-saves competition progress and supports crash recovery
- **Data export**: One-click competition data export

### Tech Stack

- Node.js + Express (backend)
- WebSocket (real-time communication)
- Vanilla HTML/CSS/JavaScript (frontend, no framework dependencies)
- Hardware buzzer TCP interface (ports 9998/9999)

### Quick Start

```bash
# Install dependencies
npm install

# Start the server
node server.js
```

- Display: http://localhost:3000/display.html
- Admin: http://localhost:3000/admin.html
