# whale-memory-v2

DSH 长期记忆插件。**全局一份、会淡忘、原件不丢。**

## 状态

T1（存储层）与 T2（数据模型）已完成，T3 起未开始。

## 目录

```
index.js          插件入口（未开始）
lib/
  store.js        文件读写、原子替换、锁、原文追加、备份恢复
  model.js        条目结构、状态转移、校验、注入准入
  retrieve.js     检索（T4，未开始）
  decay.js        压缩与淘汰（T9，未开始）
  inject.js       注入（T5，未开始）
  tools.js        工具定义（T3，未开始）
tests/
  unit/           ���函数单测
  accept/         验收用例（按 docs/PRD.md 编号）
docs/             架构、契约、任务、决策
```

## 命令

```bash
npm test              # 单测
npm run test:accept   # 验收用例
npm run check         # 语法检查
```

## 依赖

无。只用 Node 内置模块，测试用 `node:test`。

## 文档

入口见 [docs/README.md](docs/README.md)，AI 协作规矩见 [AGENTS.md](AGENTS.md)。
