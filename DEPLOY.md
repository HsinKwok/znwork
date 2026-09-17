# 报价查询系统部署指南

## 系统概述
基于 Cloudflare Worker + D1 的报价查询系统，支持多种产品价格展示、历史走势、月均价计算等功能。

## 文件结构
```
znwork/
├── price-worker.js          # Cloudflare Worker 主逻辑（入口）
├── price-schema.sql         # 数据库表结构（含初始产品与设置，不含测试数据）
├── wrangler.toml            # Worker 配置文件
├── package.json             # 项目配置
├── public/                  # 静态资源（直接托管，含页面与 css/js）
│   ├── price-frontend.html  # 前台用户界面
│   ├── price-admin.html     # 后台管理界面
│   ├── price-styles.css     # 基础布局样式
│   ├── price-mobile.css     # 移动端适配样式
│   ├── price-admin.css      # 后台样式
│   ├── shared.js            # 前后台共用脚本
│   ├── base.css
│   └── assets/              # bootstrap / font-awesome / chart.js 等本地依赖
├── .gitignore
└── DEPLOY.md                # 部署说明（本文件）
```

## 部署步骤

### 1. 环境准备
```bash
# 安装 Wrangler CLI
npm install -g wrangler

# 登录 Cloudflare
wrangler login
```

### 2. 创建 D1 数据库
```bash
# 创建数据库
wrangler d1 create znwork-price-db

# 复制生成的 database_id 到 wrangler.toml
# 更新 wrangler.toml 中的 database_id
```

### 3. 初始化数据库
```bash
# 执行数据库 schema（产品类型、系统设置，不含测试数据）
wrangler d1 execute znwork-price-db --file=price-schema.sql
```

### 4. 创建首个管理员账号
系统不再预置默认管理员。部署后直接访问后台管理页面 `/admin`，系统会自动检测到无管理员账号，弹出"首次部署 - 创建管理员"界面，在页面上直接填写用户名和密码即可创建。

### 5. 配置系统设置
登录管理后台（`/admin`）后，在「系统设置」中配置前台标题、数据源名称等设置。JWT 签名密钥首次登录时自动生成。

### 6. 部署 Worker
```bash
# 部署到 Cloudflare Workers
wrangler deploy
```

### 7. 配置访问地址（可选）

`wrangler.toml` 中的 `[vars] WORKER_URL` 用于生成推送卡片里的链接，默认值为占位域名：

```toml
[vars]
WORKER_URL = "https://example.com"   # 改成自己的实际访问地址
```

需要绑定自定义域名时，取消 `wrangler.toml` 中 `[[routes]]` 的注释并改成自己的域名
（该域名所在 zone 需已托管在本账号下），或在 Dashboard 的
Worker → Settings → Triggers → Custom Domains 中添加。

## 生产环境安全说明
- 已移除示例数据以及默认管理员账号。
- 密码使用 PBKDF2-SHA256 (10 万次迭代, 16 字节随机盐) 加密存储。
- 管理后台 Token 使用 HMAC-SHA256 签名，首次登录时若 `jwt_secret` 为空会自动生成随机密钥并持久化到数据库。
- 请使用强密码，并定期更换 API 密钥与管理员密码。

## API 接口说明

### 获取最新报价
- **URL**: `GET /api/price/latest?product=zinc0`
- **响应示例**:
```json
{
  "prices": [
    {
      "product_code": "zinc0",
      "product_name": "0#锌锭",
      "unit": "元/吨",
      "trade_date": "2026-08-28",
      "low_price": 26500.00,
      "high_price": 26900.00,
      "avg_price": 26700.00,
      "change_value": 100.00,
      "change_percent": 0.38,
      "monthly_avg": 26395.71
    }
  ]
}
```

### 后台管理接口
- **URL**: `POST /api/price/manual`
- **认证**: Bearer Token（管理员登录后获取的 JWT）
- **功能**: 手工补录数据

## 前端访问地址

### 前台用户界面
- 主页面: `https://<your-domain>/` (根据 wrangler.toml 配置)
- 或: `https://<your-worker>.<your-subdomain>.workers.dev/`

### 后台管理界面
- 管理页面: `https://<your-domain>/admin.html`
- 认证: 管理员账号密码登录后获取 JWT Token

## 移动端适配
系统通过 `price-styles.css`（基础布局与 ≤480px 断点）与 `price-mobile.css`（≤768px 移动端优化）协同实现响应式设计：
- 手机端: 单列布局，卡片式展示
- 平板端: 优化布局和字体大小
- 桌面端: 完整表格布局

## 数据模型

### 产品表 (products)
- `id`: 主键
- `code`: 产品代码 (唯一标识, 通过管理后台配置)
- `name`: 产品名称
- `unit`: 价格单位

### 日价格表 (daily_prices)
- `id`: 主键
- `product_id`: 产品ID
- `trade_date`: 交易日期
- `low_price`: 最低价
- `high_price`: 最高价
- `avg_price`: 日均价 (自动计算: (low+high)/2)
- `change_value`: 涨跌值
- `source`: 数据来源 (api/manual)

### 月均价表 (monthly_averages)
- `product_id`: 产品ID
- `year_month`: 年月 (YYYY-MM)
- `monthly_avg`: 月均价 (由应用层在报价数据增删改后自动重算)

## 注意事项

1. **API 安全**: 确保 API_KEY 和管理员 JWT Token 保密
2. **数据验证**: Worker 会验证输入数据的格式和范围
3. **移动端测试**: 建议在不同设备上测试响应式效果
4. **打印功能**: 前台页面支持打印格式化数据
5. **数据备份**: 定期备份 D1 数据库数据

## 故障排除

### 数据库连接失败
- 检查 `wrangler.toml` 中的 database_id 是否正确
- 确认数据库已创建并初始化

### API 认证失败
- 验证请求头中的 Bearer Token
- 检查环境变量配置

### 前端页面无法加载
- 检查 Worker 部署状态
- 确认路由配置正确

## 更新日志
- v1.0.0: 初始版本，支持基本报价查询和管理功能