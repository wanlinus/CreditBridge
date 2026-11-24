/**
 * 复制文本到剪贴板。
 *
 * ## 为什么 `navigator.clipboard` 不是主路径
 *
 * 它**只在安全上下文可用**：`https`，或者 `localhost` / `127.0.0.1`。网关部署在
 * `http://192.168.1.100:7801`——两个条件都不满足，`navigator.clipboard` 直接是 `undefined`。
 * 开发时用 `localhost:5173` 永远测不出这个问题，而用户第一次在服务器上点「复制」
 * 就会得到一个静默失效的按钮。
 *
 * 所以这里的顺序是：有 `navigator.clipboard` 且是安全上下文才用它，否则走
 * `execCommand('copy')`。后者是 deprecated，但 http 下它是唯一能用的办法。
 */
export async function copyText(text: string): Promise<boolean> {
  if (text === '') return false;

  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 落到下面的兜底：权限被拒、或 iframe 里的策略限制。
    }
  }

  // `position: fixed` + 移出视口：不能让页面滚一下再滚回来，也不能闪。
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(area);
  }
  return ok;
}
