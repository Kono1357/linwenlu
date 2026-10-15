# -*- coding: utf-8 -*-
"""
把 app/ 发布到 GitHub（本机没有 git，全程走 GitHub REST API）。

    python tools/publish.py --dry          # 只列出将要上传的文件
    python tools/publish.py                # 真发

token 只从环境变量 GHTOK 读，不落盘、不打印。
首次发布会自动：建仓库 → 铺初始化提交 → 用一次 commit 推上全部文件 → 打开 Pages。

默认目标 Kono1357/linwenlu，可用 --repo 覆盖。
"""
import base64
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OWNER = 'Kono1357'
REPO = 'linwenlu'
BRANCH = 'main'

SKIP_DIRS = {'__pycache__', '.git', 'node_modules'}
SKIP_EXT = {'.pyc', '.log', '.tmp'}


def collect():
    """收集要上传的文件：仓库根下的全部源码与产物（不含隐藏目录）。"""
    out = []
    for root, dirs, files in os.walk(APP):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith('.')]
        for f in files:
            if os.path.splitext(f)[1] in SKIP_EXT or f.startswith('.'):
                continue
            abs_path = os.path.join(root, f)
            rel = os.path.relpath(abs_path, APP).replace('\\', '/')
            out.append((rel, abs_path))
    return sorted(out)


def api(method, path, tok, body=None, retries=5, ok=(200, 201, 204)):
    url = path if path.startswith('http') else 'https://api.github.com' + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    last = ''
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header('Authorization', 'Bearer ' + tok)
        req.add_header('Accept', 'application/vnd.github+json')
        req.add_header('X-GitHub-Api-Version', '2022-11-28')
        req.add_header('User-Agent', 'linwenlu-publish')
        if data:
            req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                raw = r.read().decode('utf-8', 'replace')
                return r.status, (json.loads(raw) if raw.strip() else {}), dict(r.headers)
        except urllib.error.HTTPError as e:
            raw = e.read().decode('utf-8', 'replace')
            if e.code in ok:
                try:
                    return e.code, (json.loads(raw) if raw.strip() else {}), dict(e.headers)
                except json.JSONDecodeError:
                    return e.code, {}, dict(e.headers)
            last = 'HTTP %s %s' % (e.code, raw[:300])
            if e.code in (403, 429, 500, 502, 503, 504):
                time.sleep(2 + attempt * 2)
                continue
            return e.code, {'error': raw[:400]}, dict(e.headers)
        except Exception as e:                      # 网络层抖动，退避重试
            last = str(e)
            time.sleep(2 + attempt * 2)
    return 0, {'error': last}, {}


