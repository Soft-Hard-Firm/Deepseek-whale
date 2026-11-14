# Deepseek-whale

这个仓库放「鱼鲸鲸」的东西——她的记忆系统、人设、还有以后要加的那些。

## 目录

| 目录 | 内容 |
|---|---|
| [`whale-memory-v2/`](whale-memory-v2/) | DSH 长期记忆插件。设计文档、数据契约、存储层与数据模型，附验收用例 |

## 关于 whale-memory-v2

一个给 DeepSeek Harness 用的长期记忆插件，目标是：

- **全局一份**——会话是窗口，不是分身
- **会淡忘但不丢原件**——投影层可以压缩、可以归档，原文永久保留
- **重要和可信分开**——重要度 `alpha` 与可信度 `beta` 是两条独立轴
- **能溯源**——每条记忆指得回原文

当前进度：存储层与数据模型已完成，带 25 条单测和 9 条验收用例；工具、检索、注入、压缩未开始。

```
cd whale-memory-v2
npm test
npm run test:accept
```

文档入口：[whale-memory-v2/docs/README.md](whale-memory-v2/docs/README.md)

## 以后

会陆续放进来：人设文件、其他插件、以及跟着她一起长出来的东西。每个项目一个目录，互不干扰。
