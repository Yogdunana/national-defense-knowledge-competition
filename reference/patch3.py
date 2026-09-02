#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
部署脚本3：
1. 第四环节和平局加赛环节增加题目总览页
2. 题目页面增加"已选"按钮
3. 允许负分
4. 导航栏居中
5. 第五环节改名为平局加赛环节
6. 删除页码
"""
import os

CONTEST_DIR = '/www/wwwroot/contest'

# ===== 1. 修改 app.py: 允许负分 =====
print('修改 app.py...')
af = os.path.join(CONTEST_DIR, 'app.py')
with open(af, 'r', encoding='utf-8') as f:
    c = f.read()

# 移除负分限制
c = c.replace("c['score'] = max(0, c['score'] + delta)", "c['score'] = c['score'] + delta")
c = c.replace("c['score'] = max(0, score)", "c['score'] = score")
c = c.replace(
    """            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                s = json.load(f)
                # 修复负分：确保所有分数 >= 0
                for c in s.get('companies', []):
                    if c.get('score', 0) < 0:
                        c['score'] = 0
                return s""",
    """            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)"""
)
# 确保模板自动重载
if 'TEMPLATES_AUTO_RELOAD' not in c:
    c = c.replace(
        "app.config['SECRET_KEY'] = 'defense-contest-2024'",
        "app.config['SECRET_KEY'] = 'defense-contest-2024'\napp.config['TEMPLATES_AUTO_RELOAD'] = True"
    )

with open(af, 'w', encoding='utf-8') as f:
    f.write(c)
print('  app.py: 负分限制已移除')

# ===== 2. 修改 display.html =====
print('\n修改 display.html...')
df = os.path.join(CONTEST_DIR, 'templates', 'display.html')
with open(df, 'r', encoding='utf-8') as f:
    c = f.read()

# ---- 2a. 添加CSS ----
css_add = """
        /* ===== Overview slide ===== */
        .overview-title { font-size: 36px; color: #ffd700; margin-bottom: 30px; text-shadow: 0 0 15px rgba(255,215,0,0.3); }
        .overview-grid { display: flex; flex-wrap: wrap; gap: 14px; justify-content: center; max-width: 800px; }
        .overview-item { width: 60px; height: 60px; display: flex; align-items: center; justify-content: center; font-size: 26px; font-weight: bold; border-radius: 10px; border: 2px solid; transition: all 0.3s; cursor: pointer; }
        .overview-item:hover { transform: scale(1.1); }
        .ov-green { background: rgba(0,200,83,0.15); border-color: #00c853; color: #69f0ae; }
        .ov-blue { background: rgba(33,150,243,0.15); border-color: #2196f3; color: #64b5f6; }
        .ov-red { background: rgba(244,67,54,0.15); border-color: #f44336; color: #ef5350; }
        .ov-yellow { background: rgba(255,215,0,0.15); border-color: #ffd700; color: #ffd700; }
        .overview-item.ov-selected { background: rgba(80,80,80,0.4) !important; border-color: #555 !important; color: #666 !important; text-decoration: line-through; opacity: 0.5; }

        /* ===== Selected button ===== */
        .selected-btn { padding: 6px 16px; background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 5px; font-size: 14px; cursor: pointer; white-space: nowrap; transition: all 0.2s; }
        .selected-btn:hover { background: rgba(255,255,255,0.15); }
        .selected-btn.is-selected { background: rgba(80,80,80,0.4); color: #888; border-color: #555; }
        .nav-btn.nav-selected { opacity: 0.3; text-decoration: line-through; }
        .nav-btn-green { background: rgba(0,200,83,0.3) !important; border-color: #00c853 !important; color: #69f0ae !important; }
        .nav-btn-blue { background: rgba(33,150,243,0.3) !important; border-color: #2196f3 !important; color: #64b5f6 !important; }
        .nav-btn-red { background: rgba(244,67,54,0.3) !important; border-color: #f44336 !important; color: #ef5350 !important; }
        .nav-btn-green.active { background: #00c853 !important; color: #000 !important; }
        .nav-btn-blue.active { background: #2196f3 !important; color: #000 !important; }
        .nav-btn-red.active { background: #f44336 !important; color: #000 !important; }
"""
c = c.replace('    </style>', css_add + '    </style>')

# ---- 2b. 导航栏居中 ----
c = c.replace(
    'justify-content: flex-start; gap: 4px;',
    'justify-content: center; gap: 4px;'
)

# ---- 2c. 第五环节改名（Jinja2条件）----
old_sec = "第{{ ['一','二','三','四','五'][section.section - 1] }}环节"
new_sec = "{{ '平局加赛环节' if section.section == 5 else '第' ~ ['一','二','三','四','五'][section.section - 1] ~ '环节' }}"
if old_sec in c:
    c = c.replace(old_sec, new_sec)

# ---- 2d. 平局提示按钮 ----
c = c.replace('进入第五环节加赛', '进入平局加赛环节')

# ---- 2e. JS导航section按钮文字 ----
c = c.replace(
    "t.textContent = '第' + SECTION_NAMES[sec-1] + '环节';",
    "t.textContent = sec === 5 ? '平局加赛环节' : '第' + SECTION_NAMES[sec-1] + '环节';"
)

# ---- 2f. 第四环节导航按钮颜色 ----
old_btn_create = "                    b.className = 'nav-btn';\n                    b.textContent = q;"
new_btn_create = """                    b.className = 'nav-btn';
                    if (sec === 4) {
                        if (q <= 3) b.classList.add('nav-btn-green');
                        else if (q <= 6) b.classList.add('nav-btn-blue');
                        else b.classList.add('nav-btn-red');
                    }
                    b.textContent = q;"""
if old_btn_create in c:
    c = c.replace(old_btn_create, new_btn_create)

# ---- 2g. 删除页码 ----
c = c.replace('<div class="slide-info" id="slideInfo"></div>\n', '')
c = c.replace(
    "        function updateSlideInfo() {\n            document.getElementById('slideInfo').textContent = (currentSlide + 1) + ' / ' + totalSlides;\n        }\n",
    ''
)
c = c.replace("            updateSlideInfo();\n", '')

# ---- 2h. 允许负分显示 ----
c = c.replace('const displayScore = Math.max(0, c.score);', 'const displayScore = c.score;')
c = c.replace('const safeScore = Math.max(0, c.score);', 'const safeScore = c.score;')

# ---- 2i. 插入题目总览页 ----
# 在section divider之后、subsection循环之前插入
overview_block = """
                    {% if section.section in [4, 5] %}
                    {% set ns_ov = namespace(qn=0) %}
                    <!-- Question overview -->
                    <div class="slide overview-slide" id="slide-{{ ns.idx }}" data-section="{{ section.section }}" data-type="overview">
                        <h1 class="overview-title">题目总览</h1>
                        <div class="overview-grid">
                            {% for subsection in section.subsections %}
                                {% for q in subsection.questions %}
                                    {% set ns_ov.qn = ns_ov.qn + 1 %}
                                    <div class="overview-item {% if section.section == 4 %}{% if ns_ov.qn <= 3 %}ov-green{% elif ns_ov.qn <= 6 %}ov-blue{% else %}ov-red{% endif %}{% else %}ov-yellow{% endif %}" id="ov-item-{{ ns.idx + ns_ov.qn }}" onclick="goToSlide({{ ns.idx + ns_ov.qn }})">
                                        {{ ns_ov.qn }}
                                    </div>
                                {% endfor %}
                            {% endfor %}
                        </div>
                    </div>
                    {% set ns.idx = ns.idx + 1 %}
                    {% endif %}

"""
# 在 {% for subsection in section.subsections %} 前插入
insert_point = '\n                    {% for subsection in section.subsections %}\n'
if insert_point in c:
    c = c.replace(insert_point, '\n' + overview_block + '                    {% for subsection in section.subsections %}\n')
    print('  题目总览页已插入')
else:
    # 备用：尝试其他格式
    insert_point2 = '                    {% for subsection in section.subsections %}'
    if insert_point2 in c:
        c = c.replace(insert_point2, overview_block + '                    {% for subsection in section.subsections %}')
        print('  题目总览页已插入(备用)')
    else:
        print('  警告: 未找到 subsection 循环位置')

# ---- 2j. 题目页面增加"已选"按钮 ----
old_footer = '<button class="toggle-answer-btn" onclick="toggleAnswer({{ ns.idx }})">显示答案</button>'
new_footer = '{% if section.section in [4, 5] %}<button class="selected-btn" id="sel-btn-{{ ns.idx }}" onclick="toggleSelected({{ ns.idx }})">已选</button> {% endif %}<button class="toggle-answer-btn" onclick="toggleAnswer({{ ns.idx }})">显示答案</button>'
if old_footer in c:
    c = c.replace(old_footer, new_footer)
    print('  已选按钮已添加')
else:
    print('  警告: 未找到答题按钮位置')

# ---- 2k. JavaScript: 已选功能 ----
js_add = """
        // ===== Selected questions tracking =====
        const selectedQuestions = new Set(JSON.parse(localStorage.getItem('selectedQ') || '[]'));
        function toggleSelected(idx) {
            const btn = document.getElementById('sel-btn-' + idx);
            if (!btn) return;
            if (selectedQuestions.has(idx)) {
                selectedQuestions.delete(idx);
                btn.classList.remove('is-selected');
                btn.textContent = '已选';
            } else {
                selectedQuestions.add(idx);
                btn.classList.add('is-selected');
                btn.textContent = '取消已选';
            }
            localStorage.setItem('selectedQ', JSON.stringify([...selectedQuestions]));
            // 更新导航按钮
            const navBtn = document.getElementById('nav-btn-' + idx);
            if (navBtn) navBtn.classList.toggle('nav-selected', selectedQuestions.has(idx));
            // 更新总览页
            const ovItem = document.getElementById('ov-item-' + idx);
            if (ovItem) ovItem.classList.toggle('ov-selected', selectedQuestions.has(idx));
        }
        function restoreSelectedStates() {
            selectedQuestions.forEach(idx => {
                const navBtn = document.getElementById('nav-btn-' + idx);
                if (navBtn) navBtn.classList.add('nav-selected');
                const ovItem = document.getElementById('ov-item-' + idx);
                if (ovItem) ovItem.classList.add('ov-selected');
                const selBtn = document.getElementById('sel-btn-' + idx);
                if (selBtn) {
                    selBtn.classList.add('is-selected');
                    selBtn.textContent = '取消已选';
                }
            });
        }

"""
# 在 init() 前插入
c = c.replace('\n        init();', js_add + '\n        init();\n        restoreSelectedStates();')

with open(df, 'w', encoding='utf-8') as f:
    f.write(c)
print('  display.html 已保存')

# ===== 3. 修改 questions.py =====
print('\n修改 questions.py...')
import sys, json
sys.path.insert(0, CONTEST_DIR)
if 'questions' in sys.modules:
    del sys.modules['questions']
from questions import QUESTIONS, COMPANY_NAMES

for section in QUESTIONS:
    if section['section'] == 4:
        for sub in section['subsections']:
            if '简单' in sub['title']:
                sub['title'] = '简单题'
            elif '中等' in sub['title']:
                sub['title'] = '中等题'
            elif '难题' in sub['title']:
                sub['title'] = '难题'
    if section['section'] == 5:
        all_q = []
        for sub in section['subsections']:
            all_q.extend(sub['questions'])
        section['title'] = '平局加赛环节：锦上添花'
        section['subsections'] = [{
            'title': '平局加赛题',
            'rules': '出现同分平局时使用，双方轮流作答，答对多者获胜',
            'questions': all_q
        }]

qf = os.path.join(CONTEST_DIR, 'questions.py')
with open(qf, 'w', encoding='utf-8') as f:
    f.write('# -*- coding: utf-8 -*-\n')
    f.write('"""国防知识竞赛 - 题库数据"""\n\n')
    f.write('QUESTIONS = ')
    f.write(json.dumps(QUESTIONS, ensure_ascii=False, indent=4))
    f.write('\n\n')
    f.write('# 连队名称\n')
    f.write('COMPANY_NAMES = ')
    f.write(json.dumps(COMPANY_NAMES, ensure_ascii=False, indent=4))
    f.write('\n')
print('  questions.py 已保存')

# ===== 完成 =====
print('\n' + '=' * 50)
print('  全部修改完成！')
print('=' * 50)
print('\n请重启应用：')
print('  kill $(pgrep -f "python3 app.py") 2>/dev/null')
print('  cd /www/wwwroot/contest')
print('  nohup python3 app.py > contest.log 2>&1 &')
print('\n然后浏览器 Ctrl+Shift+R 强制刷新')
