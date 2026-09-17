# znwork · Cloudflare Workers 版报价查询系统

一个部署在 Cloudflare Workers 上的有色金属报价查询系统：前台展示最新报价、历史走势与月均价，
后台提供产品/记录/用户/Webhook/推送/定时任务管理。数据存储使用 D1（SQLite），
静态资源通过 Workers Assets 直出，无需自备服务器。

## 功能概览

**前台**（`/`）

- 最新报价卡片（最低价 / 最高价 / 日均价 / 涨跌值 / 涨跌幅 / 月均价）
- 历史报价查询（按产品与天数）、月均价走势
- 响应式布局，适配桌面、平板与手机
- 支持浏览器打印格式化数据

**后台**（`/admin`）

- 管理员账号管理（首次部署在页面直接创建，无预置默认账号）
- 产品类型管理（代码、名称、单位、规格、排序、启用开关）
- 报价记录管理（手工补录、编辑、删除、批量操作）
- Webhook 配置与调用日志（对接采集器 / ERP 等外部系统推送）
- 微信推送配置与手动触发（支持 markdown / text / 模版卡片）
- 系统设置（前台标题、数据源、首页默认产品等）
- 自建定时任务（cron 表达式按北京时间配置，含执行日志与心跳）

## 技术栈

| 组件 | 用途 |
| --- | --- |
| Cloudflare Workers | 运行时（ES Module Worker） |
| Cloudflare D1 | 数据库（绑定名 `DB`） |
| Workers Assets | 静态资源（绑定名 `ASSETS`，目录 `./public`） |
| Cloudflare Cron Triggers | 定时任务触发源 |
| Wrangler | 本地开发与部署 CLI |

## 目录结构

```
.
├── price-worker.js          # Worker 入口：路由、API、定时任务
├── price-schema.sql         # 建表脚本（含初始产品与系统设置，不含测试数据）
├── wrangler.toml            # Wrangler 配置
├── package.json
├── public/                  # 静态资源（直接托管）
│   ├── price-frontend.html  # 前台页面
│   ├── price-admin.html     # 后台页面
│   ├── shared.js            # 前后台共用脚本
│   ├── base.css
│   ├── price-styles.css     # 基础布局样式
│   ├── price-mobile.css     # 移动端适配样式
│   ├── price-admin.css      # 后台样式
│   └── assets/              # bootstrap / font-awesome / chart.js 等本地依赖
└── README.md
```

## 部署步骤

### 0. 前置条件

- 已安装 Node.js 18+
- 已有 Cloudflare 账号，并已登录 Wrangler：`npx wrangler login`

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create znwork-price-db
```

命令会输出 `database_id`，把它填到 [wrangler.toml](wrangler.toml) 中的 `<YOUR_D1_DATABASE_ID>` 处。

### 3. 初始化数据库

线上数据库：

```bash
npx wrangler d1 execute znwork-price-db --remote --file=price-schema.sql
```

本地开发数据库：

```bash
npx wrangler d1 execute znwork-price-db --local --file=price-schema.sql
```

> 脚本会建表并写入 6 个初始产品（锌锭、铅锭、精铟、银、碘）与默认系统设置，
> **不包含**任何报价数据与管理员账号。

### 4. 部署 Worker

```bash
npm run deploy
```

### 5. 创建首个管理员

系统不预置默认管理员。部署后访问 `/admin`，页面会检测到管理员表为空并显示
「创建管理员」表单，直接填写用户名与强密码提交即可。

### 6. 定时任务触发器（已内置）

`price-worker.js` 的 `scheduled()` 入口由 **Cloudflare Cron Triggers** 驱动，
[wrangler.toml](wrangler.toml) 中已配置每分钟触发一次：

```toml
[triggers]
crons = ["* * * * *"]
```

> 后台「定时任务」中配置的 cron 表达式按北京时间、分钟粒度解析，实际是否执行取决于上面的触发频率。
> 若删除该配置，后台任务的「心跳」会一直为空，任务不会被执行。
> 免费计划下 Cron Triggers 的最小间隔为 1 分钟。

### 7. 配置访问地址与域名（可选）

- `[vars] WORKER_URL`：用于生成推送卡片中的链接，请改成自己的实际访问地址
  （默认占位为 `https://example.com`）。
- 自定义域名：取消 [wrangler.toml](wrangler.toml) 中 `[[routes]]` 的注释并改成自己的域名
  （该域名所在 zone 需已托管在同一 Cloudflare 账号下），
  或在 Dashboard 的 Worker → Settings → Triggers → Custom Domains 中添加。

## 访问地址

| 入口 | 路径 | 说明 |
| --- | --- | --- |
| 前台 | `/` | 最新报价、历史走势、月均价 |
| 后台 | `/admin`（`/admin.html` 等价） | 管理员账号密码登录后进入 |

- 默认域名：`https://<worker-name>.<your-subdomain>.workers.dev/`
- 绑定自定义域名后：`https://<your-domain>/`

## 本地开发

```bash
npm run dev
```

默认监听 `http://localhost:8787`。本地调试请先用 `--local` 初始化本地 D1（见步骤 3）。

