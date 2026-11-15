# 运行时：并发、轨迹、自检与评测

写下去之后会发生什么：并发与原子性、每次调用的轨迹、装好没装好的自检、面板自身的健康上报，以及规则评测的条件可比性。

> 本文是 [README](../README.md) 的展开篇。

## 执行轨迹

每个 `ontology_*` 调用都会追加一行 JSONL：

```json
{"ts":1794585923436,"tool":"ontology_get","ok":true,"ms":0,"summary":"ontology_get: retail.store-inventory · Inventory","error":null}
```

- 记录的是**真的发生了什么**：被拒绝的删除、找不到的包都记为 `ok: false` 并带上原因；
- 文件超过上限自动只留最近 N 条，一行写坏（进程被杀）只是被跳过，不会让读失败；
- 面板的「可观测与评测」页读 `/traces` 渲染，没连上宿主时才回落到演示数据。

轨迹默认落在 `assetsDir` 的上一级 `.ontology-traces.jsonl`，已加入 `.gitignore`；可用 `config.traceFile` 改位置，`config.trace: false` 关闭。

## 并发：丢失更新会报错，不会静默

两个 Agent 同时改一份资产，最坏的结果不是报错，而是**其中一笔悄无声息地消失**。这里有两道防线：

**1. 乐观锁（etag CAS）。** 每次写入都带着「它读到时的内容指纹」：

```
ontology_get  → { …, etag: "sha256-3f2a…" }
ontology_upsert_object { …, ifEtag: "sha256-3f2a…" }
  ├─ 文件没变  → 写入，返回新 etag
  └─ 文件变了  → { ok: false, conflict: true, etag: "sha256-9c71…" }
                 「资产已被修改，请重新读取（ontology_get）后再写入」
```

写入工具会自动拿**本次读取**的 etag 做 CAS，所以即使调用方不传 `ifEtag`，并发写入也不会互相覆盖——输的一方拿到明确冲突和最新 etag，重试即可。

**2. 每文件写锁。** 所有写入经过同一个串行队列，不会出现两个 `writeFile` 交错写出半截 JSON。

实测：五路并发新增对象 → **五路全部成功，磁盘上五个对象一个不丢**。

（早期版本不是这样：那时读-改-写在锁外，五路里四路会报冲突。v0.28 把整段读改写
放进文件锁后，并发新增变成排队而不是争抢；显式传 `ifEtag` 时仍然保留 CAS 语义。）

```bash
node test/concurrency.test.cjs   # 10 项
node test/durability.test.cjs    # 9 项：并发不丢数据、无临时文件残留
```

边界：这是**单进程内**的保护。多个 DSH 实例共享同一资产目录时没有分布式锁——那需要外部协调（文件租约或数据库），不在当前范围。

## 装好没装好，一次调用确认

重启之后先跑这个：

```
ontology_diagnostics
```

```
本体工作台 v0.34 自检：正常
✓ 资产目录：…/assets（1 个资产包）
✓ 资产包：1 个全部通过校验
✓ 写入能力：可写（审批档位 destructive）
✓ 上下文简报：1209 字符，已就绪
✓ 工具注册：28 个（读写）：ontology_list, ontology_get, …
✓ 服务 approval：可用
✓ 执行轨迹：…/.ontology-traces.jsonl（可写）
```

三个用途：

- **确认加载的是新代码**：版本来自 `package.json`。宿主不会热重载宿主半，如果这里显示的是旧版本号，说明还需要重启——光看「工具有没有」是看不出来的，旧的 6 个工具也在；
- **确认可选服务**：`approval` / `systemPrompt` / `webServer` 缺任何一个，对应能力会静默降级（写入不再要审批、没有本体简报、面板读不到数据），自检会点名；
- **确认资产健康**：目录、包数量、校验状态、轨迹可写性一次报全。

有 `fail` 项时 `ok` 就是 `false`；`warn` 只是降级，不阻止使用。
