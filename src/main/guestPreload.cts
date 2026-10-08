// guest 页 preload（沙箱隔离世界）：监听登录表单提交，把凭据交给主进程加密保存。
// 页面脚本访问不到本世界，也感知不到监听器的存在；提交事件在 preventDefault 之后
// 照常触发，SPA 用 fetch 登录（submit 被 preventDefault）同样能捕获。
import { ipcRenderer } from "electron";

const MAX_VALUE_LEN = 2048;
const USERNAME_SELECTOR =
  "input:not([type]),input[type=text],input[type=email],input[type=tel]";

const str = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, MAX_VALUE_LEN) : "";

document.addEventListener(
  "submit",
  (ev) => {
    try {
      const target = ev.target as HTMLFormElement | null;
      if (!target || target.tagName !== "FORM") return;
      const form = target;
      const password = [...form.querySelectorAll<HTMLInputElement>("input[type=password]")].find(
        (i) => !i.disabled && !i.readOnly && i.value,
      );
      if (!password) return;

      // 用户名：密码框之前最近的非空文本框；没有前面的就取第一个（多列表单兜底）
      const scope: ParentNode = password.form ?? document;
      const texts = [...scope.querySelectorAll<HTMLInputElement>(USERNAME_SELECTOR)].filter(
        (i) => !i.disabled && !i.readOnly && i.value && i.type !== "hidden",
      );
      const before = texts.filter((i) => password.compareDocumentPosition(i) & 2);
      const username = before.length ? before[before.length - 1] : texts[0];

      ipcRenderer.send("guest:credentials", {
        href: String(location.href),
        username: str(username?.value),
        usernameField: str(username ? username.name || username.id : ""),
        password: str(password.value),
        passwordField: str(password.name || password.id),
      });
    } catch {
      // 捕获失败不能影响页面登录流程
    }
  },
  true,
);
