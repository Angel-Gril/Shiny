# 管理员用户详情与人工退款核查

状态：开发、代码审查及本地验收完成，准备提交PR。用户确认先做只读详情和人工退款核查，不接自动支付退款、不自动扣回赠金；尚未部署生产。

## 目标

在用户列表点用户即可打开统一详情，从消费日志和兑换码记录也能打开同一详情。资料、钱包额度、实际充值订单、兑换/赠金/调整和消费/退款日志分开展示，提供分页和用户级跳转。管理员无需手工复制用户ID反复查找。

## 账务语义

- 充值订单显示记录中的money、amount、credited_quota和支付方式/状态/时间，不使用当前Price或汇率重算历史。当前TopUp没有币种快照：未知显示“币种未记录”，不能推断订单实付总额是CNY/USD。金额合计若没有完整币种依据则不提供误导性统一总数。
- Quota是可用站内额度，UsedQuota是累计消费；不是可退款现金。
- 注册赠金、签到、邀请、兑换和人工调整按真实日志/结构化记录展示。旧日志缺少明确来源时标为未知，不能根据当前注册奖励设置推算用户当时所得赠金。
- 消费与赠金混合钱包缺少资金批次核销，不能计算“剩余充值本金”或自动建议退款金额。界面明确需要结合订单、使用记录和退款政策人工审核。
- 历史失败任务退款（LogTypeRefund）与支付网关现金退款分开标记，不能把返还API额度当现金已退。

## API合同（新增只读）

`GET /api/user/:id/insight?section=overview|topups|redemptions|checkins|logs&p=1&page_size=10&log_type=0`

沿用AdminAuth且控制器使用canManageTargetRole；未知/越权返回适当HTTP状态。DTO显式白名单，不返回User结构内密码、token、setting、安全绑定或可用兑换码；不改变余额，不创建退款。

overview响应data：
```
{user:{id,username,display_name,email,role,status,group,remark,created_at,last_login_at,inviter_id,inviter_username,quota,used_quota,request_count},
 stats:{successful_topups,redemptions,checkins,log_count,consume_count,refund_count},
 limitations:{wallet_provenance_complete:false,payment_currency_recorded:false}}
```

topups：`{items:[{id,trade_no,amount,credited_quota,money,payment_method,payment_provider,create_time,complete_time,status}],total,p,page_size}`；credited_quota缺失/0显示未记录，不从amount猜值。

redemptions：`{items:[{id,name,quota,redeemed_time}],total,p,page_size}`；只used_user_id目标且已使用记录，不返回key。

checkins：`{items:[{id,checkin_date,quota_awarded,created_at}],total,p,page_size}`；独立读取签到奖励记录，避免签到不写普通日志而遗漏赠金。

logs：`{items:[{id,created_at,type,content,model_name,quota,prompt_tokens,completion_tokens,use_time,is_stream,channel_id,token_name,request_id}],total,p,page_size}`；只目标user_id，读取独立LOG_DB，不返回原other/prompt正文/IP/secret。content按现有日志展示规范处理，root/admin敏感诊断不扩大。

分页上限50，支持log_type0..7白名单，按时间和id稳定排序；ClickHouse场景用已有兼容排序，不假定LOG_DB就是DB。不新增数据库列/表，不迁移生产余额。

## 实施分工与文件边界

1. 后端agent：new-api/model/user_insight.go、controller/user_insight.go、controller/user_insight_test.go、router/api-router.go。现有schema接口读取，三主库和独立日志测试，鉴权、分页、无密钥、未知币种/额度、日志隔离。不得修改余额、计费、用户表。
2. 前端agent：new-api/web/src/features/user-insight/*（新目录）、features/users/api.ts、types.ts、components/users-table.tsx、users-columns.tsx、data-table-row-actions.tsx、index.tsx、i18n七文件。新增统一UserInsightDialog和可复用UserInsightTrigger；用户列表用户名/详情按钮；分页资料/订单/兑换/日志tabs；复用项目Dialog/Tabs/DataTable/Loading/Error/formatQuota。根代理负责其它页面入口，避免同文件编辑。先mock约定DTO测试。
3. 根代理：Git归档/脱敏、ops与CI、消费日志和兑换码入口复用、集成测试、候选环境/发布和最终push。

分工不同文件，按ce-work并行实现。所有代理不做git提交/push和生产操作；主代理统一验收与提交。

## 验证

- backend用SQLite及可用MySQL/Postgres夹具按本项目AGENTS要求验证；独立logdatabase fixture覆盖用户隔离和错误类型。未能运行的数据库检查须明确报告，不宣称全库兼容。
- frontend特性测试：打开/错误/权限/切换目标/分页筛选；保证换用户不短暂显示前一用户资料。
- TypeScript、针对性lint、build、回归审核/用户管理；浏览器桌面手机、真实管理员只读接口，不记录用户私人数据截图进Git。
- 无生产钱款操作。部署NewAPI可先做隔离候选，现有审核配置/模型价格/账号余额对比不变；CPA/CPAMP/门户不重启。
- 每批提交扫描敏感数据，基础快照先push，再功能分支push；公开仓库不上传maintenance原始日志或第三方站导出文档。

## 已完成验收

- SQLite3.50.4、MySQL8.0.46、PostgreSQL16.13的真实隔离主/日志数据库测试通过；ClickHouse运行实例未就绪，本次未实测该可选日志库路径，未宣称全日志库矩阵通过。
- 46项前端定向回归通过（新增详情8项及用户管理/兑换/日志既有回归）。类型检查、定向lint/格式及生产构建通过。
- Linux amd64后端可构建；浏览器7项验收通过，使用虚构用户数据，含手机入口、订单币种未知、签到记录、赠金金额未记录和完整日志跳转。
- 代码审查发现的赠金日志quota默认0误导问题已修正：非消费/额度返还类型显示未记录；未根据文字推算资金。
- 现有生产服务与数据库不变。后续若部署，先使用独立候选和只读真实管理员验收，再固定release。
