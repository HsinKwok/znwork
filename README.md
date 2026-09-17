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
├── DEPLOY.md                # 详细部署指南（API、数据模型、故障排除）
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

### 6. 配置定时任务（可选，但推荐）

`price-worker.js` 的 `scheduled()` 入口由 **Cloudflare Cron Triggers** 驱动，
定时任务按分钟粒度匹配，因此需要在 [wrangler.toml](wrangler.toml) 中补上触发器配置后重新部署：

```toml
[triggers]
crons = ["* * * * *"]
```

> 后台「定时任务」里配置的 cron 表达式按北京时间解析，实际是否执行取决于上面的触发频率。
> 若省略该配置，后台任务的「心跳」会一直为空，任务不会被执行。
> 免费计划下 Cron Triggers 的最小间隔为 1 分钟。

### 7. 配置访问地址与域名（可选）

- `[vars] WORKER_URL`：用于生成推送卡片中的链接，请改成自己的实际访问地址
  （默认占位为 `https://example.com`）。
- 自定义域名：取消 [wrangler.toml](wrangler.toml) 中 `[[routes]]` 的注释并改成自己的域名
  （该域名所在 zone 需已托管在同一 Cloudflare 账号下），
  或在 Dashboard 的 Worker → Settings → Triggers → Custom Domains 中添加。

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

## 安全说明

- 不预置默认管理员账号与默认密钥，避免弱口令与硬编码密钥
- 管理员密码使用 PBKDF2-SHA256（10 万次迭代 + 16 字节随机盐）存储
- 后台 Token 使用 HMAC-SHA256 签名，签名密钥随机生成并持久化
- 登录失败限流记录落库（D1），跨 isolate 与冷启动生效
- Webhook 与推送使用独立密钥鉴权，不复用管理员凭据
- `.dev.vars`、`node_modules/`、`.wrangler/` 已加入 `.gitignore`，请勿提交

## 详细文档

API 接口、数据模型、故障排除等内容见 [DEPLOY.md](DEPLOY.md)。

## 许可

本项目仅供学习与自建使用。
