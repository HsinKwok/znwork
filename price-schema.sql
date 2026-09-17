-- 报价查询系统数据库结构
-- Cloudflare D1 (SQLite) 兼容

-- 产品类型表
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,           -- 产品代码: zinc0, zinc1, lead1, indium, silver1, iodine
    name TEXT NOT NULL,                  -- 产品名称
    unit TEXT NOT NULL,                  -- 单位: 元/吨, 元/千克
    spec TEXT,                           -- 规格: 1#锌锭, 1#铅锭
    sort_order INTEGER DEFAULT 0,        -- 显示顺序
    is_active BOOLEAN DEFAULT 1,         -- 是否启用
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 每日报价表 (核心数据)
CREATE TABLE IF NOT EXISTS daily_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,         -- 产品ID
    trade_date DATE NOT NULL,            -- 数据日期/交易日 (YYYY-MM-DD)
    collect_date DATE,                   -- 采集日期/当天日期 (YYYY-MM-DD)
    low_price DECIMAL(10,2) NOT NULL,    -- 最低价
    high_price DECIMAL(10,2) NOT NULL,   -- 最高价
    avg_price DECIMAL(10,2) NOT NULL,    -- 日均价 = (low+high)/2
    change_value DECIMAL(10,2) NOT NULL, -- 涨跌值 (正数为涨，负数为跌)
    change_percent DECIMAL(5,2),         -- 涨跌幅百分比
    source TEXT DEFAULT 'api',           -- 数据来源: api(自动), manual(手工), webhook(推送)
    remark TEXT,                         -- 备注
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, trade_date),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

-- 月度均价表 (预计算，提高查询性能)
CREATE TABLE IF NOT EXISTS monthly_averages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,         -- 产品ID
    year_month CHAR(7) NOT NULL,         -- 年月: 2026-08
    avg_price DECIMAL(10,2) NOT NULL,    -- 月均价
    days_count INTEGER NOT NULL,         -- 计算天数
    low_price DECIMAL(10,2) NOT NULL,    -- 月最低价
    high_price DECIMAL(10,2) NOT NULL,   -- 月最高价
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, year_month),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

-- API采集日志表
CREATE TABLE IF NOT EXISTS api_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_code TEXT NOT NULL,          -- 产品代码
    trade_date DATE NOT NULL,            -- 交易日
    status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'partial')),
    data_count INTEGER DEFAULT 0,        -- 采集到的数据条数
    error_message TEXT,                  -- 错误信息
    response_time INTEGER,               -- 响应时间(毫秒)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- webhook 配置表（外部系统推送配置，兼容采集器、ERP 等）
CREATE TABLE IF NOT EXISTS webhook_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                  -- 配置名称
    webhook_key TEXT NOT NULL UNIQUE,    -- 验证密钥（全局唯一）
    auth_type TEXT DEFAULT 'header',     -- 验证位置: header, query, none
    auth_header_name TEXT DEFAULT 'X-Webhook-Key', -- 验证头名称或查询参数名
    product_code_field TEXT DEFAULT 'product_code', -- 产品代码字段路径，支持点号
    trade_date_field TEXT DEFAULT 'trade_date',     -- 数据日期字段路径
    collect_date_field TEXT DEFAULT 'collect_date', -- 采集日期(当天日期)字段路径
    low_price_field TEXT DEFAULT 'low_price',       -- 最低价字段路径
    high_price_field TEXT DEFAULT 'high_price',     -- 最高价字段路径
    avg_price_field TEXT DEFAULT 'avg_price',       -- 日均价字段路径（可选，未提供时自动计算）
    change_value_field TEXT DEFAULT 'change_value', -- 涨跌值字段路径
    data_array_field TEXT,               -- 多条数据时的数组字段路径，为空则单条
    target_product_code TEXT,            -- 固定映射到的产品代码（当推送数据不含产品时）
    enabled BOOLEAN DEFAULT 1,           -- 是否启用
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- webhook 调用日志表
CREATE TABLE IF NOT EXISTS webhook_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id INTEGER,                  -- webhook 配置ID
    status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'partial')),
    data_count INTEGER DEFAULT 0,        -- 处理成功条数
    request_body TEXT,                   -- 请求体摘要
    error_message TEXT,                  -- 错误信息
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (webhook_id) REFERENCES webhook_configs(id) ON DELETE SET NULL
);

-- 推送配置表（向微信 Webhook 播报最新报价）
CREATE TABLE IF NOT EXISTS push_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                  -- 配置名称
    webhook_url TEXT NOT NULL,           -- 微信 Webhook 推送地址
    push_key TEXT NOT NULL UNIQUE,       -- 验证密钥（通过 URL 参数 ?key= 指定）
    product_id INTEGER,                  -- 首个绑定产品ID（兼容旧数据）
    product_ids TEXT,                    -- 绑定产品ID列表（JSON 数组，支持多选，各自推送最新价格）
    msg_type TEXT DEFAULT 'markdown',    -- 消息类型: markdown, text, card（模版卡片）
    template TEXT,                       -- 消息模板（占位符: {日期} {产品} {均价} {单位} {涨跌}，按产品逐个渲染）
    enabled BOOLEAN DEFAULT 1,           -- 是否启用
    last_push_at TIMESTAMP,              -- 上次推送时间
    last_push_status TEXT,               -- 上次推送状态: success, failed
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id)
);