## 可用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动本地开发服务器 |
| `npm run deploy` | 部署到 Cloudflare |
| `npm run db:create` | 创建 D1 数据库 |
| `npm run db:execute` | 在 D1 上执行 `price-schema.sql` |
| `npm run db:console` | 查看 D1 中的表（`.tables`） |

## 配置项说明

| 名称 | 位置 | 说明 |
| --- | --- | --- |
| `DB` | wrangler.toml | D1 数据库绑定，需填入真实 `database_id` |
| `ASSETS` | wrangler.toml | 静态资源绑定，目录 `./public` |
| `WORKER_URL` | wrangler.toml `[vars]` | Worker 对外访问地址，非敏感 |
| `jwt_secret` | D1 `system_settings` | 后台登录 Token 签名密钥，首次登录自动生成 |
| `push_key` / `webhook_key` | D1 对应配置表 | 推送与 Webhook 的独立鉴权密钥，在后台生成 |

> 敏感配置统一存放在 D1 的 `system_settings` 及各配置表中，不写进 `wrangler.toml`。

## API 接口

查询类接口对外公开，无需鉴权；其余接口需在请求头携带 `Authorization: Bearer <登录返回的 token>`。

### 公开接口

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/price/latest` | GET | 最新报价 |
| `/api/price/history` | GET | 历史报价 |
| `/api/price/monthly` | GET | 月均价 |
| `/api/price/products` | GET | 产品列表 |
| `/api/price/last-update` | GET | 最后更新时间 |
| `/api/price/settings` | GET | 前台公开设置 |

### 独立密钥接口

| 接口 | 方法 | 鉴权方式 | 说明 |
| --- | --- | --- | --- |
| `/api/price/webhook/<配置ID>` | POST | Webhook 密钥 | 外部系统推送报价 |
| `/api/price/push/<配置ID>` | GET | URL 参数 `key` | 触发微信推送 |

### 后台接口

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/price/admin/login` | POST | 管理员登录，下发 Token |
| `/api/price/admin/setup` | POST | 首次创建管理员（仅 `admin_users` 为空时可用） |
| `/api/price/manual` | POST | 手工补录数据 |
| `/api/price/webhooks`、`/api/price/webhooks/<id>` | GET / POST / PUT / DELETE | Webhook 配置管理 |
| `/api/price/admin/push`、`/api/price/admin/push/<id>` | GET / POST / PUT / DELETE | 推送配置管理 |
| `/api/price/admin/settings` | GET / PUT | 系统设置 |
| `/api/price/admin/users`、`/api/price/admin/users/<id>` | GET / POST / PUT / DELETE | 管理员账号管理 |
| `/api/price/admin/products`、`/api/price/admin/products/<id>` | GET / POST / PUT / DELETE | 产品管理 |
| `/api/price/admin/records/<id>`、`/api/price/admin/records/batch` | GET / PUT / DELETE | 报价记录管理 |
| `/api/price/admin/stats`、`/api/price/admin/recent` | GET | 统计与最近记录 |
| `/api/price/admin/cron` 及其子路径 | GET / POST / PUT / DELETE | 定时任务管理 |

> 注意 `/api/price/manual` 与 `/api/price/webhook` 名称相近，但鉴权完全不同：前者用管理员 Token，后者用该 Webhook 配置自己的密钥。

### 查询参数

| 接口 | 参数 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `latest` | `product` | `zinc0` | 产品代码 |
| | `limit` | `1` | 返回条数，1–100 |
| `history` | `product` | `zinc0` | 产品代码 |
| | `days` | `30` | 回溯天数，1–3650 |
| `monthly` | `product` | `zinc0` | 产品代码 |
| | `month` | 当前北京时间月份 | `YYYY-MM`，取**该月及更早**的数据（截止月份，非精确匹配） |
| | `limit` | `12` | 返回条数，1–60 |

### 响应体

| 接口 | 响应 |
| --- | --- |
| `latest` | `{ "prices": [...] }` |
| `history` | `{ "history": [...] }` |
| `monthly` | `{ "monthly": [...] }` |
| `products` | `{ "products": [...], "homepage_product": "..." }` |
| `last-update` | `{ "last_update": "...", "last_trade_date": "..." }` |
| `settings` | `{ "settings": { "frontend_title": ..., "data_source_name": ..., "data_source_url": ... } }` |
| `admin/login` | `{ "success": true, "token": "...", "user": { "id": 1, "username": "..." } }` |

> 登录返回的 `token` 是 `base64url(payload).HMAC-SHA256签名` 的两段式自定义令牌（非标准三段式 JWT），
> 由 `system_settings.jwt_secret` 签名，需以 `Authorization: Bearer <token>` 形式携带。

### 获取最新报价

```bash
curl "https://<your-domain>/api/price/latest?product=zinc0&limit=1"
```

```json
{
  "prices": [
    {
      "id": 1,
      "product_code": "zinc0",
      "product_name": "0#锌锭",
      "unit": "元/吨",
      "trade_date": "2026-08-28",
      "low_price": 26500,
      "high_price": 26900,
      "avg_price": 26700,
      "change_value": 100,
      "change_percent": 0.38,
      "source": "api",
      "remark": null,
      "monthly_avg": 26395.71
    }
  ]
}
```

