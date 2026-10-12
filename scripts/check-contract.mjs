#!/usr/bin/env node
// git-zen 契约检查（纯 Node 内置模块，无第三方依赖）
//
// 守的是 AGENTS.md 的三条硬性规则：
//   规则 1：git.rs 里每个 #[tauri::command] 都必须在 lib.rs 的 invoke_handler 里注册。
//           漏了 cargo check 不会报错，只有运行时才炸 "Command xxx not found"——历史上栽过三次。
//   规则 2：每个 command 必须 async fn + offload()，同步命令会冻住主线程。
//   规则 3：git.rs 的 serde struct 与 src/gitApi.ts 的 interface 是人工镜像，字段必须一致。
//
// 用法：node scripts/check-contract.mjs
// 退出码：0 = 无阻断问题；1 = 有阻断问题（可直接挂 CI / pre-commit）

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GIT_RS = join(ROOT, "src-tauri", "src", "git.rs");
const LIB_RS = join(ROOT, "src-tauri", "src", "lib.rs");
const GIT_API_TS = join(ROOT, "src", "gitApi.ts");

// ---------- 通用工具 ----------

// 去掉行尾注释。用 (^|[^:]) 是为了不误伤 "https://…" 这类字符串里的 //
function stripComment(line) {
  return line.replace(/(^|[^:])\/\/.*$/, "$1");
}

function readLines(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).map(stripComment);
}

// 把一行里的 Rust 类型粗略归一化，用于「类型是否对得上」的提示级比对
function normalizeRustType(type) {
  const t = type.replace(/\s+/g, "");
  const vec = t.match(/^Vec<(.+)>$/);
  if (vec) return `${normalizeRustType(vec[1])}[]`;
  const opt = t.match(/^Option<(.+)>$/);
  if (opt) return `${normalizeRustType(opt[1])}|null`;
  if (t === "String" || t === "char" || t === "&str") return "string";
  if (t === "bool") return "boolean";
  if (/^[uif](8|16|32|64|128|size)$/.test(t)) return "number";
  return t; // 未知类型原样返回，只做提示
}

function normalizeTsType(type, optional) {
  let t = type.replace(/\s+/g, "").replace(/;$/, "");
  t = t.replace(/(^|\|)undefined(\||$)/g, "$1").replace(/\|$/, "").replace(/^\|/, "");
  if (optional) t = `${t}|null`;
  return t;
}

function formatList(items) {
  return items.map((s) => `      - ${s}`).join("\n");
}

// ---------- 解析 git.rs 的 #[tauri::command] ----------

const gitLines = readLines(GIT_RS);

function parseCommands(lines) {
  const commands = [];
  const syncCommands = [];
  const orphanAttrs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[tauri::command(\([^)]*\))?\]\s*$/.test(lines[i])) continue;
    let hit = null;
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const cur = lines[j];
      if (cur.trim() === "" || /^\s*\/\//.test(cur) || /^\s*#\[/.test(cur)) continue;
      const asy = cur.match(/^\s*pub\s+async\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)/);
      const syn = cur.match(/^\s*pub\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (asy) hit = { name: asy[1], line: j + 1, async: true };
      else if (syn) hit = { name: syn[1], line: j + 1, async: false };
      break;
    }
    if (!hit) {
      orphanAttrs.push(`src-tauri/src/git.rs:${i + 1}`);
      continue;
    }
    if (!hit.async) syncCommands.push(hit);
    commands.push(hit);
  }
  // 每个 command 的函数体范围：从自己的 fn 行到下一个 #[tauri::command]（或文件末尾）
  for (let k = 0; k < commands.length; k++) {
    const end = k + 1 < commands.length ? commands[k + 1].line - 1 : lines.length;
    const body = lines.slice(commands[k].line, end).join("\n");
    commands[k].hasOffload = body.includes("offload(");
  }
  return { commands, syncCommands, orphanAttrs };
}

// ---------- 解析 lib.rs 的 invoke_handler ----------

function parseRegistered(lines) {
  const text = lines.join("\n");
  const block = text.match(/generate_handler!\s*\[([\s\S]*?)\]/);
  if (!block) return null;
  const names = [];
  for (const m of block[1].matchAll(/\bgit\s*::\s*([A-Za-z_][A-Za-z0-9_]*)/g)) names.push(m[1]);
  return names;
}

