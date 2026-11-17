# 自动更新：配置与发版流程

## 它是怎么工作的

```
启动 → 请求 GitHub Release 里的 latest.json → 有更新 → 弹窗 → 下载安装 → 重启
```

`latest.json` 由 `tauri-action` 在 CI 里生成并上传，内容大致是：

```json
{
  "version": "0.5.0",
  "pub_date": "…",
  "notes": "…",
  "platforms": {
    "windows-x86_64": { "signature": "…", "url": "https://github.com/…/git-zen_0.5.0_x64-setup.exe" }
  }
}
```

endpoint 固定指向 `releases/latest/download/latest.json` —— 永远取「最新那个 release」，
不需要每次改配置。

## 一次性配置（已完成）

1. 生成密钥对：`pnpm tauri signer generate -w ~/.tauri/gitzen.key`
   - 私钥在 `~/.tauri/gitzen.key`（**仓库外**，`.gitignore` 另有 `*.key` 兜底）
   - 公钥已写进 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
2. `bundle.createUpdaterArtifacts: true` —— 构建时额外产出 `.exe.sig` 签名文件
3. 插件注册：`tauri-plugin-updater` + `tauri-plugin-process`（重启用）
4. 权限：`updater:default`、`process:allow-restart`

### 还需要你在 GitHub 上做两件事

仓库 Settings › Secrets and variables › Actions，添加：

| Secret | 值 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/gitzen.key` 的**全文内容** |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成时设的密码（当时留空就填空字符串） |

**私钥丢了会怎样**：再也签不出能通过校验的更新包，所有已安装的用户只能手动重装。
所以除了 Secret，最好再单独备份一份私钥。

## 日常发版

```bash
# 1. 改版本号（三处）+ 写 release notes
pnpm version:bump 0.5.0        # 或手动改 package.json / Cargo.toml / tauri.conf.json
# 2. 打 tag 推上去
git tag v0.5.0 && git push origin v0.5.0
```

剩下的：GitHub Actions 自动跑 `pnpm verify` → 构建 → 签名 → 建 Release →
上传安装包 + `.sig` + `latest.json`。几分钟后已装用户下次启动就会看到更新提示。

失败的话在 Actions 页面看日志。`pnpm verify` 挂了会直接停在第一步，不会发出坏包。

## 第一次生效的条件

**必须先有一次成功的 CI 发版**，才会存在 `latest.json`。
在那之前，自动更新检查会一直失败（静默忽略，不影响使用）。

## 边界与取舍

- **只在启动时查一次**。定时轮询会频繁打 GitHub API（匿名限 60 次/小时），
  而桌面工具重启频率本来就低。
- **检查失败静默**。断网、被墙、GitHub 挂了都不该在启动时糊用户一脸。
  只有用户主动点「检查更新」时才报错。
- **dev 模式跳过**。`pnpm tauri dev` 下没有签名配置，`check()` 必然失败。
- **更新说明按纯文本展示**。release notes 是 markdown，但渲染 markdown 要引解析器，
  为一段版本说明不值得。
- **下载中不给取消**。中途取消会留下半截文件，重启一次反而干净。

## 已知限制

- 只支持 Windows x64（当前 `bundle.targets` 只有 nsis）
- 应用未签名，SmartScreen 仍会提示「未知发布者」——自动更新解决的是「有新版本」，
  不解决「首次安装的可信度」
