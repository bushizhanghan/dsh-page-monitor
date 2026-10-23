# dsh-page-monitor — 网页监控 Agent（哨兵）

> 把一批网页盯起来：定时抓取 → 存快照 → 检测变化 → 判断重不重要 → 通知你。
> 这是作者早期独立作品「网页监控 Agent」（感知→记忆→决策→行动四步走）的 DeepSeek Harness 插件化版本。

## 它能做什么

- **盯一批 URL**：把想盯的网页（学校公告页、报名页、放票页、文档页、竞品页…）加进监控清单
- **定期巡检**：按 `intervalMinutes` 定时抓取（默认 60 分钟），每次都存快照、和上次对比
- **判断变化重不重要**：变化率 ≥ 阈值（默认 30%）或命中关键词（默认：通知/公告/报名/考试/成绩/放假/补录/放票）才算重要
- **通知**：重要变化写入本地日志（`alerts.jsonl`），可选企业微信 webhook 推送
- **会话内问答**：agent 直接答「北邮官网这周有什么新通知」「xx 页现在还放票吗」

## 安装

```sh
dsh plugin --profile desktop add @bushizhanghan/dsh-page-monitor
```

或本地开发（link 到目录）。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `page_watch_add <url> [keywords]` | 加入监控清单（首次自动存基线快照） |
| `page_watch_list` | 列出监控清单 + 每个站点的状态 |
| `page_watch_check [url]` | 立即巡检（可只查一个），报告变化 |
| `page_watch_history [url] [limit]` | 读重要变化历史日志 |
| `page_watch_remove <url>` | 移除监控项 |

## 配置（cordis patch 的 config 字段）

| 字段 | 默认 | 说明 |
|---|---|---|
| `intervalMinutes` | `60` | 定时巡检间隔；`0` = 关闭定时，只手动查 |
| `threshold` | `0.3` | 变化率阈值（字符 bigram Dice，和 difflib.quick_ratio 同型） |
| `keywords` | 见上 | 全局重要关键词；单条 URL 可覆盖 |
| `webhookUrl` | `''` | 企业微信机器人 webhook，重要变化推微信 |
| `provider` | `'dsh'` | 正文提取通道，见下 |
| `lexmountApiKey` / `lexmountProjectId` | `''` | 仅 `provider: 'lexmount'` 时需要 |
| `dataDir` | `~/.dsh/dsh-page-monitor` | 数据目录（watchlist/snapshots/alerts） |

### 抓取通道：`provider`

- **`dsh`（默认）**：走 DSH 官方 `ctx.web` 抓取 seam——免费、SSRF 防护、无需密钥。普通网站够用。
- **`lexmount`**：北邮等网站有瑞数（RiverSecurity）动态 WAF，任何非浏览器客户端（包括官方 seam）都被 412 挡下。lexmount 是服务端渲染提取 API（作者原版 `lesson1_monitor.py` 同款），能穿 WAF。密钥可用启动环境变量 `LEXMOUNT_API_KEY` / `LEXMOUNT_PROJECT_ID`，或写进 config。

## 数据布局

```
~/.dsh/dsh-page-monitor/
├─ watchlist.json        # 监控清单
├─ snapshots/<slug>.json # 每个 URL 的快照（文本 + sha256）
└─ alerts.jsonl          # 重要变化日志（每行一个 JSON）
```

## 工作原理（对应原版四步）

```
感知  抓取正文（官方 seam 或 lexmount）
记忆  每次抓取存 JSON 快照，下次对比
决策  变化率（bigram Dice）+ 关键词 → 重要？
行动  写 alerts 日志 + 可选企业微信 webhook
```

## 开发

```sh
node --test test/          # engine 单测
node test/integration.test.mjs   # 全链路（fake ctx）集成测试
node test/live-smoke.mjs   # 真实网页冒烟（北邮官网会 412，见 provider 说明）
```

## License

MIT
