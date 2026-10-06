# 安全报告

当前安全维护范围为 1.x 合同；未发布 rc/0.x 不提供独立修补或兼容双栈。已发布版本的安全更新按影响范围通知消费端。

如果发现来源校验绕过、跨工作区读取、凭据泄露、重复业务写入或任意宿主执行，GitHub 和 Gitee 都可作为联系入口，但不要假定两处具有相同的私密功能。在 [GitHub](https://github.com/leximeet/leximeet-connector-protocol) 已启用 Private vulnerability reporting 时使用该入口；通过 [Gitee](https://gitee.com/leximeet/leximeet-connector-protocol) 或没有私密入口的平台报告时，使用维护者明确提供的私密渠道。尚无渠道时只在公开 Issue 请求私下沟通，不公开利用载荷、秘密或用户资料。

报告中请提供受影响版本、可信来源与权限条件、使用合成数据的最小复现，以及预期与实际结果。不要试用不属于自己的账号、设备或服务凭据。

原始用户数据库、配对/会话 token、网页 cookie、机密语境和真实个人路径不能作为公开附件。安全边界见 [安全与隐私](docs/安全与隐私.md)。本政策不承诺尚未建立的响应 SLA。
