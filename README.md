# Environmental Sample Chain Orchestrator

一个从 0-1 构建的环境样本链路编排项目基线，用来管理采样、容器封签、跨机构交接、实验室接收、分装、实验批次、仪器结果修订、质量复核和证据包导出。

## 当前实现

- `src/domain/types.ts`：领域对象、状态和同步模型
- `src/store/store.ts`：内存 Store、全局 ID、审计、Outbox 和事务快照回滚
- `src/services/sampling-service.ts`：采样记录与封存容器
- `src/services/custody-service.ts`：交出、接收、封签和温度轨迹
- `src/services/receiving-service.ts`：实验室接收、接受/隔离/拒收
- `src/services/aliquot-service.ts`：批量分装、单位换算、容量扣减和幂等操作
- `src/services/batch-service.ts`：实验批次成员、协议冻结和运行生命周期
- `src/services/result-service.ts`：仪器运行、外部运行号幂等和结果 revision
- `src/services/quality-service.ts`：质量结论、质控门槛和批次批准
- `src/services/evidence-service.ts`：一致性证据包、清单哈希和冻结
- `src/services/sync-service.ts`：离线 Envelope、客户端序列、payload 冲突和重放
- `src/demo/smoke.ts`：一条可运行的端到端样例

## 运行

```bash
npm install
npm run build
npm run smoke
npm test
```

## 批次锁定与结果接收规则

- 批次一旦 `start`，会冻结一份 `frozenSnapshot`（协议、仪器、成员、质控规则）；成员仅可在 DRAFT/READY 增删（`addAliquot`/`removeAliquot`），协议与质控规则仅可在 DRAFT/READY 通过 `updateProtocol`/`updateRequiredControls` 修改。运行后所有定义性修改返回 `batch.members_locked` / `batch.locked`。
- 外部运行号在“租户+项目”内唯一。相同原始文件指纹的重复注册幂等；不同指纹返回 `result.run_conflict`，绝不静默改绑。不同租户/项目可复用同一外部运行号。
- 结果按“运行 + 目标（样本 aliquot 或质控种类，互斥）+ 分析物”定址。同内容指纹重试幂等（迟到、乱序、run 已 COMPLETED 均返回原 revision）；不同指纹返回 `result.content_conflict`，先到结果不会被覆盖，也不会产生第二条 CURRENT。
- 合法更正必须走带 reviewer/reason 的 `amendRevision`（仅 RESULTS_PENDING/UNDER_REVIEW），旧版本变为 SUPERSEDED 并保留完整历史。
- 结果目标必须命中批次冻结快照中的成员或质控种类，否则 `result.unknown_member`/`result.unknown_control`。
- REJECTED/APPROVED 批次拒收新结果；REJECTED 批次可 `reopenForRetest`，冻结定义保持不变，旧 CURRENT 结果转为 WITHDRAWN（历史可审计、不被改写），重测以新 run 重新上传。
- 所有写操作在 `Store.transactionSync` 内执行，失败即快照回滚，不会留下半截结果、审计或 outbox。

测试见 `test/`：运行后编辑、结果乱序、指纹冲突、跨项目运行号、拒绝后重新处理、事务原子性。

当前源码是**干净基线**，没有为了出题主动埋入 Bug。后续应先在这份基线上补充测试和复现证据，再从真实缺陷中生成 Bug 题目。
