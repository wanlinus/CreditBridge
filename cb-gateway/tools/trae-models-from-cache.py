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