-- 系统设置表
CREATE TABLE IF NOT EXISTS system_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,            -- 设置键
    value TEXT NOT NULL,                 -- 设置值
    description TEXT,                    -- 描述
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 管理员账号表
CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,       -- 用户名
    password_hash TEXT NOT NULL,         -- 密码哈希
    last_login TIMESTAMP,                -- 最后登录时间
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 登录失败限流表（D1 持久化，跨 isolate 与冷启动共享）
CREATE TABLE IF NOT EXISTS login_attempts (
    attempt_key TEXT PRIMARY KEY,        -- username|ip
    count INTEGER NOT NULL DEFAULT 0,    -- 失败次数
    reset_at INTEGER NOT NULL            -- 窗口起始时间（毫秒时间戳）
);

-- 注意：daily_prices 的 updated_at 由应用层 UPDATE 语句中的 updated_at = CURRENT_TIMESTAMP 统一管理，
-- 无需额外触发器（且 AFTER UPDATE 内再次 UPDATE 在启用递归触发器时有无限递归风险）

-- 月均价（monthly_averages）统一由应用层 updateMonthlyAverage() 单一维护，不使用触发器。
-- 原因：触发器与应用层的同类 SQL 双份维护容易漂移——旧 AFTER UPDATE 触发器只按 NEW.product_id 重算，
-- 修改记录所属产品时不会修正旧产品所在月份，导致旧产品月均价残留错误；
-- 且 CREATE TRIGGER IF NOT EXISTS 无法在存量库上升级已有触发器。
-- 重算入口：insertDailyPrice（新增）、后台记录增/改/删、批量删除、定时重算任务。
-- 存量库中的旧触发器由 Worker 在 ensurePriceSchema 中执行 DROP TRIGGER IF EXISTS 清理。

-- 初始化产品数据
INSERT OR IGNORE INTO products (code, name, unit, spec, sort_order) VALUES
('zinc0', '0#锌锭', '元/吨', '0#锌锭', 1),
('zinc1', '1#锌锭', '元/吨', '1#锌锭', 2),
('lead1', '1#铅锭', '元/吨', '1#铅锭', 3),
('indium', '精铟', '元/千克', '精铟', 4),
('silver1', '1#银', '元/千克', '1#银', 5),
('iodine', '碘', '元/千克', '碘', 6);

-- 初始化系统设置
INSERT OR IGNORE INTO system_settings (key, value, description) VALUES
('last_collection_time', '', '最后采集时间'),
('frontend_title', '报价查询系统', '前台标题'),
('data_source_name', '数据源', '数据源名称'),
('data_source_url', '', '数据源网址'),
('jwt_secret', '', '管理后台登录 token 签名密钥（留空将随机生成）'),
('homepage_product', '', '前台默认首页展示的产品代码（留空则自动选择首个有数据的产品）');

-- 注意：生产环境不预置管理员账号。
-- 首次部署后，请通过 /api/price/admin/setup 接口创建第一个管理员，
-- 或在数据库中手动插入使用 sha256:<hex> 格式的密码哈希记录。

-- 定时任务配置表（自建 Cron 调度器，URL 驱动）
CREATE TABLE IF NOT EXISTS cron_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,            -- 任务名称（全局唯一，防止重复配置）
    cron_expression TEXT NOT NULL,       -- cron 表达式（北京时间，后台按北京时间设置）
    task_url TEXT NOT NULL,              -- 任务 URL（内部 API 或外部地址）
    enabled BOOLEAN DEFAULT 1,           -- 是否启用
    last_run_at TIMESTAMP,               -- 上次执行时间
    last_run_status TEXT,                -- 上次执行状态
    last_run_message TEXT,               -- 上次执行消息
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 定时任务执行日志表
CREATE TABLE IF NOT EXISTS cron_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER,
    job_name TEXT NOT NULL,              -- 任务名称（冗余，方便查询）
    status TEXT NOT NULL,                -- success, failed, timeout(中断/超时后清理)
    message TEXT,                        -- 执行结果/错误信息
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE SET NULL
);

-- 创建索引以提高查询性能
-- 说明: daily_prices 的 (product_id, trade_date) 已由 UNIQUE 约束隐式建立索引，
-- 无需再建 idx_daily_prices_product_date（列完全相同，会重复占用写入开销）。
CREATE INDEX IF NOT EXISTS idx_daily_prices_date ON daily_prices(trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_monthly_averages_product_month ON monthly_averages(product_id, year_month DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_date ON api_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_product ON api_logs(product_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_wid ON webhook_logs(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_cron_logs_job ON cron_logs(job_id, started_at DESC);

-- 生产环境不预置每日报价数据。
-- 请通过外部系统 webhook 推送、管理后台手工补录或 API 接口导入真实数据。