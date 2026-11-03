// builder 的起步网页：左边树、中间产物、右边当前结构的聊天。
// 只经服务接口用 Harness：调 tree_*、chat_* 这几个 Operation，订阅事件流实时更新。builder 以后可以自己改这个页面。

const USER_HEADER = "x-builder-user";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const state = {
  name: localStorage.getItem("builder.name") || "",
  /** 整棵树（tree_list 的结果） */
  tree: null,
  /** 路径 → { kind: "structure" | "artifact" | "chat", node } */
  index: new Map(),
  /** 选中的：结构、产物或聊天的路径（根是 ""） */
  selected: decodeURIComponent(location.hash.slice(1)),
  /** 右边显示的聊天 */
  chat: null,
  messages: [],
  collapsed: new Set(),
};

/** 调一个 Operation：被拒或请求不成立都抛异常 */
async function call(name, input = {}) {
  const res = await fetch(`/operations/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "harness-client": "web", [USER_HEADER]: encodeURIComponent(state.name) },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  if (!body.result.ok) throw new Error(`${body.result.by}: ${body.result.reason}`);
  return body.result.value;
}

// ---- 名字：本机开发时自己填；经网关时网关带上身份 ----
function askName() {
  const name = prompt("你的名字（会显示在聊天里）", state.name)?.trim();
  if (name) {
    state.name = name;
    localStorage.setItem("builder.name", name);
  }
  $("me").textContent = state.name || "填名字";
}

// ---- 树 ----
async function loadTree() {
  state.tree = await call("tree_list");
  state.index.clear();
  const walk = (s) => {
    // 每个结构都有主聊天：还没人说过话时文件还没有，也照样列出来
    if (!s.chats.some((c) => c.name === "main")) s.chats.unshift({ name: "main", path: mainChatOf(s.path) });
    state.index.set(s.path, { kind: "structure", node: s });
    for (const c of s.chats) state.index.set(c.path, { kind: "chat", node: c });
    for (const a of s.artifacts) state.index.set(a.path, { kind: "artifact", node: a });
    s.structures.forEach(walk);
  };
  walk(state.tree);
  renderTree();
}

function icon(name) {
  if (name.endsWith(".html")) return "▣";
  if (name.endsWith(".md")) return "≡";
  return "·";
}

function renderTree() {
  const row = (path, label, ic, extra = "") =>
    `<div class="row${state.selected === path ? " selected" : ""}" data-path="${esc(path)}"><span class="icon">${ic}</span><span>${esc(label)}</span>${extra}</div>`;
  const structure = (s) => {
    const open = !state.collapsed.has(s.path);
    const add = `<button class="add" data-add="${esc(s.path)}" title="新建子结构">＋</button>`;
    const items = [
      ...s.chats.map((c) => `<li>${row(c.path, c.name === "main" ? "主聊天" : c.name, "💬")}</li>`),
      ...s.artifacts.map((a) => `<li>${row(a.path, a.name, icon(a.name))}</li>`),
      ...s.structures.map((c) => `<li class="structure">${structure(c)}</li>`),
    ];
    return `${row(s.path, s.path ? s.name : "（根）", open ? "▾" : "▸", add)}${open ? `<ul>${items.join("")}</ul>` : ""}`;
  };
  $("tree").innerHTML = `<ul><li class="structure">${structure(state.tree)}</li></ul>`;
}

$("tree").addEventListener("click", async (ev) => {
  const add = ev.target.closest("[data-add]");
  if (add) {
    const name = prompt("子结构的名字（字母、数字、_ 与 -）")?.trim();
    if (!name) return;
    try {
      select(await call("tree_create", { parent: add.dataset.add, name }));
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  const row = ev.target.closest("[data-path]");
  if (!row) return;
  const path = row.dataset.path;
  // 点已选中的结构：收起或展开
  if (state.index.get(path)?.kind === "structure" && state.selected === path) {
    state.collapsed.has(path) ? state.collapsed.delete(path) : state.collapsed.add(path);
    renderTree();
    return;
  }
  select(path);
});

// ---- 选中：中间显示什么，右边是哪个聊天 ----
const parentOf = (path) => path.split("/").slice(0, -1).join("/");
const mainChatOf = (structure) => (structure ? `${structure}/main.chat` : "main.chat");

function select(path) {
  state.selected = path;
  history.replaceState(null, "", `#${encodeURIComponent(path)}`);
  const found = state.index.get(path);
  const kind = found?.kind ?? "structure";
  const structure = kind === "structure" ? path : parentOf(path);
  $("where").textContent = path || "（根）";
  renderTree();
  renderView(path, kind);
  openChat(kind === "chat" ? path : mainChatOf(structure));
}

async function renderView(path, kind) {
  const view = $("view");
  if (kind === "structure" || kind === "chat") {
    const s = state.index.get(kind === "chat" ? parentOf(path) : path)?.node ?? state.tree;
    const list = (items) => (items.length ? `<ul>${items.map((a) => `<li><a href="#${encodeURIComponent(a.path)}">${esc(a.name)}</a></li>`).join("")}</ul>` : `<p class="empty">还没有</p>`);
    view.innerHTML = `<div class="doc overview"><h2>${esc(s.path || "（根）")}</h2><h3>产物</h3>${list(s.artifacts)}<h3>子结构</h3>${list(s.structures)}</div>`;
    return;
  }
  const url = `/tree/${path.split("/").map(encodeURIComponent).join("/")}`;
  if (path.endsWith(".html")) {
    view.innerHTML = `<iframe src="${esc(url)}" title="${esc(path)}"></iframe>`;
    return;
  }
  const text = await (await fetch(url)).text();
  view.innerHTML = path.endsWith(".md") ? `<div class="doc">${marked.parse(text)}</div>` : `<div class="doc"><pre>${esc(text)}</pre></div>`;
}

window.addEventListener("hashchange", () => {
  const path = decodeURIComponent(location.hash.slice(1));
  if (path !== state.selected) select(path);
});

// ---- 聊天 ----
async function openChat(path) {
  state.chat = path;
  const structure = parentOf(path);
  const name = path.split("/").at(-1).replace(/\.chat$/, "");
  $("chat-head").innerHTML = `${esc(name === "main" ? "主聊天" : name)}<small>${esc(structure || "（根）")}</small>`;
  state.messages = [];
  renderMessages();
  const messages = await call("chat_read", { path });
  if (state.chat !== path) return;
  state.messages = messages;
  renderMessages();
}

function renderMessages() {
  const list = $("messages");
  list.innerHTML = state.messages.length
    ? state.messages
        .map((m) => {
          const at = new Date(m.at).toLocaleString("zh-CN", { hour12: false });
          return `<li class="message${m.author === state.name ? " mine" : ""}"><span class="who">${esc(m.author)}</span><time>${esc(at)}</time><div class="text">${esc(m.text)}</div></li>`;
        })
        .join("")
    : `<li class="empty">还没人说话</li>`;
  list.scrollTop = list.scrollHeight;
}

$("say").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  if (!state.name) askName();
  if (!state.name) return;
  $("text").value = "";
  try {
    const message = await call("chat_post", { path: state.chat, text });
    receive(message);
  } catch (err) {
    $("text").value = text;
    alert(err.message);
  }
});

$("text").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    $("say").requestSubmit();
  }
});

/** 收到一条消息（自己发的、或事件流推来的别人的）：是当前聊天的就显示，按 id 去重 */
function receive(message) {
  if (message.path !== state.chat || state.messages.some((m) => m.id === message.id)) return;
  state.messages.push(message);
  renderMessages();
}

// ---- 事件流：别人说的话、树的变化 ----
function listen() {
  const events = new EventSource("/events");
  events.onmessage = (ev) => {
    const event = JSON.parse(ev.data);
    if (event.type !== "run.exited" || !event.result.ok) return;
    if (event.operation === "chat_post") {
      receive(event.result.value);
      // 第一次在某个聊天里说话，树里多出这个聊天
      if (!state.index.has(event.result.value.path)) loadTree();
    }
    if (event.operation === "tree_create") loadTree();
  };
}

$("me").addEventListener("click", askName);
$("me").textContent = state.name || "填名字";
await loadTree();
select(state.index.has(state.selected) ? state.selected : "");
listen();