> 上例仅示意字段结构，数值非真实数据。`change_percent` 与 `monthly_avg` 均由 SQL 实时计算。

### Webhook 接收接口（外部系统推送报价）

- **URL**: `POST /api/price/webhook/<配置ID>`，也支持 `POST /api/price/webhook?id=<配置ID>`
- **配置 ID 必填**: 缺失或无效时返回 400「无效的 webhook 配置 ID」，不能裸调 `/api/price/webhook`
- **认证**: 按后台该配置的 `auth_type` 校验
  - `header`（默认）— 从指定请求头读取密钥
  - `query` — 从指定查询参数读取密钥
  - `none` — 不校验
  头名 / 参数名由 `auth_header_name` 决定，其默认值为 `X-Webhook-Key`
- **功能**: 接收采集器 / ERP 推送的报价数据，字段路径可在后台逐项映射；单条或数组（`data_array_field`）均可

### 推送触发接口（向微信 Webhook 播报）

- **URL**: `GET /api/price/push/<配置ID>?key=<push_key>`
- **认证**: URL 参数 `key`，值为后台推送配置中生成的 `push_key`
- **功能**: 触发后按配置的产品与消息模板推送最新报价，可交由定时任务周期调用

## 数据模型

### 产品表 (products)

- `id`: 主键
- `code`: 产品代码（唯一标识，通过管理后台配置）
- `name`: 产品名称
- `unit`: 价格单位
- `spec` / `sort_order` / `is_active`: 规格、排序、启用开关

### 日价格表 (daily_prices)

- `product_id`: 产品ID
- `trade_date` / `collect_date`: 交易日期 / 采集日期
- `low_price` / `high_price`: 最低价 / 最高价
- `avg_price`: 日均价（自动计算 `(low+high)/2`）
- `change_value` / `change_percent`: 涨跌值 / 涨跌幅（均为表内列；公开接口返回的 `change_percent` 是 SQL 实时计算值，并不直接读取该列）
- `source`: 数据来源（`api` / `manual` / `webhook`）

> `UNIQUE(product_id, trade_date)` 保证同一产品同一交易日只有一条记录。

### 月均价表 (monthly_averages)

- `product_id` / `year_month`: 产品ID / 年月（YYYY-MM）
- `avg_price`: 月均价（由应用层在报价数据增删改后自动重算）
- `days_count`: 参与计算的天数
- `low_price` / `high_price`: 当月最低价 / 最高价

### 其他表

- `webhook_configs` / `webhook_logs`: 外部系统推送配置与调用日志
- `push_configs`: 微信 Webhook 推送配置（绑定产品、消息模板、推送密钥）
- `system_settings`: 系统设置与密钥（`jwt_secret`、前台标题等）
- `admin_users`: 管理员账号（PBKDF2 密码哈希）
- `api_logs`: 数据采集日志
- `login_attempts`: 登录失败限流记录
- `cron_jobs` / `cron_logs`: 后台定时任务配置与执行日志

## 移动端适配

系统通过 `price-styles.css`（基础布局与 ≤480px 断点）与 `price-mobile.css`（≤768px 移动端优化）协同实现响应式设计：

- 手机端: 单列布局，卡片式展示
- 平板端: 优化布局和字体大小
- 桌面端: 完整表格布局

## 安全说明

- 不预置默认管理员账号与默认密钥，避免弱口令与硬编码密钥
- 管理员密码使用 PBKDF2-SHA256（10 万次迭代 + 16 字节随机盐）存储
- 后台 Token 使用 HMAC-SHA256 签名，签名密钥随机生成并持久化
- 登录失败限流记录落库（D1），跨 isolate 与冷启动生效
- Webhook 与推送使用独立密钥鉴权，不复用管理员凭据
- Worker 会校验输入数据的格式与范围
- `.dev.vars`、`node_modules/`、`.wrangler/` 已加入 `.gitignore`，请勿提交

## 注意事项

1. **密钥安全**: 确保 Webhook 密钥（`webhook_key`）、推送密钥（`push_key`）与管理员登录 Token 保密，并定期更换
2. **移动端测试**: 建议在不同设备上测试响应式效果
3. **打印功能**: 前台页面支持打印格式化数据
4. **数据备份**: 定期备份 D1 数据库数据

## 故障排除

### 数据库连接失败

- 检查 `wrangler.toml` 中的 `database_id` 是否正确
- 确认数据库已创建并初始化

### API 认证失败

- 验证请求头中的 Bearer Token 是否有效或已过期
- 检查 Webhook / 推送密钥是否与后台配置一致

### 前端页面无法加载

- 检查 Worker 部署状态
- 确认路由与 `[assets]` 配置正确

### 定时任务不执行

- 确认 `wrangler.toml` 中 `[triggers] crons` 未被删除，且已重新部署
- 在后台查看「心跳」时间是否更新，未更新说明 Cron 未触发

## 许可

本项目仅供学习与自建使用。
