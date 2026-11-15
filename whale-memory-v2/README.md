# whale-memory-v2

DSH 长期记忆插件。**全局一份、会淡忘、原件不丢。**

## 它是什么

一份跨会话的长期记忆，装载在 DeepSeek Harness 里：

- **全局一份**，不按项目分库——"连续的自我"优先于"多租户隔离"
- **人设解耦**——记忆里没有「我是谁」，换形态不影响记忆
- **原件不丢**——条目会被压缩、归档，但**永不物理删除**；原文永久保留，`recall` 可回查
- **会淡忘**——很久没被提起的条目逐级压缩，注入时越来越短
- **零运行时依赖**——只用 Node 内置模块

## 能力

| 能力 | 说明 |
|---|---|
| 写 | `remember`，落盘前过三关：剥注入块 → 脱敏 → 引用校验 |
| 查 | `search` 关键词检索（中文按 bigram + 稀有度加权） |
| 翻 | `recall` 按 id 取正文与原文出处 |
| 改 | `update` 改内容、重要度、可信度、状态 |
| 弃 | `forget` 只改状态，不删 |
| 压 | `maintain` 把久未提及的条目压深一级 |
| 补 | `digest` 捞出最近几天的用户消息，用来补记漏掉的记忆 |

## 记忆怎么进入库

插件**不会在后台自动写库**——两条路都要模型主动调用：

- **每轮判断**：`section` 里给了一份可执行清单（该记的 / 不记的）
- **定期补漏**：`digest` 捞近几天的会话，模型挑出长期有效的再 `remember`

自动记最容易把垃圾记进库，而垃圾一旦进库，比不记更糟。

## 目录

```
index.js                插件入口（接真实 Cordis）
lib/
  store.js              读写、原子替换、锁、原文追加、备份恢复
  model.js              条目结构、状态转移、校验
  retrieve.js           分词、稀有度、评分、选条
  decay.js              压缩分级、固化判定
  promote.js            候选晋升
  inject.js             context/section 注册与渲染
  privacy.js            入库脱敏
  self-pollution.js     注入块剥离
  digest.js             会话语料
  migrate.js            旧库转换
  tools.js              工具定义与实现
bin/
  migrate.js            迁移 CLI
  backfill-original.js  原文回填
tests/
  unit/                 纯函数单测
  accept/               验收用例（按 docs/PRD.md 编号）
docs/                   架构、契约、任务、决策
```

## 命令

```bash
npm test              # 单测
npm run test:accept   # 验收用例
npm run check         # 语法检查
npm run migrate       # 从旧版 SQLite 迁移
```

## 依赖

无。只用 Node 内置模块，测试用 `node:test`。

## 文档

入口见 [docs/README.md](docs/README.md)，AI 协作规矩见 [AGENTS.md](AGENTS.md)。
