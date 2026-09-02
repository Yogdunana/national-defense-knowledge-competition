#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
部署脚本：修改 questions.py 和 display.html
1. 平局加赛环节不分组
2. 第四环节导航按钮颜色（1-3绿/4-6蓝/7-9红）
3. 第四环节题目标注简化
"""
import sys, os, json

CONTEST_DIR = '/www/wwwroot/contest'

# ===== 1. 修改 questions.py =====
print('修改 questions.py...')
sys.path.insert(0, CONTEST_DIR)

# 清除缓存重新导入
if 'questions' in sys.modules:
    del sys.modules['questions']

from questions import QUESTIONS, COMPANY_NAMES

# 第四环节：简化子标题
for section in QUESTIONS:
    if section['section'] == 4:
        for sub in section['subsections']:
            if '简单' in sub['title']:
                sub['title'] = '简单题'
            elif '中等' in sub['title']:
                sub['title'] = '中等题'
            elif '难题' in sub['title']:
                sub['title'] = '难题'
        print('  第四环节子标题已简化')

    # 第五环节：合并所有分组为一个
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
        print(f'  第五环节已合并为1组，共{len(all_q)}题')

# 写回 questions.py
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

# ===== 2. 修改 display.html =====
print('\n修改 display.html...')
df = os.path.join(CONTEST_DIR, 'templates', 'display.html')
with open(df, 'r', encoding='utf-8') as f:
    c = f.read()

# 2a. 添加导航按钮颜色CSS（在 .nav-btn.active 后面插入）
color_css = """
        .nav-btn-green { background: rgba(0,200,83,0.3) !important; border-color: #00c853 !important; color: #69f0ae !important; }
        .nav-btn-blue { background: rgba(33,150,243,0.3) !important; border-color: #2196f3 !important; color: #64b5f6 !important; }
        .nav-btn-red { background: rgba(244,67,54,0.3) !important; border-color: #f44336 !important; color: #ef5350 !important; }
        .nav-btn-green.active { background: #00c853 !important; color: #000 !important; }
        .nav-btn-blue.active { background: #2196f3 !important; color: #000 !important; }
        .nav-btn-red.active { background: #f44336 !important; color: #000 !important; }"""

# 在 .nav-btn.active 行后面插入
c = c.replace(
    ".nav-btn.active { background: #ffd700; color: #000; font-weight: bold; }",
    ".nav-btn.active { background: #ffd700; color: #000; font-weight: bold; }" + color_css
)

# 2b. 导航栏居中
c = c.replace(
    'justify-content: flex-start; gap: 4px;',
    'justify-content: center; gap: 4px;'
)

# 2c. buildNavBar 中给第四环节按钮加颜色
# 找到 b.className = 'nav-btn'; 这一行，后面加颜色逻辑
old_btn = "                    b.className = 'nav-btn';\n                    b.textContent = q;"
new_btn = """                    b.className = 'nav-btn';
                    if (sec === 4) {
                        if (q <= 3) b.classList.add('nav-btn-green');
                        else if (q <= 6) b.classList.add('nav-btn-blue');
                        else b.classList.add('nav-btn-red');
                    }
                    b.textContent = q;"""
c = c.replace(old_btn, new_btn)

# 2d. 第四环节题目标注：在header-section中显示难度
# 当前格式：第X环节 · 子标题 · 第N题
# 第四环节子标题已简化为"简单题"/"中等题"/"难题"，无需额外修改
# Jinja2模板已经会显示 subsection.title

# 2e. 确保第五环节名称正确显示
# 如果之前的Jinja2条件替换没成功，用简单替换兜底
old_sec5 = "第{{ ['一','二','三','四','五'][section.section - 1] }}环节"
new_sec5 = "{{ '平局加赛环节' if section.section == 5 else '第' ~ ['一','二','三','四','五'][section.section - 1] ~ '环节' }}"
if old_sec5 in c:
    c = c.replace(old_sec5, new_sec5)
    print('  Jinja2环节名称条件已添加')

# 2f. 平局提示按钮文字
c = c.replace('进入第五环节加赛', '进入平局加赛环节')
c = c.replace('进入平局加赛环节加赛', '进入平局加赛环节')

# 2g. JS导航section按钮文字
old_nav_sec = "t.textContent = '第' + SECTION_NAMES[sec-1] + '环节';"
new_nav_sec = "t.textContent = sec === 5 ? '平局加赛环节' : '第' + SECTION_NAMES[sec-1] + '环节';"
if old_nav_sec in c:
    c = c.replace(old_nav_sec, new_nav_sec)

# 2h. 删除页码（如果还存在）
c = c.replace('<div class="slide-info" id="slideInfo"></div>\n', '')
c = c.replace(
    "        function updateSlideInfo() {\n            document.getElementById('slideInfo').textContent = (currentSlide + 1) + ' / ' + totalSlides;\n        }\n",
    ''
)
c = c.replace("            updateSlideInfo();\n", '')

with open(df, 'w', encoding='utf-8') as f:
    f.write(c)
print('  display.html 已保存')

# ===== 完成 =====
print('\n' + '='*50)
print('  全部修改完成！')
print('='*50)
print('\n请重启应用：')
print('  kill $(pgrep -f "python3 app.py") 2>/dev/null')
print('  cd /www/wwwroot/contest')
print('  nohup python3 app.py > contest.log 2>&1 &')
print('\n然后浏览器 Ctrl+Shift+R 强制刷新')