def main():
    dry = '--dry' in sys.argv
    owner, repo = OWNER, REPO
    for i, a in enumerate(sys.argv):
        if a == '--repo' and i + 1 < len(sys.argv):
            owner, repo = sys.argv[i + 1].split('/')

    files = collect()
    print('待上传 %d 个文件：' % len(files))
    total = 0
    for rel, abs_path in files:
        size = os.path.getsize(abs_path)
        total += size
        print('  %-28s %8.1f KB' % (rel, size / 1024))
    print('合计 %.1f KB' % (total / 1024))

    if dry:
        print('\n[dry] 不做任何写操作。')
        return

    tok = os.environ.get('GHTOK', '').strip()
    if not tok:
        print('\n✗ 没找到 GHTOK 环境变量。')
        print('  先在 PowerShell 里设置（用户级，一次即可）：')
        print("  [Environment]::SetEnvironmentVariable('GHTOK','你的token','User')")
        sys.exit(2)

    print('\n目标仓库：%s/%s' % (owner, repo))

    # 1) 仓库是否存在
    st, info, _ = api('GET', '/repos/%s/%s' % (owner, repo), tok)
    if st == 404:
        print('仓库不存在，创建中…')
        st, info, _ = api('POST', '/user/repos', tok, {
            'name': repo,
            'description': '临文录 · 纯前端小说创作台：看剧情 / 提要求 / 世界线与设定。零依赖单文件，可离线使用。',
            'private': False,
            'has_issues': True,
            'has_wiki': False,
            'auto_init': False,
        })
        if st not in (200, 201):
            print('✗ 创建仓库失败：', info)
            sys.exit(1)
        print('✓ 仓库已创建')
        time.sleep(2)
    elif st == 200:
        print('✓ 仓库已存在')
    else:
        print('✗ 无法访问仓库：', info)
        sys.exit(1)

    # 2) 当前 HEAD（空仓库会 404）
    st, ref, _ = api('GET', '/repos/%s/%s/git/ref/heads/%s' % (owner, repo, BRANCH), tok)
    parent = ref.get('object', {}).get('sha') if st == 200 else None

    if parent is None:
        print('空仓库：先铺一个初始化提交…')
        st, _r, _ = api('PUT', '/repos/%s/%s/contents/.gitkeep' % (owner, repo), tok, {
            'message': 'chore: init',
            'content': base64.b64encode(b'').decode(),
            'branch': BRANCH,
        })
        if st not in (200, 201):
            print('✗ 初始化失败：', _r)
            sys.exit(1)
        st, ref, _ = api('GET', '/repos/%s/%s/git/ref/heads/%s' % (owner, repo, BRANCH), tok)
        parent = ref.get('object', {}).get('sha')

    # 3) 建 blob
    print('上传 blob…')
    tree_items = []
    for rel, abs_path in files:
        with open(abs_path, 'rb') as fh:
            content = base64.b64encode(fh.read()).decode()
        st, blob, _ = api('POST', '/repos/%s/%s/git/blobs' % (owner, repo), tok, {
            'content': content, 'encoding': 'base64',
        })
        if st not in (200, 201):
            print('✗ blob 失败 %s：%s' % (rel, blob))
            sys.exit(1)
        tree_items.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
        print('  ✓ %s' % rel, end='\r')
    print('  ✓ %d 个 blob' % len(tree_items))

    # 4) 建 tree
    st, tree, _ = api('POST', '/repos/%s/%s/git/trees' % (owner, repo), tok,
                      {'tree': tree_items})
    if st not in (200, 201):
        print('✗ 建 tree 失败：', tree)
        sys.exit(1)

    # 5) 建 commit
    st, commit, _ = api('POST', '/repos/%s/%s/git/commits' % (owner, repo), tok, {
        'message': 'feat: 临文录 v1.0 —— 三模块前端创作台\n\n'
                   '看剧情 / 提要求 / 世界线与设定。\n'
                   '纯前端零依赖单文件，数据存本地，可离线使用。',
        'tree': tree['sha'],
        'parents': [parent] if parent else [],
    })
    if st not in (200, 201):
        print('✗ 建 commit 失败：', commit)
        sys.exit(1)

    # 6) 挪分支
    st, _r, _ = api('PATCH', '/repos/%s/%s/git/refs/heads/%s' % (owner, repo, BRANCH), tok, {
        'sha': commit['sha'], 'force': True,
    })
    if st not in (200, 201):
        print('✗ 更新分支失败：', _r)
        sys.exit(1)
    print('✓ 提交完成 %s' % commit['sha'][:8])

    # 7) 开 Pages
    st, pg, _ = api('GET', '/repos/%s/%s/pages' % (owner, repo), tok)
    if st == 200:
        print('✓ Pages 已开启：%s' % pg.get('html_url', ''))
    else:
        st, pg, _ = api('POST', '/repos/%s/%s/pages' % (owner, repo), tok,
                        {'source': {'branch': BRANCH, 'path': '/'}})
        if st in (200, 201):
            print('✓ Pages 已开启')
        else:
            print('! Pages 开启需要手动做一次（Settings → Pages → main / root）：', pg)

    print('\n仓库：https://github.com/%s/%s' % (owner, repo))
    print('在线：https://%s.github.io/%s/' % (owner.lower(), repo))
    print('（Pages 首次生效约 1-3 分钟）')


if __name__ == '__main__':
    main()