// ---------- 解析 git.rs 的 serde struct ----------

function parseRustStructs(lines) {
  const structs = new Map();
  for (let i = 0; i < lines.length; i++) {
    const derive = lines[i].match(/^\s*#\[derive\(([^)]*)\)\]\s*$/);
    if (!derive || !/\bSerialize\b/.test(derive[1])) continue;
    // 跳过中间的其它属性（例如 #[serde(rename_all = "…")]）与空行
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === "" || /^\s*#\[/.test(lines[j]))) j++;
    const head = lines[j] ? lines[j].match(/^\s*pub\s+struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/) : null;
    if (!head) continue;
    const name = head[1];
    const fields = [];
    let skipNext = false;
    let pendingRename = null;
    for (let k = j + 1; k < lines.length; k++) {
      const raw = lines[k];
      if (/^\}/.test(raw)) break; // 结构体在列 0 的 } 结束
      if (raw.trim() === "") continue;
      const attr = raw.match(/^\s*#\[serde\(([^)]*)\)\]/);
      if (attr) {
        if (/\bskip(_serializing)?\b/.test(attr[1])) skipNext = true;
        const rn = attr[1].match(/rename\s*=\s*"([^"]+)"/);
        if (rn) pendingRename = rn[1];
        continue;
      }
      if (/^\s*#\[/.test(raw) || /^\s*\/\//.test(raw)) continue;
      const field = raw.match(/^\s*(?:pub\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?),?\s*$/);
      if (!field) continue;
      if (skipNext) {
        skipNext = false;
        pendingRename = null;
        continue;
      }
      fields.push({ name: pendingRename ?? field[1], rustType: normalizeRustType(field[2]) });
      pendingRename = null;
    }
    structs.set(name, { line: j + 1, fields });
  }
  return structs;
}

// ---------- 解析 gitApi.ts 的 interface ----------

function parseTsInterfaces(text) {
  const interfaces = new Map();
  for (const m of text.matchAll(/export\s+interface\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\}/gm)) {
    const fields = [];
    for (const line of m[2].split(/\r?\n/)) {
      const clean = stripComment(line).trim();
      if (!clean) continue;
      const f = clean.match(/^([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*:\s*(.+?);?$/);
      if (!f) continue;
      fields.push({
        name: f[1],
        optional: Boolean(f[2]),
        tsType: normalizeTsType(f[3], Boolean(f[2])),
      });
    }
    interfaces.set(m[1], fields);
  }
  return interfaces;
}

// ---------- 开始检查 ----------

const fatal = []; // 阻断问题（进退出码）
const hints = []; // 提示（不影响退出码）

const { commands, syncCommands, orphanAttrs } = parseCommands(gitLines);
const commandNames = commands.map((c) => c.name);
const commandLineOf = new Map(commands.map((c) => [c.name, c.line]));

const registered = parseRegistered(readLines(LIB_RS));
if (registered === null) {
  fatal.push("src-tauri/src/lib.rs 里找不到 generate_handler![…]，解析失败（文件结构变了？）");
}
const registeredSet = new Set(registered ?? []);

// 规则 1：双向注册
const notRegistered = commands.filter((c) => !registeredSet.has(c.name));
const notImplemented = (registered ?? []).filter((n) => !commandNames.includes(n));

if (notRegistered.length) {
  fatal.push(
    `【规则 1】实现了但未注册到 lib.rs 的 invoke_handler（P0：运行时 "Command xxx not found"）：\n` +
      formatList(notRegistered.map((c) => `git::${c.name}  —— 实现于 src-tauri/src/git.rs:${c.line}`)),
  );
}
if (notImplemented.length) {
  fatal.push(
    `【规则 1】注册了但 git.rs 里没有实现（编译会失败 / 已改名）：\n` + formatList(notImplemented.map((n) => `git::${n}`)),
  );
}
if (orphanAttrs.length) {
  fatal.push(`【规则 1】#[tauri::command] 后面没找到 pub async fn：\n` + formatList(orphanAttrs));
}

// 规则 2：async + offload
if (syncCommands.length) {
  fatal.push(
    `【规则 2】同步 command（非 async fn，会冻住主线程）：\n` +
      formatList(syncCommands.map((c) => `${c.name}  —— src-tauri/src/git.rs:${c.line}`)),
  );
}
const noOffload = commands.filter((c) => !c.hasOffload);
if (noOffload.length) {
  hints.push(
    `【规则 2】函数体里没看到 offload()（可能是解析误差，请人工确认）：\n` +
      formatList(noOffload.map((c) => `${c.name}  —— src-tauri/src/git.rs:${c.line}`)),
  );
}

// 规则 3：serde struct ↔ TS interface
const rustStructs = parseRustStructs(gitLines);
const tsInterfaces = parseTsInterfaces(readFileSync(GIT_API_TS, "utf8"));
const fieldDiffs = [];
const typeDiffs = [];

for (const [name, info] of rustStructs) {
  const ts = tsInterfaces.get(name);
  if (!ts) {
    fatal.push(
      `【规则 3】git.rs 的 serde struct「${name}」在 src/gitApi.ts 里没有对应的 interface：\n` +
        formatList([`src-tauri/src/git.rs:${info.line}`]),
    );
    continue;
  }
  const rustNames = info.fields.map((f) => f.name);
  const tsNames = ts.map((f) => f.name);
  const missingInTs = rustNames.filter((n) => !tsNames.includes(n));
  const extraInTs = tsNames.filter((n) => !rustNames.includes(n));
  if (missingInTs.length || extraInTs.length) {
    fieldDiffs.push(
      `「${name}」（src-tauri/src/git.rs:${info.line}）\n` +
        (missingInTs.length ? `      git.rs 有、gitApi.ts 缺：${missingInTs.join(", ")}\n` : "") +
        (extraInTs.length ? `      gitApi.ts 有、git.rs 缺：${extraInTs.join(", ")}` : ""),
    );
  }
  // 类型只做提示级比对（Rust u32 ↔ TS number 这类映射容易有例外）
  for (const rf of info.fields) {
    const tf = ts.find((f) => f.name === rf.name);
    if (!tf) continue;
    if (rf.rustType !== tf.tsType) {
      typeDiffs.push(`${name}.${rf.name}：git.rs=${rf.rustType}  gitApi.ts=${tf.tsType}`);
    }
  }
}

if (fieldDiffs.length) {
  fatal.push(`【规则 3】serde struct 与 TS interface 字段不一致：\n${fieldDiffs.map((d) => `      ${d}`).join("\n")}`);
}
if (typeDiffs.length) {
  hints.push(`【规则 3】字段类型可能不匹配（仅提示，请人工确认）：\n` + formatList(typeDiffs));
}

// 反向：TS 有、Rust 没有。可能只是前端本地类型，只提示不阻断
const tsOnly = [...tsInterfaces.keys()].filter((n) => !rustStructs.has(n));
if (tsOnly.length) {
  hints.push(`gitApi.ts 里的 interface 在 git.rs 找不到同名 serde struct（可能只是前端本地类型）：\n` + formatList(tsOnly));
}

// 附加：注册了但 gitApi.ts 里没有任何 invoke 调用
const tsText = readFileSync(GIT_API_TS, "utf8");
const invoked = new Set([...tsText.matchAll(/invoke<[^>]*>\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
const notInvoked = commandNames.filter((n) => !invoked.has(n));
if (notInvoked.length) {
  hints.push(`已在后端注册、但 src/gitApi.ts 里没有 invoke 调用（前端不可达）：\n` + formatList(notInvoked));
}

// ---------- 输出 ----------

if (fatal.length === 0) {
  console.log(
    `✓ 契约检查通过：${commands.length} 个 command 全部注册，${rustStructs.size} 个 serde struct 与 gitApi.ts 字段一致。`,
  );
  if (hints.length) {
    console.log(`\n另有 ${hints.length} 条提示（不影响退出码）：`);
    for (const h of hints) console.log(`  ! ${h}`);
  }
  process.exit(0);
}

console.error("✗ 契约检查未通过：\n");
for (const [i, item] of fatal.entries()) {
  console.error(`${i + 1}. ${item}\n`);
}
if (hints.length) {
  console.error(`另有 ${hints.length} 条提示（不影响退出码）：`);
  for (const h of hints) console.error(`  ! ${h}`);
  console.error("");
}
console.error(
  `统计：git.rs ${commands.length} 个 command / lib.rs 注册 ${registeredSet.size} 个 / serde struct ${rustStructs.size} 个。`,
);
process.exit(1);
