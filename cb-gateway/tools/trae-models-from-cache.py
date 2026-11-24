#!/usr/bin/env python3
"""从 Trae CN 客户端的本地缓存里导出模型清单（人工核对用）。

背景：Trae 的模型目录现在由服务端配置接口 `batch_get_detail_param` 现取
（见 `src/channels/trae/config.ts` / `upstream.ts`），不再手写兜底目录，
所以这份导出**不是**要粘回代码的清单，只是用来对照客户端缓存里到底有哪些模型。
客户端自己会把服务端下发的完整配置缓存在
`%APPDATA%\\Trae CN\\User\\globalStorage\\state.vscdb` 的
`<uid>:AI.agent.model.model_list_map` 里。每个模型的字段包括：

    context_window_size.default  客户端显示的上下文窗口
    max_tokens / prompt_max_tokens
    max_mode                     是否开了 Max 模式
    status / selectable
    features.access.data.identity_list   会员门槛（不含 0 就是会员专享，锁着的）

用法（Windows，DSH 自带 Python 即可）：

    python tools/trae-models-from-cache.py            # 打印 TS 条目
    python tools/trae-models-from-cache.py --all      # 连锁着的也打出来，并标注
    python tools/trae-models-from-cache.py --group chat_v3

只读打开数据库（`mode=ro`），不会改客户端状态。客户端没开过就不会有缓存，
先把 Trae 打开、模型选择器点一次再来跑。
"""

import json
import os
import sqlite3
import sys

DB = os.path.join(os.environ.get("APPDATA", ""), "Trae CN", "User", "globalStorage", "state.vscdb")


def load_map() -> dict:
    if not os.path.exists(DB):
        sys.exit(f"找不到 {DB}——先打开 Trae CN，让它在模型选择器里拉一次列表。")
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        cur = conn.cursor()
        cur.execute("SELECT key FROM ItemTable WHERE key LIKE '%AI.agent.model.model_list_map' ORDER BY length(key) DESC")
        keys = [row[0] for row in cur.fetchall()]
        for key in keys:
            cur.execute("SELECT value FROM ItemTable WHERE key = ?", (key,))
            raw = cur.fetchone()[0]
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", "replace")
            try:
                doc = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(doc, dict) and doc:
                print(f"# 读自 {key}（{len(raw)} 字节）", file=sys.stderr)
                return doc
    finally:
        conn.close()
    sys.exit("缓存里没有可解析的模型清单。")


def main() -> None:
    group = "solo_agent"
    show_all = "--all" in sys.argv
    if "--group" in sys.argv:
        group = sys.argv[sys.argv.index("--group") + 1]

    doc = load_map()
    entries = doc.get(group) or []
    if not entries:
        sys.exit(f"分组 {group} 是空的；现有分组：" + ", ".join(doc.keys()))

    kept = 0
    for model in entries:
        if not model.get("status", True) or not model.get("selectable", True):
            continue
        access = ((model.get("features") or {}).get("access") or {}).get("data", {}).get("identity_list")
        locked = isinstance(access, list) and 0 not in access
        if locked and not show_all:
            continue
        ctx = (model.get("context_window_size") or {}).get("default")
        print(
            "  {{ id: '{id}', name: '{name}', contextWindow: {ctx}, maxTokens: {mt}, reasoning: true }},"
            .format(
                id=model.get("name"),
                name=model.get("display_name") or model.get("name"),
                ctx=int(ctx) if isinstance(ctx, (int, float)) else 200000,
                mt=int(model.get("max_tokens") or 64000),
            )
            + (f"  # 锁：access={access}（会员专享，默认不导出）" if locked else "")
        )
        kept += 1

    print(f"# 共 {kept} 条（分组 {group}{'，含锁定的' if show_all else '，已跳过锁定的'}）", file=sys.stderr)


if __name__ == "__main__":
    main()
