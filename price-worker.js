// 报价查询系统 Cloudflare Worker

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // API 路由
    if (path.startsWith('/api/price/')) {
      return handlePriceApi(request, env, ctx);
    }
    
    // 忽略 wrangler dev 的 Vite HMR client 请求，避免返回 HTML 导致 JS 语法错误
    if (path === '/@vite/client') {
      return new Response('', {
        headers: { 'Content-Type': 'application/javascript' }
      });
    }
    
    // 静态文件服务
    if (path === '/' || path === '/index.html') {
      return serveStaticFile('index.html', env, request);
    }
    
    if (path === '/admin' || path === '/admin.html') {
      return serveStaticFile('price-admin.html', env, request);
    }
    
    // 其他路径优先按实际文件提供（CSS/JS/图片等静态资源）
    const assetResponse = await serveStaticFile(path.slice(1), env, request);
    if (assetResponse.status === 200) {
      return assetResponse;
    }

    // 只有页面导航才回退到前端页面（SPA 行为）。
    // 脚本/样式/图片等子资源缺失时必须返回 404，不能拿 HTML 顶替，
    // 否则会被浏览器的长缓存当成 JS 缓存一天，导致图表等功能失效。
    const accept = request.headers.get('Accept') || '';
    const isNavigate = request.headers.get('Sec-Fetch-Mode') === 'navigate';
    if (isNavigate || accept.includes('text/html')) {
      return serveStaticFile('index.html', env, request);
    }
    return new Response('文件未找到', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },

  // 定时任务入口：由 Cloudflare Cron Trigger 触发
  async scheduled(event, env, ctx) {
    await handleScheduledTask(event, env);
  }
};

// 处理价格相关 API
async function handlePriceApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // 处理 CORS 预检请求
  if (request.method === 'OPTIONS') {
    return handleOptions();
  }
  
  // 仅公开只读接口不需要 collect_date 等新增列，跳过迁移检查，
  // 避免首屏请求额外承担多次 DDL 往返；写接口与定时任务仍会执行迁移。
  const schemaSkippedPaths = [
    '/api/price/settings',
    '/api/price/products',
    '/api/price/latest',
    '/api/price/history',
    '/api/price/range',
    '/api/price/monthly',
    '/api/price/last-update'
  ];
  if (!schemaSkippedPaths.includes(path)) {
    await ensurePriceSchema(env);
  }
  
  // Webhook 接收接口：使用独立密钥鉴权，不走 admin 鉴权
  // 使用精确匹配避免误匹配 /api/price/webhooks（配置管理）路径
  if (path === '/api/price/webhook' || /^\/api\/price\/webhook\/\d+$/.test(path)) {
    return handleWebhook(request, env);
  }
  
  // 公开系统设置接口
  if (path === '/api/price/settings') {
    return withEdgeCache(request, ctx, 60, () => handleGetPublicSettings(env));
  }

  // 推送触发接口：URL 参数密钥鉴权（访问即向微信 Webhook 推送最新报价）
  if (/^\/api\/price\/push\/\d+$/.test(path) && request.method === 'GET') {
    return handlePushTrigger(request, env, url);
  }

  // 管理员登录接口：不需要提前认证
  if (path === '/api/price/admin/login') {
    return handleAdminLogin(request, env);
  }

  // 首次部署创建管理员：POST，仅当管理员表为空时允许
  if (path === '/api/price/admin/setup' && request.method === 'POST') {
    return handleAdminSetup(request, env);
  }

  // 认证检查（除公开查询、webhook、公开设置、登录、外部采集外）
  const publicPaths = ['/api/price/products', '/api/price/latest', '/api/price/history', '/api/price/range', '/api/price/monthly', '/api/price/last-update'];
  if (!publicPaths.includes(path) && !await checkAuth(request, env)) {
    return jsonResponse({ error: '未授权访问' }, 401);
  }

  // API 路由分发
  switch (true) {
    case path === '/api/price/products':
      return withEdgeCache(request, ctx, 60, () => handleGetProducts(env));

    case path === '/api/price/latest':
      return withEdgeCache(request, ctx, 60, () => handleGetLatestPrices(env, url));

    case path === '/api/price/history':
      return withEdgeCache(request, ctx, 60, () => handleGetPriceHistory(env, url));

    case path === '/api/price/range':
      return withEdgeCache(request, ctx, 60, () => handleGetPriceRange(env, url));

    case path === '/api/price/monthly':
      return withEdgeCache(request, ctx, 60, () => handleGetMonthlyAverages(env, url));

    case path === '/api/price/last-update':
      return withEdgeCache(request, ctx, 30, () => handleGetLastUpdate(env));
      
    case path === '/api/price/manual':
      return handleManualInput(request, env);
      
    case path === '/api/price/webhooks':
      return handleWebhookConfigs(request, env);
      
    case path.startsWith('/api/price/webhooks/'):
      return handleWebhookConfigDetail(request, env);
      
    // 推送设置管理
    case path === '/api/price/admin/push':
      return handlePushConfigs(request, env);
      
    case path.startsWith('/api/price/admin/push/'):
      return handlePushConfigDetail(request, env);
      
    case path === '/api/price/admin/settings':
      return handleAdminSettings(request, env);
      
    case path === '/api/price/admin/users':
      return handleAdminUsers(request, env);
      
    case path.startsWith('/api/price/admin/users/'):
      return handleAdminUserDetail(request, env);
      
    case path === '/api/price/admin/stats':
      return handleAdminStats(env);
      
    case path === '/api/price/admin/recent':
      return handleAdminRecent(request, env);
      
    case path === '/api/price/admin/products':
      return handleAdminProducts(request, env);
      
    case path.startsWith('/api/price/admin/products/'):
      return handleAdminProductDetail(request, env);
      
    case path === '/api/price/admin/records/batch':
      return handleBatchDeleteRecords(request, env);
      
    case path.startsWith('/api/price/admin/records/'):
      return handleAdminRecord(request, env);
      
    // 定时任务管理 — 精确路径必须先于通配 startsWith 匹配
    case path === '/api/price/admin/cron/logs':
      return handleAdminCronLogs(request, env);
      
    case path === '/api/price/admin/cron/heartbeat':
      return handleAdminCronHeartbeat(env);

    case path === '/api/price/admin/cron/_internal/recalc':
      return handleInternalRecalc(env);
      
    case path === '/api/price/admin/cron/_internal/data-check':
      return handleInternalDataCheck(env);

    case path === '/api/price/admin/cron/batch-run':
      return handleAdminCronBatchRun(request, env);

    case path === '/api/price/admin/cron/clear-stale':
      return handleAdminCronClearStale(request, env);

    case path === '/api/price/admin/cron':
      return handleAdminCronList(request, env);
      
    case path.startsWith('/api/price/admin/cron/'):
      return handleAdminCronDetail(request, env);
      
    default:
      return jsonResponse({ error: 'API 路径不存在' }, 404);
  }
}

// 获取公开系统设置（供前端页面使用）
async function handleGetPublicSettings(env) {
  try {
    const settings = await fetchPublicSettings(env);
    return jsonResponse({ settings }, 200, true, 60);
  } catch (error) {
    return serverError('获取设置失败', error, true);
  }
}

// 后台系统设置管理
async function handleAdminSettings(request, env) {
  try {
    switch (request.method) {
      case 'GET': {
        const { results } = await env.DB.prepare(`
          SELECT key, value, description 
          FROM system_settings 
          ORDER BY key
        `).all();
        return jsonResponse({ settings: results });
      }
      
      case 'PUT': {
        const { data, error } = await parseJsonBody(request);
        if (error) {
          return jsonResponse({ error }, 400);
        }
        
        const allowedKeys = [
          'frontend_title', 'data_source_name', 'data_source_url',
          'last_collection_time', 'homepage_product'
        ];
        
        let updated = 0;
        for (const [key, value] of Object.entries(data)) {
          if (!allowedKeys.includes(key)) continue;
          
          await setSetting(key, value, null, env);
          updated++;
        }
        
        return jsonResponse({ success: true, updated });
      }
      
      default:
      return methodNotAllowed();
    }
  } catch (error) {
    return serverError('系统设置操作失败', error);
  }
}

// 后台管理员用户列表/创建
async function handleAdminUsers(request, env) {
  try {
    switch (request.method) {
      case 'GET': {
        const { results } = await env.DB.prepare(`
          SELECT id, username, last_login, created_at 
          FROM admin_users 
          ORDER BY created_at
        `).all();
        return jsonResponse({ users: results });
      }
      
      case 'POST': {
        const { data, error } = await parseJsonBody(request);
        if (error) return jsonResponse({ error }, 400);
        
        if (!data.username || !data.password) {
          return jsonResponse({ error: '用户名和密码不能为空' }, 400);
        }
        
        const usernameError = validateUsernameLength(data.username);
        if (usernameError) {
          return jsonResponse({ error: usernameError }, 400);
        }
        
        const passwordError = validatePasswordLength(data.password);
        if (passwordError) {
          return jsonResponse({ error: passwordError }, 400);
        }
        
        const existing = await env.DB.prepare(
          'SELECT id FROM admin_users WHERE username = ?'
        ).bind(data.username).first();
        
        if (existing) {
          return jsonResponse({ error: '用户名已存在' }, 409);
        }
        
        const passwordHash = await hashPassword(data.password);
        
        const result = await env.DB.prepare(`
          INSERT INTO admin_users (username, password_hash)
          VALUES (?, ?)
        `).bind(data.username, passwordHash).run();
        
        return jsonResponse({ 
          success: true, 
          user: { id: result.meta.last_row_id, username: data.username } 
        });
      }
      
      default:
        return methodNotAllowed();
    }
  } catch (error) {
    return serverError('用户管理操作失败', error);
  }
}

// 后台单管理员用户管理（详情/更新/删除）
async function handleAdminUserDetail(request, env) {
  try {
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(/^\/api\/price\/admin\/users\/(\d+)$/);
    if (!pathMatch) {
      return jsonResponse({ error: '路径格式错误' }, 400);
    }
    
    const userId = parseInt(pathMatch[1]);
    const currentUser = await checkAuth(request, env);
    
    switch (request.method) {
      case 'GET': {
        const user = await env.DB.prepare(`
          SELECT id, username, last_login, created_at 
          FROM admin_users 
          WHERE id = ?
        `).bind(userId).first();
        
        if (!user) {
          return jsonResponse({ error: '用户不存在' }, 404);
        }
        
        return jsonResponse({ user });
      }
      
      case 'PUT': {
        const { data, error } = await parseJsonBody(request);
        if (error) return jsonResponse({ error }, 400);
        
        const existingUser = await recordExists(env, 'admin_users', userId);
        
        if (!existingUser) {
          return jsonResponse({ error: '用户不存在' }, 404);
        }
        
        if (data.username) {
          const usernameError = validateUsernameLength(data.username);
          if (usernameError) {
            return jsonResponse({ error: usernameError }, 400);
          }
          
          const usernameTaken = await env.DB.prepare(
            'SELECT id FROM admin_users WHERE username = ? AND id != ?'
          ).bind(data.username, userId).first();
          
          if (usernameTaken) {
            return jsonResponse({ error: '用户名已存在' }, 409);
          }
        }
        
        if (data.password) {
          const passwordError = validatePasswordLength(data.password);
          if (passwordError) {
            return jsonResponse({ error: passwordError }, 400);
          }
        }
        
        const updates = [];
        const params = [];
        
        if (data.username) {
          updates.push('username = ?');
          params.push(data.username);
        }
        
        if (data.password) {
          updates.push('password_hash = ?');
          params.push(await hashPassword(data.password));
        }
        
        if (updates.length === 0) {
          return jsonResponse({ error: '没有提供要更新的字段' }, 400);
        }
        
        params.push(userId);
        await env.DB.prepare(`
          UPDATE admin_users 
          SET ${updates.join(', ')} 
          WHERE id = ?
        `).bind(...params).run();
        
        return jsonResponse({ success: true });
      }
      
      case 'DELETE': {
        if (currentUser && currentUser.userId === userId) {
          return jsonResponse({ error: '不能删除当前登录用户' }, 400);
        }
        
        const countResult = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM admin_users'
        ).first();
        
        if (countResult && countResult.count <= 1) {
          return jsonResponse({ error: '系统中至少要保留一个管理员账号' }, 400);
        }
        
        const existingUser = await recordExists(env, 'admin_users', userId);
        
        if (!existingUser) {
          return jsonResponse({ error: '用户不存在' }, 404);
        }
        
        await env.DB.prepare('DELETE FROM admin_users WHERE id = ?').bind(userId).run();
        return jsonResponse({ success: true });
      }
      
      default:
        return methodNotAllowed();
    }
  } catch (error) {
    return serverError('用户管理操作失败', error);
  }
}

// 后台产品类型列表/创建
async function handleAdminProducts(request, env) {
  try {
    switch (request.method) {
      case 'GET': {
        const { results } = await env.DB.prepare(`
          SELECT id, code, name, unit, spec, sort_order, is_active, created_at, updated_at
          FROM products
          ORDER BY sort_order, id
        `).all();
        return jsonResponse({ products: results });
      }
      
      case 'POST': {
        const { data, error } = await parseJsonBody(request);
        if (error) return jsonResponse({ error }, 400);
        
        if (!data.code || !data.name || !data.unit) {
          return jsonResponse({ error: '产品代码、名称和单位不能为空' }, 400);
        }
        
        const codeError = validateProductCode(data.code);
        if (codeError) {
          return jsonResponse({ error: codeError }, 400);
        }
        
        const existing = await getProductByCode(env, data.code);
        
        if (existing) {
          return jsonResponse({ error: '产品代码已存在' }, 409);
        }
        
        const result = await env.DB.prepare(`
          INSERT INTO products (code, name, unit, spec, sort_order, is_active)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          data.code,
          data.name,
          data.unit,
          data.spec || '',
          parseInt(data.sort_order) || 0,
          toDbBoolean(data.is_active)
        ).run();
        
        return jsonResponse({
          success: true,
          product: { id: result.meta.last_row_id, code: data.code, name: data.name }
        });
      }
      
      default:
        return methodNotAllowed();
    }
  } catch (error) {
    return serverError('产品类型管理失败', error);
  }
}

// 后台单产品类型管理（详情/更新/删除）
async function handleAdminProductDetail(request, env) {
  try {
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(/^\/api\/price\/admin\/products\/(\d+)$/);
    if (!pathMatch) {
      return jsonResponse({ error: '路径格式错误' }, 400);
    }
    
    const productId = parseInt(pathMatch[1]);
    
    switch (request.method) {
      case 'GET': {
        const product = await env.DB.prepare(`
          SELECT id, code, name, unit, spec, sort_order, is_active, created_at, updated_at
          FROM products
          WHERE id = ?
        `).bind(productId).first();
        
        if (!product) {
          return jsonResponse({ error: '产品类型不存在' }, 404);
        }
        
        return jsonResponse({ product });
      }
      
      case 'PUT': {
        const { data, error } = await parseJsonBody(request);
        if (error) return jsonResponse({ error }, 400);
        
        const existingProduct = await env.DB.prepare(
          'SELECT code FROM products WHERE id = ?'
        ).bind(productId).first();
        
        if (!existingProduct) {
          return jsonResponse({ error: '产品类型不存在' }, 404);
        }
        
        if (data.code) {
          const codeError = validateProductCode(data.code);
          if (codeError) {
            return jsonResponse({ error: codeError }, 400);
          }
        }
        
        if (data.code && data.code !== existingProduct.code) {
          const codeTaken = await env.DB.prepare(
            'SELECT id FROM products WHERE code = ? AND id != ?'
          ).bind(data.code, productId).first();
          
          if (codeTaken) {
            return jsonResponse({ error: '产品代码已存在' }, 409);
          }
        }
        
        const updates = [];
        const params = [];
        
        const fields = [
          { key: 'code', default: null },
          { key: 'name', default: null },
          { key: 'unit', default: null },
          { key: 'spec', default: '' },
          { key: 'sort_order', default: 0, transform: v => parseInt(v) || 0 }
        ];
        
        for (const field of fields) {
          if (data[field.key] !== undefined && data[field.key] !== null) {
            updates.push(`${field.key} = ?`);
            params.push(field.transform ? field.transform(data[field.key]) : data[field.key]);
          }
        }
        
        if (data.is_active !== undefined) {
          updates.push('is_active = ?');
          params.push(toDbBoolean(data.is_active));
        }
        
        if (updates.length === 0) {
          return jsonResponse({ error: '没有提供要更新的字段' }, 400);
        }
        
        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(productId);
        
        await env.DB.prepare(`
          UPDATE products
          SET ${updates.join(', ')}
          WHERE id = ?
        `).bind(...params).run();

        // 如果修改了产品代码且该产品是首页产品，同步更新首页设置
        if (data.code && data.code !== existingProduct.code) {
          const homepageProduct = await getSetting('homepage_product', env);
          if (homepageProduct === existingProduct.code) {
            await setSetting('homepage_product', data.code, '前台默认首页产品代码', env);
          }
        }

        return jsonResponse({ success: true });
      }

      case 'DELETE': {
        const product = await env.DB.prepare(
          'SELECT id, code FROM products WHERE id = ?'
        ).bind(productId).first();

        if (!product) {
          return jsonResponse({ error: '产品类型不存在' }, 404);
        }

        const recordsCount = await env.DB.prepare(`
          SELECT COUNT(*) as count FROM daily_prices WHERE product_id = ?
        `).bind(productId).first();

        if (recordsCount && recordsCount.count > 0) {
          return jsonResponse({ error: '该产品类型已存在报价数据，无法删除，建议设置为停用' }, 400);
        }

        await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(productId).run();

        // 如果删除的是当前首页产品，清空首页设置
        const homepageProduct = await getSetting('homepage_product', env);
        if (homepageProduct === product.code) {
          await setSetting('homepage_product', '', '前台默认首页产品代码', env);
        }

        return jsonResponse({ success: true });
      }
      
      default:
        return methodNotAllowed();
    }
  } catch (error) {
    return serverError('产品类型管理失败', error);
  }
}

// 获取最后更新时间（前台公开接口）
async function handleGetLastUpdate(env) {
  try {
    const result = await env.DB.prepare(
      'SELECT MAX(updated_at) as last_update, MAX(trade_date) as last_trade_date FROM daily_prices'
    ).first();

    return jsonResponse({
      last_update: result && result.last_update ? result.last_update : null,
      last_trade_date: result && result.last_trade_date ? result.last_trade_date : null
    }, 200, true, 30);
  } catch (error) {
    return serverError('获取最后更新时间失败', error, true);
  }
}

// 后台统计数据
async function handleAdminStats(env) {
  try {
    // 按中国时区（UTC+8）计算当前月份
    const currentMonth = chinaMonth();

    // 四个统计互不依赖：并行查询，减少后台看板的等待时间
    const [totalResult, monthlyResult, webhookResult, lastUpdateResult] = await Promise.all([
      // 总记录数
      env.DB.prepare(
        'SELECT COUNT(*) as count FROM daily_prices'
      ).first(),
      // 本月更新数
      env.DB.prepare(`
        SELECT COUNT(*) as count FROM daily_prices 
        WHERE strftime('%Y-%m', trade_date) = ?
      `).bind(currentMonth).first(),
      // 最近30天 webhook 采集成功率（口径：success + partial 计入成功；按中国时区）
      env.DB.prepare(`
        SELECT
          SUM(CASE WHEN status IN ('success', 'partial') THEN 1 ELSE 0 END) as success_count,
          COUNT(*) as total_count
        FROM webhook_logs
        WHERE created_at >= datetime('now', '-30 days')
      `).first(),
      // 最后更新时间
      env.DB.prepare(`
        SELECT MAX(updated_at) as last_update FROM daily_prices
      `).first()
    ]);

    const successCount = webhookResult ? webhookResult.success_count || 0 : 0;
    const totalCount = webhookResult ? webhookResult.total_count || 0 : 0;
    // 无采集记录时不显示 100%（避免误导：可能根本没有数据采集）
    const successRate = totalCount > 0 ? Math.round((successCount / totalCount) * 100 * 10) / 10 : null;
    
    return jsonResponse({
      total_records: totalResult ? totalResult.count : 0,
      monthly_updates: monthlyResult ? monthlyResult.count : 0,
      success_rate: successRate,
      last_update: lastUpdateResult ? lastUpdateResult.last_update : null
    });
  } catch (error) {
    return serverError('获取统计数据失败', error);
  }
}

// 后台最近报价记录
async function handleAdminRecent(request, env) {
  try {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
    const pageSize = clampInt(parseInt(url.searchParams.get('pageSize')) || parseInt(url.searchParams.get('limit')) || 20, 1, 100);
    const offset = (page - 1) * pageSize;
    
    // 总数与列表互不依赖：并行查询
    const [countResult, listResult] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) as total FROM daily_prices
      `).first(),
      env.DB.prepare(`
        SELECT 
          d.id,
          p.name as product_name,
          d.trade_date,
          d.collect_date,
          d.low_price,
          d.high_price,
          d.avg_price,
          d.change_value,
          d.source,
          m.avg_price as monthly_avg
        ${MONTHLY_AVG_JOIN}
        ORDER BY d.trade_date DESC, d.id DESC
        LIMIT ? OFFSET ?
      `).bind(pageSize, offset).all()
    ]);
    const total = countResult ? countResult.total : 0;
    const results = listResult.results;
    
    return jsonResponse({
      records: results,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    });
  } catch (error) {
    return serverError('获取最近记录失败', error);
  }
}

// 后台批量删除报价记录
async function handleBatchDeleteRecords(request, env) {
  try {
    if (request.method !== 'DELETE') {
      return methodNotAllowed();
    }
    
    const { data, error } = await parseJsonBody(request);
    if (error) return jsonResponse({ error }, 400);
    const ids = data.ids;
    
    if (!Array.isArray(ids) || ids.length === 0) {
      return jsonResponse({ error: '请选择要删除的记录' }, 400);
    }
    
    const validIds = parseIdList(ids);
    
    if (validIds.length === 0) {
      return jsonResponse({ error: '记录 ID 格式错误' }, 400);
    }
    
    // 使用参数化 IN 查询删除存在的记录
    const idPlaceholders = placeholders(validIds);
    // 待删条数与受影响的「产品 + 月份」互不依赖：并行查询
    const [countResult, affectedMonths] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) as count FROM daily_prices WHERE id IN (${idPlaceholders})
      `).bind(...validIds).first(),
      env.DB.prepare(`
        SELECT DISTINCT product_id, strftime('%Y-%m', trade_date) as ym
        FROM daily_prices
        WHERE id IN (${idPlaceholders})
      `).bind(...validIds).all()
    ]);
    const willDelete = countResult ? countResult.count : validIds.length;

    await env.DB.prepare(`
      DELETE FROM daily_prices WHERE id IN (${idPlaceholders})
    `).bind(...validIds).run();

    // 重新计算受影响月份的月均价：所有语句合并成一次 batch 往返
    const recalcStatements = [];
    if (affectedMonths.results && affectedMonths.results.length > 0) {
      for (const row of affectedMonths.results) {
        recalcStatements.push(...buildMonthlyAverageStatements(env, row.product_id, row.ym + '-01'));
      }
    }
    if (recalcStatements.length > 0) {
      await env.DB.batch(recalcStatements);
    }

    return jsonResponse({
      success: true,
      deleted: willDelete
    });
  } catch (error) {
    return serverError('批量删除失败', error);
  }
}

// 后台单条记录管理（详情/更新/删除）
async function handleAdminRecord(request, env) {
  try {
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(/^\/api\/price\/admin\/records\/(\d+)$/);
    if (!pathMatch) {
      return jsonResponse({ error: '路径格式错误' }, 400);
    }
    
    const recordId = parseInt(pathMatch[1]);
    
    switch (request.method) {
      case 'GET': {
        const record = await env.DB.prepare(`
          SELECT 
            d.id,
            p.code as product_code,
            p.name as product_name,
            d.trade_date,
            d.collect_date,
            d.low_price,
            d.high_price,
            d.avg_price,
            d.change_value,
            d.source,
            d.remark
          FROM daily_prices d
          JOIN products p ON d.product_id = p.id
          WHERE d.id = ?
        `).bind(recordId).first();
        
        if (!record) {
          return jsonResponse({ error: '记录不存在' }, 404);
        }
        
        return jsonResponse({ record });
      }
      
      case 'PUT': {
        const { data, error } = await parseJsonBody(request);
        if (error) return jsonResponse({ error }, 400);

        const existingRecord = await env.DB.prepare(
          'SELECT product_id, trade_date FROM daily_prices WHERE id = ?'
        ).bind(recordId).first();

        if (!existingRecord) {
          return jsonResponse({ error: '记录不存在' }, 404);
        }

        if (data.low_price === undefined || data.low_price === null || data.low_price === '' ||
            data.high_price === undefined || data.high_price === null || data.high_price === '') {
          return jsonResponse({ error: '缺少必要字段' }, 400);
        }

        let productId = null;
        if (data.product_code) {
          const product = await getProductByCode(env, data.product_code);

          if (!product) {
            return jsonResponse({ error: '产品类型不存在' }, 404);
          }
          productId = product.id;

          // 预判唯一约束冲突：目标产品该日期已有记录则拒绝改产品
          if (productId !== existingRecord.product_id) {
            const conflict = await env.DB.prepare(
              'SELECT id FROM daily_prices WHERE product_id = ? AND trade_date = ?'
            ).bind(productId, existingRecord.trade_date).first();
            if (conflict) {
              return jsonResponse({ error: '该产品该日期已有记录，无法更改产品' }, 409);
            }
          }
        }

        const priceRange = parsePriceRange(data.low_price, data.high_price);
        if (priceRange.error) {
          return jsonResponse({ error: priceRange.error }, 400);
        }
        const { lowPrice, highPrice } = priceRange;

        const avgResult = resolveAvgPrice(data.avg_price, lowPrice, highPrice, { strict: true });
        if (avgResult.error) {
          return jsonResponse({ error: avgResult.error }, 400);
        }
        const avgPrice = avgResult.avgPrice;
        // 涨跌值：未传入或格式错误时根据上一交易日自动计算
        const finalProductId = productId || existingRecord.product_id;
        const changeValue = await resolveChangeValue(data.change_value, finalProductId, existingRecord.trade_date, avgPrice, env);
        const remark = (data.remark === undefined || data.remark === null) ? '后台编辑' : data.remark;

        const updates = [
          'low_price = ?',
          'high_price = ?',
          'avg_price = ?',
          'change_value = ?',
          'remark = ?',
          'updated_at = CURRENT_TIMESTAMP'
        ];
        const params = [lowPrice, highPrice, avgPrice, changeValue, remark];

        if (productId) {
          updates.push('product_id = ?');
          params.push(productId);
        }

        params.push(recordId);

        await env.DB.prepare(`
          UPDATE daily_prices
          SET ${updates.join(', ')}
          WHERE id = ?
        `).bind(...params).run();

        // 编辑后重新计算受影响月份的月均价
        await updateMonthlyAverage(finalProductId, existingRecord.trade_date, env);
        if (productId && productId !== existingRecord.product_id) {
          await updateMonthlyAverage(existingRecord.product_id, existingRecord.trade_date, env);
        }

        return jsonResponse({ success: true });
      }
      
      case 'DELETE': {
        const existingRecord = await env.DB.prepare(
          'SELECT product_id, trade_date FROM daily_prices WHERE id = ?'
        ).bind(recordId).first();

        if (!existingRecord) {
          return jsonResponse({ error: '记录不存在' }, 404);
        }

        await env.DB.prepare('DELETE FROM daily_prices WHERE id = ?').bind(recordId).run();

        // 删除后重新计算受影响月份的月均价
        await updateMonthlyAverage(existingRecord.product_id, existingRecord.trade_date, env);

        return jsonResponse({ success: true });
      }
      
      default:
        return methodNotAllowed();
    }
  } catch (error) {
    return serverError('记录操作失败', error);
  }
}

// 重新计算某产品某月份的月均价
// 构造月均价重算语句（重算 + 残留清理），供单条写入与批量写入复用
function buildMonthlyAverageStatements(env, productId, tradeDate) {
  const yearMonth = String(tradeDate).slice(0, 7);
  // 用日期区间代替 strftime('%Y-%m', trade_date) 比较：
  // 后者无法走 (product_id, trade_date) 索引，会退化为按产品全表扫描
  const monthStart = yearMonth + '-01';
  const monthEnd = yearMonth + '-31';

  return [
    env.DB.prepare(`
      INSERT OR REPLACE INTO monthly_averages
      (product_id, year_month, avg_price, days_count, low_price, high_price, created_at, updated_at)
      SELECT
        product_id,
        ? as year_month,
        ROUND(AVG(avg_price), 2) as avg_price,
        COUNT(*) as days_count,
        MIN(low_price) as low_price,
        MAX(high_price) as high_price,
        COALESCE((SELECT created_at FROM monthly_averages WHERE product_id = ? AND year_month = ?), CURRENT_TIMESTAMP),
        CURRENT_TIMESTAMP
      FROM daily_prices
      WHERE product_id = ? AND trade_date BETWEEN ? AND ?
      GROUP BY product_id
    `).bind(yearMonth, productId, yearMonth, productId, monthStart, monthEnd),

    // 若该月已无数据，清理残留的月均价记录
    env.DB.prepare(`
      DELETE FROM monthly_averages
      WHERE product_id = ? AND year_month = ?
        AND NOT EXISTS (
          SELECT 1 FROM daily_prices
          WHERE product_id = ? AND trade_date BETWEEN ? AND ?
        )
    `).bind(productId, yearMonth, productId, monthStart, monthEnd)
  ];
}

async function updateMonthlyAverage(productId, tradeDate, env) {
  if (!productId || !tradeDate) return;
  // 重算与残留清理合并成一次 batch，减少一次数据库往返
  await env.DB.batch(buildMonthlyAverageStatements(env, productId, tradeDate));
}

// 获取产品列表（首屏引导接口：同时返回站点设置与最新更新时间，
// 让首屏只发一个请求即可完成渲染）
async function handleGetProducts(env) {
  try {
    const [{ results }, settings] = await Promise.all([
      env.DB.prepare(`
        SELECT 
          p.id, p.code, p.name, p.unit, p.spec, p.sort_order,
          COUNT(d.id) as record_count,
          MAX(d.trade_date) as latest_trade_date,
          MAX(d.updated_at) as latest_update,
          GROUP_CONCAT(DISTINCT substr(d.trade_date, 1, 4)) as years
        FROM products p
        LEFT JOIN daily_prices d ON p.id = d.product_id
        WHERE p.is_active = 1
        GROUP BY p.id
        ORDER BY p.sort_order
      `).all(),
      fetchPublicSettings(env)
    ]);

    // 年份降序数组，供前台按年份懒加载历史数据
    let lastUpdate = null;
    let lastTradeDate = null;
    const products = results.map(product => {
      if (product.latest_update && (!lastUpdate || product.latest_update > lastUpdate)) {
        lastUpdate = product.latest_update;
      }
      if (product.latest_trade_date && (!lastTradeDate || product.latest_trade_date > lastTradeDate)) {
        lastTradeDate = product.latest_trade_date;
      }
      const years = product.years
        ? String(product.years)
            .split(',')
            .map(v => parseInt(v, 10))
            .filter(v => !isNaN(v))
            .sort((a, b) => b - a)
        : [];
      return Object.assign({}, product, { years });
    });
    
    return jsonResponse({
      products,
      homepage_product: settings.homepage_product || '',
      settings,
      last_update: lastUpdate,
      last_trade_date: lastTradeDate
    }, 200, true, 60);
  } catch (error) {
    return serverError('数据库查询失败', error, true);
  }
}

// 首屏需要的公开设置：一次查询取回，避免逐项查询
async function fetchPublicSettings(env) {
  const keys = ['frontend_title', 'data_source_name', 'data_source_url', 'homepage_product'];
  const { results } = await env.DB.prepare(
    'SELECT key, value FROM system_settings WHERE key IN (?, ?, ?, ?)'
  ).bind(...keys).all();

  const settings = {};
  keys.forEach(key => { settings[key] = null; });
  (results || []).forEach(row => { settings[row.key] = row.value; });
  return settings;
}

// 涨跌幅(%) 统一计算表达式：多个查询共用，避免重复维护
const CHANGE_PERCENT_SQL = 'ROUND((CAST(d.change_value AS REAL) / NULLIF(d.avg_price - d.change_value, 0)) * 100, 2) as change_percent';

// 月均价关联片段：多个公开查询共用，避免重复维护
const MONTHLY_AVG_JOIN = `FROM daily_prices d
      JOIN products p ON d.product_id = p.id
      LEFT JOIN monthly_averages m ON p.id = m.product_id
        AND m.year_month = strftime('%Y-%m', d.trade_date)`;

// 获取最新报价
async function handleGetLatestPrices(env, url) {
  try {
    const productCode = url.searchParams.get('product') || 'zinc0';
    const limit = clampInt(parseInt(url.searchParams.get('limit')) || 1, 1, 100);
    
    const { results } = await env.DB.prepare(`
      SELECT 
        d.id,
        p.code as product_code,
        p.name as product_name,
        p.unit,
        d.trade_date,
        d.low_price,
        d.high_price,
        d.avg_price,
        d.change_value,
        ${CHANGE_PERCENT_SQL},
        d.source,
        d.remark,
        m.avg_price as monthly_avg
      ${MONTHLY_AVG_JOIN}
      WHERE p.code = ?
      ORDER BY d.trade_date DESC
      LIMIT ?
    `).bind(productCode, limit).all();
    
    return jsonResponse({ prices: results }, 200, true, 60);
  } catch (error) {
    return serverError('获取最新报价失败', error, true);
  }
}

// 获取历史价格（支持 days=最近N天 或 year=指定年份）
async function handleGetPriceHistory(env, url) {
  try {
    const productCode = url.searchParams.get('product') || 'zinc0';
    const yearParam = url.searchParams.get('year');
    let startDateStr;
    let endDateStr;

    if (yearParam) {
      // 按年份查询：前台切换年份时按需 AJAX 拉取，避免一次返回近十年数据
      if (!/^\d{4}$/.test(yearParam)) {
        return jsonResponse({ error: '年份参数格式应为 YYYY' }, 400, true);
      }
      const year = parseInt(yearParam, 10);
      if (year < 1900 || year > 9999) {
        return jsonResponse({ error: '年份参数超出有效范围' }, 400, true);
      }
      startDateStr = `${yearParam}-01-01`;
      endDateStr = `${yearParam}-12-31`;
    } else {
      const days = clampInt(parseInt(url.searchParams.get('days')) || 30, 1, 3650);
      // 按中国时区（UTC+8）计算开始日期和结束日期
      const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
      endDateStr = now.toISOString().split('T')[0];
      const startDate = new Date(now.getTime());
      startDate.setDate(startDate.getDate() - days);
      startDateStr = startDate.toISOString().split('T')[0];
    }

    // 保留 monthly_avg 字段以兼容既有 API 使用方
    const { results } = await env.DB.prepare(`
      SELECT 
        d.trade_date,
        d.low_price,
        d.high_price,
        d.avg_price,
        d.change_value,
        ${CHANGE_PERCENT_SQL},
        d.source,
        m.avg_price as monthly_avg
      ${MONTHLY_AVG_JOIN}
      WHERE p.code = ? 
        AND d.trade_date BETWEEN ? AND ?
      ORDER BY d.trade_date DESC
    `).bind(productCode, startDateStr, endDateStr).all();
    
    // compact=1：返回 { cols, rows } 的紧凑格式，去掉前端不用的 source/monthly_avg，
    // 一年的数据从约 34KB 降到约 10KB；未传该参数时保持原有结构以兼容外部调用方
    if (url.searchParams.get('compact') === '1') {
      return jsonResponse({
        compact: 1,
        cols: ['trade_date', 'low_price', 'high_price', 'avg_price', 'change_value'],
        rows: results.map(function(r) {
          return [r.trade_date, r.low_price, r.high_price, r.avg_price, r.change_value];
        })
      }, 200, true, 60);
    }

    return jsonResponse({ history: results }, 200, true, 60);
  } catch (error) {
    return serverError('获取历史价格失败', error, true);
  }
}

// 区间均价统计：跨年份区间由服务端聚合，避免前端加载全部历史后本地过滤
async function handleGetPriceRange(env, url) {
  try {
    const productCode = url.searchParams.get('product') || 'zinc0';
    const startDate = url.searchParams.get('start');
    const endDate = url.searchParams.get('end');

    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      return jsonResponse({ error: '日期参数格式应为 YYYY-MM-DD' }, 400, true);
    }
    if (startDate > endDate) {
      return jsonResponse({ error: '开始日期不能晚于结束日期' }, 400, true);
    }

    const row = await env.DB.prepare(`
      SELECT
        COUNT(d.avg_price) as count,
        ROUND(AVG(d.avg_price), 2) as avg_price,
        MAX(d.avg_price) as high_price,
        MIN(d.avg_price) as low_price
      FROM daily_prices d
      JOIN products p ON d.product_id = p.id
      WHERE p.code = ?
        AND d.trade_date BETWEEN ? AND ?
    `).bind(productCode, startDate, endDate).first();

    return jsonResponse({
      count: row ? row.count : 0,
      avg_price: row ? row.avg_price : null,
      high_price: row ? row.high_price : null,
      low_price: row ? row.low_price : null
    }, 200, true, 60);
  } catch (error) {
    return serverError('区间均价计算失败', error, true);
  }
}

// 获取月均价
async function handleGetMonthlyAverages(env, url) {
  try {
    const productCode = url.searchParams.get('product') || 'zinc0';
    const yearMonth = url.searchParams.get('month') || chinaMonth();
    const limit = clampInt(parseInt(url.searchParams.get('limit')) || 12, 1, 60);
    
    const { results } = await env.DB.prepare(`
      SELECT 
        m.year_month,
        m.avg_price,
        m.days_count,
        m.low_price,
        m.high_price,
        m.updated_at
      FROM monthly_averages m
      JOIN products p ON m.product_id = p.id
      WHERE p.code = ? 
        AND m.year_month <= ?
      ORDER BY m.year_month DESC
      LIMIT ?
    `).bind(productCode, yearMonth, limit).all();
    
    return jsonResponse({ monthly: results }, 200, true, 60);
  } catch (error) {
    return serverError('获取月均价失败', error, true);
  }
}

// 手工补录数据
async function handleManualInput(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }
  
  try {
    const { data, error } = await parseJsonBody(request);
    if (error) return jsonResponse({ error }, 400);
    
    // 验证必要字段（涨跌值不强制：留空或格式错误时按上一交易日自动计算）
    const required = ['product_code', 'trade_date', 'low_price', 'high_price'];
    for (const field of required) {
      if (data[field] === undefined || data[field] === null || data[field] === '') {
        return jsonResponse({ error: `缺少必要字段: ${field}` }, 400);
      }
    }
    
    const priceRange = parsePriceRange(data.low_price, data.high_price);
    if (priceRange.error) {
      return jsonResponse({ error: priceRange.error }, 400);
    }
    const { lowPrice, highPrice } = priceRange;

    // 获取产品ID
    const product = await getProductByCode(env, data.product_code);
    
    if (!product) {
      return jsonResponse({ error: '产品不存在' }, 404);
    }
    
    const productId = product.id;
    const tradeDate = normalizeDate(data.trade_date);
    if (!tradeDate) {
      return jsonResponse({ error: '交易日期格式错误' }, 400);
    }
    // 均价：用户填写则用填写值，未填则自动计算
    const avgResult = resolveAvgPrice(data.avg_price, lowPrice, highPrice, { strict: true });
    if (avgResult.error) {
      return jsonResponse({ error: avgResult.error }, 400);
    }
    const avgPrice = avgResult.avgPrice;

    // 涨跌幅：未传入或格式错误时根据上一交易日自动计算
    const changeValue = await resolveChangeValue(data.change_value, productId, tradeDate, avgPrice, env);

    // 插入数据（原子去重：同一产品同一天已有记录则跳过，不允许重复录入）
    const insertResult = await insertDailyPrice(env, {
      productId,
      tradeDate,
      lowPrice,
      highPrice,
      avgPrice,
      changeValue,
      source: 'manual',
      remark: data.remark || '后台手工补录'
    });

    if (!insertResult.success) {
      return jsonResponse({ error: insertResult.error }, 409);
    }
    
    return jsonResponse({
      success: true,
      message: '手工补录成功',
      data: {
        product_code: data.product_code,
        trade_date: data.trade_date,
        avg_price: avgPrice
      }
    });
    
  } catch (error) {
    return serverError('手工补录失败', error);
  }
}

// 首次部署创建第一个管理员（仅当管理员表为空时允许，路由层已限定 POST）
async function handleAdminSetup(request, env) {
  try {
    const countResult = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM admin_users'
    ).first();

    if (countResult && countResult.count > 0) {
      return jsonResponse({ error: '管理员账号已存在，无法重复初始化' }, 403);
    }

    const { data, error } = await parseJsonBody(request);
    if (error) return jsonResponse({ error }, 400);
    const { username, password } = data;

    if (!username || !password) {
      return jsonResponse({ error: '用户名和密码不能为空' }, 400);
    }

    const usernameError = validateUsernameLength(username);
    if (usernameError) {
      return jsonResponse({ error: usernameError }, 400);
    }

    const passwordError = validatePasswordLength(password);
    if (passwordError) {
      return jsonResponse({ error: passwordError }, 400);
    }

    const passwordHash = await hashPassword(password);
    const result = await env.DB.prepare(`
      INSERT INTO admin_users (username, password_hash)
      VALUES (?, ?)
      ON CONFLICT(username) DO NOTHING
    `).bind(username, passwordHash).run();
    if (result.meta && result.meta.changes === 0) {
      return jsonResponse({ error: '管理员账号已存在，无法重复初始化' }, 403);
    }

    return jsonResponse({
      success: true,
      message: '首个管理员账号创建成功',
      user: { id: result.meta.last_row_id, username }
    });
  } catch (error) {
    return serverError('初始化失败', error);
  }
}

// 登录限流（D1 持久化，跨 isolate 与冷启动共享；叠加 wrangler.toml 的 [[ratelimits]] 边缘限流）
// 两个维度：账号 + IP（挡住针对单一账号的爆破）、纯 IP（挡住同一 IP 轮换用户名扫号）
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_IP_MAX_ATTEMPTS = 20;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

// 用户名不存在时用来「陪跑」一次 PBKDF2 的占位哈希。
// PBKDF2 10 万次迭代是登录耗时的主体，若用户不存在就提前返回，
// 攻击者可用响应时间判断用户名是否真实存在；这里保证两条分支计算量一致。
const DUMMY_PASSWORD_HASH = 'pbkdf2:' + '0'.repeat(32) + ':' + '0'.repeat(64);

// 原子地「检查 + 累加」一次登录尝试：窗口过期时重置为 1，返回本窗口内（含本次）累计次数。
// 多个键合并成一次 batch，同一请求只付一次往返；单条 UPSERT 保证并发下不丢计数。
// 返回 Map<key, { count, resetAt }>，resetAt 为当前窗口起始毫秒时间戳（用于计算 Retry-After）。
async function bumpLoginAttempts(keys, now, env) {
  const statements = keys.map(key => env.DB.prepare(`
    INSERT INTO login_attempts (attempt_key, count, reset_at)
    VALUES (?, 1, ?)
    ON CONFLICT(attempt_key) DO UPDATE SET
      count = CASE WHEN ? - reset_at >= ? THEN 1 ELSE count + 1 END,
      reset_at = CASE WHEN ? - reset_at >= ? THEN ? ELSE reset_at END
    RETURNING count, reset_at
  `).bind(key, now, now, LOGIN_WINDOW_MS, now, LOGIN_WINDOW_MS, now));

  const stats = new Map();
  const results = await env.DB.batch(statements);
  const missing = [];
  keys.forEach((key, i) => {
    const row = results && results[i] && results[i].results ? results[i].results[0] : null;
    if (row) stats.set(key, { count: row.count, resetAt: row.reset_at });
    else missing.push(key);
  });
  // 兜底：若运行时没有回传 batch 内 RETURNING 的结果，回查一次真实计数，
  // 避免把「已超限」误判成第 1 次，导致限流静默失效。
  if (missing.length > 0) {
    const { results: rows } = await env.DB.prepare(
      `SELECT attempt_key, count, reset_at FROM login_attempts WHERE attempt_key IN (${placeholders(missing)})`
    ).bind(...missing).all();
    for (const key of missing) stats.set(key, { count: 1, resetAt: now });
    for (const row of rows || []) {
      stats.set(row.attempt_key, { count: row.count, resetAt: row.reset_at });
    }
  }
  return stats;
}

// 前置限流：Cloudflare Rate Limiting binding（见 wrangler.toml 的 [[ratelimits]]）。
// 放在 PBKDF2 之前，用边缘计数器先挡掉高频 IP，避免每次尝试都白跑 10 万次哈希迭代。
// 本地 dev 或环境未配置该 binding 时自动跳过；限流服务异常不影响登录。
async function checkCloudflareLoginLimit(ip, env) {
  if (!env.LOGIN_RATELIMIT || typeof env.LOGIN_RATELIMIT.limit !== 'function') {
    return { limited: false };
  }
  try {
    const { success } = await env.LOGIN_RATELIMIT.limit({ key: 'login:' + ip });
    if (!success) return { limited: true, retryAfter: 60 };
  } catch (error) {
    console.error('[login] 限流检查失败', error && error.message);
  }
  return { limited: false };
}

// 管理员登录
async function handleAdminLogin(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }
  
  try {
    const { data, error } = await parseJsonBody(request);
    if (error) return jsonResponse({ error }, 400);
    const { username, password } = data;
    if (!username || !password) {
      return jsonResponse({ error: '用户名和密码不能为空' }, 400);
    }

    // 限流检查：先走边缘计数（不碰数据库、不跑 PBKDF2），再做 D1 的「账号 + IP」双维度计数
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const gate = await checkCloudflareLoginLimit(ip, env);
    if (gate.limited) {
      return jsonResponse(
        { error: '登录尝试过于频繁，请稍后再试', retryAfter: gate.retryAfter },
        429, false, 0, { 'Retry-After': String(gate.retryAfter) }
      );
    }

    const accountKey = String(username) + '|' + ip;
    const ipKey = 'ip:' + ip;
    const now = Date.now();
    // 先自增再判断：账号 5 次、同 IP 20 次以内允许，超出即拦截
    const attemptStats = await bumpLoginAttempts([accountKey, ipKey], now, env);
    const accountStat = attemptStats.get(accountKey) || { count: 1, resetAt: now };
    const ipStat = attemptStats.get(ipKey) || { count: 1, resetAt: now };
    if (accountStat.count > LOGIN_MAX_ATTEMPTS || ipStat.count > LOGIN_IP_MAX_ATTEMPTS) {
      const blocking = accountStat.count > LOGIN_MAX_ATTEMPTS ? accountStat : ipStat;
      // 剩余等待时间：窗口起始 + 窗口长度 - 当前时间
      const retryAfter = Math.max(1, Math.ceil((blocking.resetAt + LOGIN_WINDOW_MS - now) / 1000));
      return jsonResponse(
        { error: '登录尝试过于频繁，请稍后再试', retryAfter },
        429, false, 0, { 'Retry-After': String(retryAfter) }
      );
    }

    // 查询用户
    const user = await env.DB.prepare(
      'SELECT id, username, password_hash FROM admin_users WHERE username = ?'
    ).bind(username).first();
    
    // 验证密码（PBKDF2-SHA256）
    // 用户不存在或历史哈希格式异常时，用占位哈希跑一次等价的 PBKDF2 计算，
    // 让两条分支耗时一致，避免通过响应时间枚举用户名。
    const hasUsableHash = Boolean(user && user.password_hash && user.password_hash.startsWith('pbkdf2:'));
    const isValid = await verifyPassword(password, hasUsableHash ? user.password_hash : DUMMY_PASSWORD_HASH);

    if (!hasUsableHash || !isValid) {
      // 失败次数已在进入时自增，无需再次写库
      return jsonResponse({ error: '用户名或密码错误' }, 401);
    }

    // 登录成功：清除失败计数（账号 + IP）+ 更新最后登录时间，合并为一次 batch
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_attempts WHERE attempt_key IN (?, ?)').bind(accountKey, ipKey),
      env.DB.prepare('UPDATE admin_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id)
    ]);
    
    // 生成 token
    const token = await generateToken(user.id, user.username, env);
    
    return jsonResponse({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username
      }
    });
    
  } catch (error) {
    return serverError('登录失败', error);
  }
}

// 辅助函数：恒定时间字符串比较，避免时序侧信道（长度不同直接返回 false）
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// 辅助函数：验证密码（PBKDF2-SHA256, 10 万次迭代）
async function verifyPassword(password, hash) {
  if (!hash || !password || !hash.startsWith('pbkdf2:')) return false;

  try {
    const parts = hash.slice(7).split(':');
    if (parts.length !== 2) return false;
    const salt = new Uint8Array(parts[0].match(/.{1,2}/g).map(b => parseInt(b, 16)));
    const storedHash = parts[1];
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const hashBuffer = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial, 256
    );
    const hashHex = bytesToHex(new Uint8Array(hashBuffer));
    return timingSafeEqual(hashHex, storedHash);
  } catch (e) {
    return false;
  }
}

// 辅助函数：密码哈希（PBKDF2-SHA256, 10 万次迭代, 16 字节随机盐值）
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hashHex = bytesToHex(new Uint8Array(hashBuffer));
  const saltHex = bytesToHex(salt);
  return 'pbkdf2:' + saltHex + ':' + hashHex;
}

// 辅助函数：生成 token（HMAC-SHA256 签名）
async function generateToken(userId, username, env) {
  const secret = await getJwtSecret(env);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    userId,
    username,
    iat: now,                                        // 签发时间
    exp: now + (8 * 60 * 60)                         // 8 小时过期（缩短有效期降低泄露风险）
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = await signToken(payloadB64, secret);
  return `${payloadB64}.${signature}`;
}

// 辅助函数：验证认证
async function checkAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7);
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  try {
    const [payloadB64, signature] = parts;
    const payloadJson = base64UrlDecode(payloadB64);
    const payload = JSON.parse(payloadJson);

    if (!payload.userId || payload.exp <= Math.floor(Date.now() / 1000)) {
      return false;
    }

    const secret = await getJwtSecret(env);
    const expectedSignature = await signToken(payloadB64, secret);
    if (!timingSafeEqual(signature, expectedSignature)) {
      return false;
    }

    return payload;
  } catch {
    return false;
  }
}

// 辅助函数：将日期统一格式化为 YYYY-MM-DD
// 支持完整日期 2026/08/30、2026.08.30、2026-08-30 以及仅有 MM-DD/M-D（按参考日期或北京时间补全年份）
function normalizeDate(dateStr, refDate) {
  if (!dateStr) return null;
  const str = String(dateStr).trim();
  if (!str) return null;
  const iso = str.replace(/\//g, '-').replace(/\./g, '-');
  // 完整日期：校验格式 + 日期真实性（排除 2026-13-32 等无效日期）
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return isValidDate(iso) ? iso : null;
  }
  // 仅有 MM-DD / M-D：补全年份（优先参考日期年份，其次当前北京时间年份）
  if (/^\d{1,2}-\d{1,2}$/.test(iso)) {
    const parts = iso.split('-');
    const refYear = refDate && /^\d{4}-/.test(String(refDate)) ? String(refDate).slice(0, 4) : chinaToday().slice(0, 4);
    const full = `${refYear}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
    return isValidDate(full) ? full : null;
  }
  return null;
}

// 校验 YYYY-MM-DD 是否为真实存在的日期
function isValidDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(iso + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

// 北京时间（UTC+8）当天日期 YYYY-MM-DD
function chinaToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 北京时间（UTC+8）当月 YYYY-MM
function chinaMonth() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

// 金额保留两位小数
function roundPrice(value) {
  return Math.round(value * 100) / 100;
}

// 解析均价：填写值有效则采用（strict 为 true 时对非法填写值报错），否则取区间中值
// roundProvided 为 false 时保留填写值原值（Webhook 采集场景）
function resolveAvgPrice(providedAvg, lowPrice, highPrice, options) {
  options = options || {};
  const hasProvided = providedAvg !== undefined && providedAvg !== null && providedAvg !== '';
  const provided = hasProvided ? parseFloat(providedAvg) : NaN;

  if (!isNaN(provided) && provided > 0) {
    return { avgPrice: options.roundProvided === false ? provided : roundPrice(provided) };
  }
  if (hasProvided && options.strict) {
    return { error: '均价必须是大于 0 的数字' };
  }
  return { avgPrice: roundPrice((lowPrice + highPrice) / 2) };
}

// 将数值钳制到 [min, max] 区间（用于查询参数归一化）
function clampInt(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

// 辅助函数：生成 SQL IN 子句的占位符，如 [1,2,3] → "?,?,?"
function placeholders(items) {
  return items.map(() => '?').join(',');
}

// 辅助函数：把数组按固定长度切块。D1 单条语句最多 100 个绑定参数，
// 批量 IN / VALUES 查询必须先分块，否则大批量推送会直接超出上限报错。
function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// 解析 id 数组：转为整数并过滤掉非法值与非正数
function parseIdList(raw) {
  return (Array.isArray(raw) ? raw : []).map(id => parseInt(id)).filter(id => id > 0);
}

// 辅助函数：字节数组转十六进制字符串
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 校验管理员用户名长度（3-32 字符），合法返回 null
function validateUsernameLength(username) {
  return (username.length < 3 || username.length > 32) ? '用户名长度应在 3-32 个字符之间' : null;
}

// 校验密码长度（至少 8 位），合法返回 null
function validatePasswordLength(password) {
  return password.length < 8 ? '密码长度不能少于 8 位' : null;
}

// 校验产品代码格式（字母/数字/下划线/横线），合法返回 null
function validateProductCode(code) {
  return /^[a-zA-Z0-9_-]+$/.test(code) ? null : '产品代码只能包含字母、数字、下划线和横线';
}

// 解析 JSON 请求体；非法 JSON 或非对象时返回 { error }，否则返回 { data }
async function parseJsonBody(request) {
  const data = await request.json().catch(() => null);
  if (!data || typeof data !== 'object') return { error: '请求体格式错误' };
  return { data };
}

// 按产品代码查询产品（仅取 id）
function getProductByCode(env, code) {
  return env.DB.prepare('SELECT id FROM products WHERE code = ?').bind(code).first();
}

// 按 updatable 白名单从 data 收集字段，生成动态 UPDATE 的 SET 片段与绑定值
// transform(key, value) 可选，用于按字段做类型/格式转换
function buildUpdateSet(data, updatable, transform) {
  const fields = [];
  const values = [];
  for (const key of updatable) {
    if (data[key] === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(transform ? transform(key, data[key]) : data[key]);
  }
  return { fields, values };
}

// 解析并校验报价区间（新增/编辑/采集共用）
// 成功返回 { lowPrice, highPrice }，失败返回 { error }
function parsePriceRange(rawLow, rawHigh) {
  const lowPrice = parseFloat(rawLow);
  const highPrice = parseFloat(rawHigh);
  if (isNaN(lowPrice) || isNaN(highPrice)) {
    return { error: '价格必须是数字' };
  }
  if (lowPrice <= 0 || highPrice <= 0) {
    return { error: '价格必须大于 0' };
  }
  if (lowPrice > highPrice) {
    return { error: '最低价不能高于最高价' };
  }
  return { lowPrice, highPrice };
}

// 上游未提供涨跌额（缺失或非法）时需要按上一交易日自动计算
function needsAutoChangeValue(rawChangeValue) {
  if (rawChangeValue === undefined || rawChangeValue === null || rawChangeValue === '') return true;
  return isNaN(parseFloat(rawChangeValue));
}

// 辅助函数：解析并自动计算涨跌值（未传入或格式错误时自动根据上一交易日推算）
// prevPriceCache 可选：预取批量场景下按 「productId|tradeDate」 命中时不再查库
async function resolveChangeValue(rawChangeValue, productId, tradeDate, avgPrice, env, prevPriceCache) {
  if (needsAutoChangeValue(rawChangeValue)) {
    return await calculateChangeValue(productId, tradeDate, avgPrice, env, prevPriceCache);
  }
  return parseFloat(rawChangeValue);
}

// 辅助函数：根据上一交易日自动计算涨跌额
async function calculateChangeValue(productId, tradeDate, avgPrice, env, prevPriceCache) {
  try {
    const cacheKey = productId + '|' + tradeDate;
    let prevPrice;
    if (prevPriceCache && prevPriceCache.has(cacheKey)) {
      prevPrice = prevPriceCache.get(cacheKey);
    } else {
      const prevRecord = await env.DB.prepare(`
        SELECT avg_price FROM daily_prices
        WHERE product_id = ? AND trade_date < ?
        ORDER BY trade_date DESC LIMIT 1
      `).bind(productId, tradeDate).first();
      prevPrice = prevRecord ? prevRecord.avg_price : null;
    }

    if (prevPrice !== null && prevPrice !== undefined) {
      return Math.round((avgPrice - prevPrice) * 100) / 100;
    }
  } catch (error) {
    console.error('自动计算涨跌额失败:', error.message);
  }
  return 0;
}

// 原子写入每日价格（同一产品同一数据日期已有记录则跳过），返回 { success, id, error }
// 手工补录与 Webhook 采集共用；collectDate 为采集日期（当天日期），缺省时回退北京时间当天
async function insertDailyPrice(env, params) {
  const collectDate = params.collectDate || chinaToday();
  const insertResult = await env.DB.prepare(`
    INSERT INTO daily_prices (product_id, trade_date, collect_date, low_price, high_price, avg_price, change_value, source, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, trade_date) DO NOTHING
  `).bind(
    params.productId,
    params.tradeDate,
    collectDate,
    params.lowPrice,
    params.highPrice,
    params.avgPrice,
    params.changeValue,
    params.source,
    params.remark
  ).run();

  if (!insertResult.meta || insertResult.meta.changes === 0) {
    return { success: false, error: '不允许重复录入数据' };
  }

  // 月均价由应用层统一维护（触发器已移除），插入成功后重算该产品该月
  if (!params.deferRecalc) {
    await updateMonthlyAverage(params.productId, params.tradeDate, env);
  }

  return { success: true, id: insertResult.meta.last_row_id };
}

// 辅助函数：布尔值转数据库存储（0/1）
function toDbBoolean(value) {
  if (value === false || value === '0' || value === 0 || value === 'false') {
    return 0;
  }
  // undefined 默认视为 1（启用），避免写入 NULL 到 NOT NULL 列
  return 1;
}

// 辅助函数：获取 JWT 签名密钥（不存在则自动生成并持久化）
// 密钥创建后不会变化，按 isolate 缓存，避免每个已鉴权请求都查一次 system_settings
let cachedJwtSecret = null;
async function getJwtSecret(env) {
  if (cachedJwtSecret) return cachedJwtSecret;
  let secret = await getSetting('jwt_secret', env);
  if (!secret) {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    secret = arrayBufferToBase64Url(randomBytes.buffer);
    await setSetting('jwt_secret', secret, '管理后台登录 token 签名密钥', env);
  }
  cachedJwtSecret = secret;
  return secret;
}

// 辅助函数：HMAC-SHA256 签名 token
// CryptoKey 按 secret 缓存到 isolate，已鉴权请求不再重复 importKey
let cachedHmacKey = null;
let cachedHmacKeySecret = null;
async function signToken(payloadB64, secret) {
  if (!cachedHmacKey || cachedHmacKeySecret !== secret) {
    const keyData = new TextEncoder().encode(secret);
    cachedHmacKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    cachedHmacKeySecret = secret;
  }
  const msgData = new TextEncoder().encode(payloadB64);
  const signature = await crypto.subtle.sign('HMAC', cachedHmacKey, msgData);
  return arrayBufferToBase64Url(signature);
}

// 辅助函数：Base64URL 编码
function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// UTF-8 安全：先编码为字节再 Base64，避免中文等非 Latin1 字符触发 btoa 异常
function base64UrlEncode(str) {
  return arrayBufferToBase64Url(new TextEncoder().encode(str));
}

function base64UrlDecode(str) {
  const padLen = (4 - (str.length % 4)) % 4;
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Webhook 接收接口（外部系统推送）
async function handleWebhook(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }
  
  try {
    // 从路径 /api/price/webhook/:id 或查询参数 id 获取配置ID
    let configId = null;
    const pathMatch = path.match(/^\/api\/price\/webhook\/(\d+)$/);
    if (pathMatch) {
      configId = parseInt(pathMatch[1]);
    } else {
      configId = parseInt(url.searchParams.get('id'));
      if (isNaN(configId)) {
        return webhookResponse(false, null, null, '无效的 webhook 配置 ID', 400);
      }
    }
    
    if (!configId) {
      return webhookResponse(false, null, null, '缺少 webhook 配置 ID', 400);
    }
    
    // 查询配置
    const config = await env.DB.prepare(
      'SELECT * FROM webhook_configs WHERE id = ? AND enabled = 1'
    ).bind(configId).first();
    
    if (!config) {
      return webhookResponse(false, null, null, 'Webhook 配置不存在或已禁用', 404);
    }
    
    // 密钥验证（去除首尾空格，避免复制时带入不可见字符）
    let providedKey = null;
    const headerName = (config.auth_header_name || 'X-Webhook-Key').trim();
    if (config.auth_type === 'header') {
      providedKey = request.headers.get(headerName);
    } else if (config.auth_type === 'query') {
      providedKey = url.searchParams.get(headerName);
    }
    
    const storedKey = String(config.webhook_key || '').trim();
    const receivedKey = providedKey ? String(providedKey).trim() : '';
    
    // 防御：非免验证模式下，存储密钥不能为空（防止两个空字符串匹配绕过认证）
    if (config.auth_type !== 'none' && !storedKey) {
      await logWebhook(env, config.id, 'failed', 0, null, 'Webhook 配置密钥为空，拒绝所有请求');
      return webhookResponse(false, null, null, 'Webhook 配置错误：密钥未设置', 500);
    }
    
    if (config.auth_type !== 'none' && !timingSafeEqual(receivedKey, storedKey)) {
      const debugInfo = `auth_type=${config.auth_type}, header=${headerName}, received_len=${receivedKey.length}, stored_len=${storedKey.length}`;
      await logWebhook(env, config.id, 'failed', 0, null, `密钥验证失败 (${debugInfo})`);
      return webhookResponse(false, null, null, '密钥验证失败', 401);
    }
    
    // 解析请求体
    let payload;
    
    try {
      payload = await request.json();
    } catch (e) {
      await logWebhook(env, config.id, 'failed', 0, null, 'JSON 解析失败: ' + e.message);
      return webhookResponse(false, null, null, '请求体不是有效 JSON', 400);
    }
    
    // 获取数据数组
    let records = [];
    if (config.data_array_field) {
      const arr = getFieldByPath(payload, config.data_array_field);
      if (!Array.isArray(arr)) {
        await logWebhook(env, config.id, 'failed', 0, JSON.stringify(payload).slice(0, 500), '数据数组字段不是数组');
        return webhookResponse(false, null, null, '数据数组字段格式错误', 400);
      }
      records = arr;
    } else {
      records = [payload];
    }
    
    if (records.length === 0) {
      await logWebhook(env, config.id, 'success', 0, JSON.stringify(payload).slice(0, 500), null);
      return webhookResponse(true, null, null, '成功处理 0 条数据', 200);
    }

    // 预取产品与上一交易日收盘价：各一次查询，替代循环内逐条查库
    const { productCache, prevPriceCache } = await prefetchWebhookContext(records, config, env);

    // 逐条处理（月均价延后到循环外统一重算，避免每条记录都打一次数据库）
    let successCount = 0;
    const errors = [];
    const successIds = [];
    const successTargets = [];
    const recalcKeys = new Set();

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      try {
        const result = await saveWebhookPriceRecord(record, config, env, {
          deferRecalc: true,
          productCache,
          prevPriceCache
        });
        if (result.success) {
          successCount++;
          if (result.id) successIds.push(result.id);
          if (result.productCode) successTargets.push(result.productCode);
          // 同一产品同一个月只重算一次
          recalcKeys.add(result.productId + '|' + String(result.tradeDate).slice(0, 7));
        } else {
          errors.push(`第${i + 1}条: ${result.error}`);
        }
      } catch (error) {
        errors.push(`第${i + 1}条: ${error.message}`);
      }
    }

    // 批量重算受影响的月均价：所有语句合并成一次 batch 往返
    if (recalcKeys.size > 0) {
      const statements = [];
      recalcKeys.forEach(key => {
        const [productId, yearMonth] = key.split('|');
        statements.push(...buildMonthlyAverageStatements(env, Number(productId), yearMonth + '-01'));
      });
      await env.DB.batch(statements);
    }
    
    const status = errors.length === 0 ? 'success' : (successCount > 0 ? 'partial' : 'failed');
    const errorMsg = errors.length > 0 ? errors.join('; ') : null;
    const bodySummary = JSON.stringify(payload).slice(0, 500);
    
    await logWebhook(env, config.id, status, successCount, bodySummary, errorMsg);
    
    // 更新最后采集时间（按中国时区）
    if (successCount > 0) {
      const chinaNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const chinaISO = chinaNow.toISOString().slice(0, -1) + '+08:00';
      await setSetting('last_collection_time', chinaISO, null, env);
    }
    
    if (successCount === 0) {
      return webhookResponse(false, null, null, errorMsg || '全部处理失败', 400, errors);
    }
    
    return webhookResponse(
      true, 
      successIds.join(','), 
      successTargets.join(','), 
      `成功处理 ${successCount}/${records.length} 条数据`, 
      200,
      errors.length > 0 ? errors : null
    );
    
  } catch (error) {
    return webhookResponse(false, null, null, 'Webhook 处理异常: ' + error.message, 500);
  }
}

// 从推送记录中提取产品代码与日期字段（预取与逐条保存共用，避免解析规则漂移）
function extractWebhookKeys(record, config) {
  let productCode = getFieldByPath(record, config.product_code_field || 'product_code');
  if (!productCode && config.target_product_code) {
    productCode = config.target_product_code;
  }
  // 采集日期（当天日期）：优先取配置字段，缺失或非法时回退北京时间当天
  const collectDate = normalizeDate(getFieldByPath(record, config.collect_date_field || 'collect_date')) || chinaToday();
  // 数据日期（交易日）：支持 MM-DD，按采集日期年份补全
  const tradeDate = normalizeDate(getFieldByPath(record, config.trade_date_field || 'trade_date'), collectDate);
  return { productCode, collectDate, tradeDate };
}

// 批量预取 Webhook 上下文：
//   1) 一次（或分块几次）查询取回本批涉及的全部产品；
//   2) 按 (product_id, trade_date) 去重后，一次性预取每条记录的上一交易日收盘价。
// 补录多条不同交易日时同样走预取：每条都以「库中该日期之前最近一条」为基准，
// 同一产品同一天推送多条时共用同一个前值（重复记录会被唯一键跳过）。
async function prefetchWebhookContext(records, config, env) {
  const productCache = new Map();
  const prevPriceCache = new Map();

  const items = [];
  const codes = new Set();
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      items.push(null);
      continue;
    }
    const keys = extractWebhookKeys(record, config);
    items.push({
      ...keys,
      needsAuto: needsAutoChangeValue(getFieldByPath(record, config.change_value_field || 'change_value'))
    });
    if (keys.productCode !== undefined && keys.productCode !== null && keys.productCode !== '') {
      codes.add(String(keys.productCode));
    }
  }
  if (codes.size === 0) return { productCache, prevPriceCache };

  const codeList = [...codes];
  // 1 参数/个 → 每块 100 个，正好卡在 D1 的 100 个绑定参数上限内
  for (const group of chunk(codeList, 100)) {
    const { results: products } = await env.DB.prepare(
      `SELECT id, code FROM products WHERE code IN (${placeholders(group)})`
    ).bind(...group).all();
    for (const product of products || []) productCache.set(String(product.code), product);
  }
  // 不存在的产品也写入 null，避免循环里再逐条查一次
  for (const code of codeList) {
    if (!productCache.has(code)) productCache.set(code, null);
  }

  const pairMap = new Map();
  for (const item of items) {
    if (!item || !item.needsAuto || !item.tradeDate) continue;
    if (item.productCode === undefined || item.productCode === null || item.productCode === '') continue;
    const product = productCache.get(String(item.productCode));
    if (!product) continue;
    pairMap.set(product.id + '|' + item.tradeDate, [product.id, item.tradeDate]);
  }
  const pairs = [...pairMap.values()];
  if (pairs.length === 0) return { productCache, prevPriceCache };

  // 2 参数/对 → 每块 50 对，保证不超过 100 个绑定参数
  for (const group of chunk(pairs, 50)) {
    const values = group.map(() => '(?, ?)').join(', ');
    const { results } = await env.DB.prepare(`
      WITH input(pid, td) AS (VALUES ${values})
      SELECT i.pid, i.td,
        (SELECT dp.avg_price FROM daily_prices dp
         WHERE dp.product_id = i.pid AND dp.trade_date < i.td
         ORDER BY dp.trade_date DESC LIMIT 1) AS prev_price
      FROM input i
    `).bind(...group.flat()).all();
    for (const row of results || []) {
      prevPriceCache.set(row.pid + '|' + row.td, row.prev_price);
    }
  }
  return { productCache, prevPriceCache };
}

// 保存单条 webhook 推送的价格数据
// options.deferRecalc 为 true 时不立即重算月均价，由调用方合并成一次批量写入
// options.productCache / prevPriceCache 为批量预取结果，缺省时退化为逐条查询
async function saveWebhookPriceRecord(record, config, env, options = {}) {
  if (!record || typeof record !== 'object') {
    return { success: false, error: '价格数据格式错误' };
  }

  // 字段提取（与预取逻辑共用 extractWebhookKeys，避免两处解析规则漂移）
  const { productCode, collectDate, tradeDate } = extractWebhookKeys(record, config);
  const priceRange = parsePriceRange(
    getFieldByPath(record, config.low_price_field || 'low_price'),
    getFieldByPath(record, config.high_price_field || 'high_price')
  );
  const { lowPrice, highPrice } = priceRange;
  let avgPrice = getFieldByPath(record, config.avg_price_field || 'avg_price');
  const rawChangeValue = getFieldByPath(record, config.change_value_field || 'change_value');

  if (!productCode) {
    return { success: false, error: '缺少产品代码' };
  }
  if (!tradeDate) {
    return { success: false, error: '缺少交易日期' };
  }
  if (priceRange.error) {
    return { success: false, error: priceRange.error };
  }

  avgPrice = resolveAvgPrice(avgPrice, lowPrice, highPrice, { roundProvided: false }).avgPrice;

  // 查询产品：批量预取命中时直接使用缓存（含“产品不存在”的 null 结果）
  const productCacheKey = String(productCode);
  const product = options.productCache && options.productCache.has(productCacheKey)
    ? options.productCache.get(productCacheKey)
    : await getProductByCode(env, productCode);

  if (!product) {
    return { success: false, error: `产品 ${productCode} 不存在` };
  }

  // 涨跌幅：未传入或格式错误时根据上一交易日自动计算
  const changeValue = await resolveChangeValue(rawChangeValue, product.id, tradeDate, avgPrice, env, options.prevPriceCache);
  
  // 写入数据库（原子去重：同一产品同一天已有记录则跳过，不允许重复录入）
  const result = await insertDailyPrice(env, {
    productId: product.id,
    tradeDate,
    collectDate,
    lowPrice,
    highPrice,
    avgPrice,
    changeValue,
    source: 'webhook',
    remark: 'Webhook 自动采集',
    deferRecalc: options.deferRecalc
  });
  if (result.success) {
    result.productCode = productCode;
    result.productId = product.id;
    result.tradeDate = tradeDate;
  }
  return result;
}

// Webhook 配置管理：列表/创建
async function handleWebhookConfigs(request, env) {
  try {
    switch (request.method) {
      case 'GET': {
        const { results } = await env.DB.prepare(`
          SELECT id, name, webhook_key, auth_type, auth_header_name,
                 product_code_field, trade_date_field, collect_date_field, low_price_field, high_price_field,
                 avg_price_field, change_value_field, data_array_field, target_product_code,
                 enabled, created_at, updated_at
          FROM webhook_configs
          ORDER BY id DESC
        `).all();
        return jsonResponse({ configs: results });
      }
      
      case 'POST': {
        const { data, error } = await parseJsonBody(request);
        if (error) return jsonResponse({ error }, 400);
        if (!data.name) {
          return jsonResponse({ error: '缺少必要字段: name' }, 400);
        }
        if (data.auth_type !== 'none' && !data.webhook_key) {
          return jsonResponse({ error: '缺少必要字段: webhook_key' }, 400);
        }
        
        const result = await env.DB.prepare(`
          INSERT INTO webhook_configs
          (name, webhook_key, auth_type, auth_header_name, product_code_field, trade_date_field,
           collect_date_field, low_price_field, high_price_field, avg_price_field, change_value_field, data_array_field,
           target_product_code, enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          data.name,
          data.webhook_key !== undefined && data.webhook_key !== null ? String(data.webhook_key).trim() : '',
          data.auth_type || 'header',
          (data.auth_header_name || 'X-Webhook-Key').trim(),
          data.product_code_field || 'product_code',
          data.trade_date_field || 'trade_date',
          data.collect_date_field || 'collect_date',
          data.low_price_field || 'low_price',
          data.high_price_field || 'high_price',
          data.avg_price_field || 'avg_price',
          data.change_value_field || 'change_value',
          data.data_array_field || null,
          data.target_product_code || null,
          toDbBoolean(data.enabled)
        ).run();
        
        return jsonResponse({ success: true, id: result.meta.last_row_id });
      }
      
      default:
        return methodNotAllowed();
    }
  } catch (error) {
    return serverError('Webhook 配置操作失败', error);
  }
}

// Webhook 配置管理：详情/更新/删除
async function handleWebhookConfigDetail(request, env) {
  try {
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(/^\/api\/price\/webhooks\/(\d+)$/);
    if (!pathMatch) {
      return jsonResponse({ error: '路径格式错误' }, 400);
    }
    
    const configId = parseInt(pathMatch[1]);
    
    switch (request.method) {
      case 'GET': {
        const config = await env.DB.prepare(
          'SELECT * FROM webhook_configs WHERE id = ?'
        ).bind(configId).first();
        
        if (!config) {
          return jsonResponse({ error: '配置不存在' }, 404);
        }
        
        return jsonResponse({ config });
      }
      
      case 'PUT': {
        const { data, error } = await parseJsonBody(request);
        if (error) return jsonResponse({ error }, 400);

        if (data.name !== undefined && !data.name) {
          return jsonResponse({ error: '配置名称不能为空' }, 400);
        }

        if (data.auth_type !== undefined && data.auth_type !== 'none' && data.webhook_key !== undefined && !data.webhook_key) {
          return jsonResponse({ error: '非免验证模式下验证密钥不能为空' }, 400);
        }

        const existingConfig = await recordExists(env, 'webhook_configs', configId);

        if (!existingConfig) {
          return jsonResponse({ error: '配置不存在' }, 404);
        }

        const updatable = ['name', 'webhook_key', 'auth_type', 'auth_header_name',
          'product_code_field', 'trade_date_field', 'collect_date_field', 'low_price_field', 'high_price_field',
          'avg_price_field', 'change_value_field', 'data_array_field', 'target_product_code', 'enabled'];

        const { fields, values } = buildUpdateSet(data, updatable, (key, value) => {
          if (key === 'enabled') return toDbBoolean(value);
          if (key === 'webhook_key' || key === 'auth_header_name') return String(value).trim();
          return value;
        });
        
        if (fields.length === 0) {
          return jsonResponse({ error: '没有可更新的字段' }, 400);
        }
        
        values.push(configId);
        await env.DB.prepare(
          `UPDATE webhook_configs SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(...values).run();
        
        return jsonResponse({ success: true });
      }
      
      case 'DELETE': {
        const existingConfig = await recordExists(env, 'webhook_configs', configId);
        
        if (!existingConfig) {
          return jsonResponse({ error: '配置不存在' }, 404);
        }
        
        await env.DB.prepare('DELETE FROM webhook_configs WHERE id = ?').bind(configId).run();
        return jsonResponse({ success: true });
      }
      
      default:
        return methodNotAllowed();
    }
  } catch (error) {
    return serverError('Webhook 配置操作失败', error);
  }
}

// Webhook 响应封装（兼容常见采集工具响应状态）
// ids: 入库记录 ID（多个用逗号分隔）
// targets: 对应产品代码（多个用逗号分隔）
// errors: 部分失败时的错误详情数组
function webhookResponse(success, ids, targets, desc, status, errors) {
  const body = {
    success,
    id: ids || '',
    target: targets || '',
    desc: desc || '',
    error: success ? '' : (desc || 'error')
  };
  if (errors && errors.length > 0) {
    body.errors = errors;
  }
  return jsonResponse(body, status, true);
}

// 记录 webhook 调用日志
async function logWebhook(env, webhookId, status, dataCount, requestBody, errorMessage) {
  try {
    await env.DB.prepare(`
      INSERT INTO webhook_logs (webhook_id, status, data_count, request_body, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).bind(webhookId, status, dataCount, requestBody, errorMessage).run();
  } catch (e) {
    // 日志记录失败不影响主流程，但应输出告警便于排查
    console.error('Webhook 日志写入失败:', e.message);
  }
}

// 根据点号路径从对象中提取字段值
function getFieldByPath(obj, path) {
  if (!path || !obj) return undefined;
  const keys = path.split('.');
  let value = obj;
  for (const key of keys) {
    if (value === null || value === undefined) return undefined;
    value = value[key];
  }
  return value;
}

// ==================== 推送设置（微信 Webhook 播报） ====================

// 报价表/Webhook 配置表的部署兜底迁移（每个 Worker isolate 仅执行一次）
// 缓存 Promise 而不是布尔值：并发请求在迁移完成前会复用同一次执行，
// 避免冷启动瞬间多个请求各跑一遍 6 条 DDL
let priceSchemaPromise = null;
async function ensurePriceSchema(env) {
  if (!priceSchemaPromise) {
    priceSchemaPromise = migratePriceSchema(env).catch(e => {
      console.error('ensurePriceSchema 失败:', e.message);
      // 迁移失败不缓存结果，下次请求可重试
      priceSchemaPromise = null;
    });
  }
  return priceSchemaPromise;
}

async function migratePriceSchema(env) {
  // daily_prices 增加采集日期（当天日期）列，已存在时忽略
  await addColumnIfMissing(env, 'daily_prices', 'collect_date', 'DATE');
  // webhook_configs 增加采集日期字段路径列，已存在时忽略
  await addColumnIfMissing(env, 'webhook_configs', 'collect_date_field', "TEXT DEFAULT 'collect_date'");
  // 移除历史遗留触发器：月均价改由应用层 updateMonthlyAverage 单一维护，
  // updated_at 由应用层 UPDATE 语句显式写入，二者均不再依赖触发器
  for (const trigger of [
    'update_monthly_avg_after_daily',
    'update_monthly_avg_after_update',
    'update_monthly_avg_after_delete',
    'update_daily_prices_timestamp'
  ]) {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  }
}

async function addColumnIfMissing(env, table, column, decl) {
  try {
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`).run();
  } catch (e) {
    if (!String(e.message).toUpperCase().includes('DUPLICATE')) throw e;
  }
}

// 默认推送消息模板
const DEFAULT_PUSH_TEMPLATE = '**{产品}** 最新报价\n日期：{日期}\n日均价：{均价} {单位}\n涨跌：{涨跌}';

// push_configs 表引导建表（每个 Worker isolate 仅执行一次，兼作部署兜底迁移）
let pushTableReady = false;
async function ensurePushTable(env) {
  if (pushTableReady) return;
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS push_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
        push_key TEXT NOT NULL UNIQUE,
        product_id INTEGER,
        product_ids TEXT,
        msg_type TEXT DEFAULT 'markdown',
        template TEXT,
        enabled BOOLEAN DEFAULT 1,
        last_push_at TIMESTAMP,
        last_push_status TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id)
      )
    `).run();
    // 兼容旧表结构：补充多产品列与推送内容指纹列（列已存在时自动忽略）
    await addColumnIfMissing(env, 'push_configs', 'product_ids', 'TEXT');
    await addColumnIfMissing(env, 'push_configs', 'last_push_content', 'TEXT');
    pushTableReady = true;
  } catch (e) {
    console.error('push_configs 建表失败:', e.message);
  }
}

// 解析配置绑定的产品ID列表（兼容旧单产品字段 product_id）
function parsePushProductIds(config) {
  const ids = [];
  if (config.product_ids) {
    try {
      const arr = JSON.parse(config.product_ids);
      if (Array.isArray(arr)) {
        for (const v of arr) {
          const n = parseInt(v);
          if (n && !ids.includes(n)) ids.push(n);
        }
      }
    } catch (e) {
      // JSON 解析失败时回退到旧字段
    }
  }
  if (ids.length === 0 && config.product_id) {
    const n = parseInt(config.product_id);
    if (n) ids.push(n);
  }
  return ids;
}

// 解析并校验推送配置绑定的产品 ID：解析 → 数量校验 → 存在性校验
// 成功返回 { productIds }，失败返回 { error }
async function resolveBoundProductIds(env, raw) {
  const productIds = parseIdList(raw);
  if (productIds.length === 0) return { error: '请至少选择一个绑定产品' };
  // 文本通知模版卡片 horizontal_content_list 最多 6 项，超出会被静默截断
  if (productIds.length > 6) return { error: '最多绑定 6 个产品' };
  const existCheck = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM products WHERE id IN (${placeholders(productIds)})`
  ).bind(...productIds).first();
  if (!existCheck || existCheck.count !== productIds.length) {
    return { error: '存在无效的产品 ID' };
  }
  return { productIds };
}

// 生成随机推送密钥
function generatePushKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes).slice(0, 24);
}

// 推送配置列表与新增
async function handlePushConfigs(request, env) {
  try {
    await ensurePushTable(env);
    if (request.method === 'GET') {
      const result = await env.DB.prepare(`
        SELECT pc.*, pr.name AS product_name, pr.code AS product_code, pr.unit AS product_unit
        FROM push_configs pc
        LEFT JOIN products pr ON pr.id = pc.product_id
        ORDER BY pc.id ASC
      `).all();
      return jsonResponse({ configs: result.results || [] });
    }

    if (request.method === 'POST') {
      const { data, error } = await parseJsonBody(request);
      if (error) return jsonResponse({ error }, 400);

      const name = String(data.name || '').trim();
      const webhookUrl = String(data.webhook_url || '').trim();
      if (!name) return jsonResponse({ error: '缺少必要字段: name' }, 400);
      if (!webhookUrl || !/^https?:\/\//i.test(webhookUrl)) {
        return jsonResponse({ error: '推送地址必须以 http(s):// 开头' }, 400);
      }

      // 绑定产品：支持多选数组，兼容旧单选字段
      let rawProductIds = Array.isArray(data.product_ids) ? data.product_ids : [];
      if (rawProductIds.length === 0 && data.product_id) rawProductIds = [data.product_id];
      const bound = await resolveBoundProductIds(env, rawProductIds);
      if (bound.error) return jsonResponse({ error: bound.error }, 400);
      const productIds = bound.productIds;

      const pushKey = String(data.push_key || '').trim() || generatePushKey();
      const validMsgTypes = ['markdown', 'text', 'card'];
      const msgType = validMsgTypes.includes(data.msg_type) ? data.msg_type : 'text';
      const template = String(data.template || '').trim() || DEFAULT_PUSH_TEMPLATE;
      const enabled = toDbBoolean(data.enabled);

      try {
        const result = await env.DB.prepare(`
          INSERT INTO push_configs (name, webhook_url, push_key, product_id, product_ids, msg_type, template, enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(name, webhookUrl, pushKey, productIds[0], JSON.stringify(productIds), msgType, template, enabled).run();
        return jsonResponse({ success: true, id: result.meta.last_row_id, push_key: pushKey });
      } catch (e) {
        if (String(e.message).toUpperCase().includes('UNIQUE')) {
          return jsonResponse({ error: '验证密钥已存在，请更换密钥' }, 400);
        }
        throw e;
      }
    }

    return methodNotAllowed();
  } catch (error) {
    return serverError('推送配置操作失败', error);
  }
}

// 推送配置详情 / 更新 / 删除 / 测试推送
async function handlePushConfigDetail(request, env) {
  try {
    await ensurePushTable(env);
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/price\/admin\/push\/(\d+)(\/test)?$/);
    if (!m) return jsonResponse({ error: 'API 路径不存在' }, 404);
    const configId = parseInt(m[1]);

    // 测试推送：管理员手动触发一次（跳过密钥验证）
    if (m[2] === '/test' && request.method === 'POST') {
      const result = await executePush(env, configId, null);
      return jsonResponse(result, result.success ? 200 : (result.status || 400));
    }

    if (request.method === 'GET') {
      const config = await env.DB.prepare(`
        SELECT pc.*, pr.name AS product_name, pr.code AS product_code
        FROM push_configs pc
        LEFT JOIN products pr ON pr.id = pc.product_id
        WHERE pc.id = ?
      `).bind(configId).first();
      if (!config) return jsonResponse({ error: '推送配置不存在' }, 404);
      return jsonResponse({ config });
    }

    if (request.method === 'PUT') {
      const { data, error } = await parseJsonBody(request);
      if (error) return jsonResponse({ error }, 400);

      const exists = await recordExists(env, 'push_configs', configId);
      if (!exists) return jsonResponse({ error: '推送配置不存在' }, 404);

      const updatable = ['name', 'webhook_url', 'push_key', 'msg_type', 'template', 'enabled'];
      const { fields, values } = buildUpdateSet(data, updatable, (key, value) => {
        if (key === 'name' || key === 'webhook_url' || key === 'push_key' || key === 'template') {
          return String(value).trim();
        }
        if (key === 'msg_type') return ['markdown', 'text', 'card'].includes(value) ? value : 'text';
        if (key === 'enabled') return toDbBoolean(value);
        return value;
      });

      // 绑定产品（多选）：product_ids 存 JSON 数组，product_id 记录首个产品以兼容旧逻辑
      if (data.product_ids !== undefined) {
        const bound = await resolveBoundProductIds(env, data.product_ids);
        if (bound.error) return jsonResponse({ error: bound.error }, 400);
        fields.push('product_ids = ?');
        values.push(JSON.stringify(bound.productIds));
        fields.push('product_id = ?');
        values.push(bound.productIds[0]);
      }
      if (fields.length === 0) return jsonResponse({ error: '没有需要更新的字段' }, 400);

      try {
        values.push(configId);
        await env.DB.prepare(
          `UPDATE push_configs SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(...values).run();
        return jsonResponse({ success: true });
      } catch (e) {
        if (String(e.message).toUpperCase().includes('UNIQUE')) {
          return jsonResponse({ error: '验证密钥已存在，请更换密钥' }, 400);
        }
        throw e;
      }
    }

    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM push_configs WHERE id = ?').bind(configId).run();
      return jsonResponse({ success: true });
    }

    return methodNotAllowed();
  } catch (error) {
    return serverError('推送配置操作失败', error);
  }
}

// 渲染推送消息模板（占位符：{日期} {产品} {均价} {单位} {涨跌}）
// 涨跌值格式化：正数 ↑、负数 ↓、零 - 0（推送模板/卡片/文本共用）
function formatChangeValue(value) {
  const change = value === null || value === undefined ? 0 : Number(value);
  if (change > 0) return '↑ +' + change;
  if (change < 0) return '↓ ' + change;
  return '- 0';
}

function renderPushTemplate(template, record) {
  const changeStr = formatChangeValue(record.change_value);

  return String(template || DEFAULT_PUSH_TEMPLATE)
    .replace(/\{日期\}/g, record.trade_date || '')
    .replace(/\{产品\}/g, record.product_name || '')
    .replace(/\{均价\}/g, record.avg_price === null || record.avg_price === undefined ? '' : String(record.avg_price))
    .replace(/\{单位\}/g, record.product_unit || '')
    .replace(/\{涨跌\}/g, changeStr);
}

// 构建文本通知模版卡片（企业微信群机器人 text_notice 类型）
function buildPushCard(env, records) {
  const siteUrl = (env && env.WORKER_URL) || 'https://example.com';

  // 单产品：突出显示日均价大字
  if (records.length === 1) {
    const rec = records[0];
    return {
      msgtype: 'template_card',
      template_card: {
        card_type: 'text_notice',
        source: { desc: '报价播报', desc_color: 0 },
        main_title: {
          title: rec.product_name,
          desc: '报价日期 ' + (rec.trade_date || '-')
        },
        emphasis_content: {
          title: rec.avg_price === null || rec.avg_price === undefined ? '-' : String(rec.avg_price),
          desc: '日均价（' + (rec.product_unit || '-') + '）'
        },
        horizontal_content_list: [
          { keyname: '涨跌', value: formatChangeValue(rec.change_value) },
          { keyname: '单位', value: rec.product_unit || '-' }
        ],
        card_action: { type: 1, url: siteUrl }
      }
    };
  }

  // 多产品：每个产品一行明细（horizontal_content_list 最多 6 项）
  // 各产品最新日期可能不同，副标题统一标注为「数据更新至」最新日期，避免误导
  let latestDate = records[0].trade_date || '';
  records.forEach(r => {
    if (r.trade_date && r.trade_date > latestDate) latestDate = r.trade_date;
  });
  return {
    msgtype: 'template_card',
    template_card: {
      card_type: 'text_notice',
      source: { desc: '报价播报', desc_color: 0 },
      main_title: {
        title: '最新报价播报',
        desc: '数据更新至 ' + (latestDate || '-')
      },
      horizontal_content_list: records.slice(0, 6).map(rec => ({
        keyname: rec.product_name || '-',
        value: (rec.avg_price === null || rec.avg_price === undefined ? '-' : String(rec.avg_price))
          + ' ' + (rec.product_unit || '')
          + '（' + formatChangeValue(rec.change_value) + '）'
      })),
      card_action: { type: 1, url: siteUrl }
    }
  };
}

// 执行推送：读取最新报价 → 渲染模板 → POST 到微信 Webhook
// key 为 null 表示管理员测试推送（跳过密钥与启用状态校验）
async function executePush(env, configId, key) {
  await ensurePushTable(env);
  const config = await env.DB.prepare('SELECT * FROM push_configs WHERE id = ?').bind(configId).first();
  if (!config) return { success: false, status: 404, error: '推送配置不存在' };

  if (key !== null) {
    const provided = String(key || '').trim();
    if (!provided || !timingSafeEqual(provided, String(config.push_key || '').trim())) {
      return { success: false, status: 401, error: '密钥验证失败' };
    }
    if (!config.enabled) return { success: false, status: 403, error: '推送配置已禁用' };
  }

  const productIds = parsePushProductIds(config);
  if (productIds.length === 0) return { success: false, status: 400, error: '推送配置未绑定产品' };

  // 一次查询取回所有绑定产品的最新一条报价（窗口函数按产品分组取最新），
  // 原来逐个产品各打一次数据库，产品多了推送耗时线性增长
  const { results: rows } = await env.DB.prepare(`
    SELECT product_id, trade_date, avg_price, change_value, product_name, product_unit
    FROM (
      SELECT dp.product_id, dp.trade_date, dp.avg_price, dp.change_value,
             pr.name AS product_name, pr.unit AS product_unit,
             ROW_NUMBER() OVER (PARTITION BY dp.product_id ORDER BY dp.trade_date DESC) AS rn
      FROM daily_prices dp
      JOIN products pr ON pr.id = dp.product_id
      WHERE dp.product_id IN (${placeholders(productIds)})
    )
    WHERE rn = 1
  `).bind(...productIds).all();

  // 按配置中的产品顺序还原推送内容顺序
  const byProductId = new Map((rows || []).map(r => [r.product_id, r]));
  const records = [];
  for (const pid of productIds) {
    const record = byProductId.get(pid);
    if (record) records.push(record);
  }

  if (records.length === 0) return { success: false, status: 400, error: '所有绑定产品均无报价数据' };

  // 去重：计算本次推送内容指纹，与上次一致则跳过（仅对真实触发生效，测试推送始终发送）
  const pushFingerprint = records
    .map(r => [r.product_id, r.trade_date, r.avg_price, r.change_value].join(':'))
    .join('|');
  if (key !== null && config.last_push_content === pushFingerprint) {
    return { success: true, skipped: true, message: '数据未变化，跳过推送', content: '' };
  }

  // 渲染消息并按微信群机器人格式组装
  let payload, content;
  if (config.msg_type === 'card') {
    // 文本通知模版卡片：自动生成结构化内容
    payload = buildPushCard(env, records);
    content = records.map(rec => {
      const changeStr = formatChangeValue(rec.change_value);
      return rec.product_name + ' ' + rec.avg_price + ' ' + (rec.product_unit || '') + '（' + changeStr + '）';
    }).join('\n');
  } else {
    content = records.map(rec => renderPushTemplate(config.template, rec)).join('\n\n');
    payload = config.msg_type === 'text'
      ? { msgtype: 'text', text: { content } }
      : { msgtype: 'markdown', markdown: { content } };
  }

  // 推送到微信 Webhook（带超时，避免下游无响应时拖垮整个 Worker 请求导致 522）
  let wechatResult;
  let timeoutId;
  try {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(config.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    wechatResult = await resp.json().catch(() => ({ errcode: resp.ok ? 0 : -1, errmsg: 'HTTP ' + resp.status }));
  } catch (e) {
    wechatResult = { errcode: -1, errmsg: '推送请求失败: ' + (e.name === 'AbortError' ? '请求超时(10s)' : e.message) };
  } finally {
    clearTimeout(timeoutId);
  }

  const ok = wechatResult.errcode === 0;

  // 记录推送状态；仅推送成功时更新内容指纹，失败时保留旧指纹以便下次重试
  try {
    if (ok) {
      await env.DB.prepare(
        'UPDATE push_configs SET last_push_at = CURRENT_TIMESTAMP, last_push_status = ?, last_push_content = ? WHERE id = ?'
      ).bind('success', pushFingerprint, configId).run();
    } else {
      await env.DB.prepare(
        'UPDATE push_configs SET last_push_at = CURRENT_TIMESTAMP, last_push_status = ? WHERE id = ?'
      ).bind('failed', configId).run();
    }
  } catch (e) {
    console.error('推送状态更新失败:', e.message);
  }

  return {
    success: ok,
    message: ok ? '推送成功' : '推送失败: ' + (wechatResult.errmsg || '未知错误'),
    content,
    wechat_response: wechatResult
  };
}

// 公开推送触发接口：GET /api/price/push/:id?key=xxx
async function handlePushTrigger(request, env, url) {
  const m = url.pathname.match(/^\/api\/price\/push\/(\d+)$/);
  if (!m) return jsonResponse({ error: 'API 路径不存在' }, 404);
  const configId = parseInt(m[1]);
  const key = url.searchParams.get('key');
  const result = await executePush(env, configId, key);
  return jsonResponse(result, result.success ? 200 : (result.status || 400));
}

// 辅助函数：获取系统设置
async function getSetting(key, env) {
  try {
    const result = await env.DB.prepare(
      'SELECT value FROM system_settings WHERE key = ?'
    ).bind(key).first();

    return result ? result.value : null;
  } catch (e) {
    console.error('读取系统设置失败:', key, e.message);
    return null;
  }
}

// 辅助函数：写入系统设置（存在则更新；description 传 null/undefined 时保留原描述）
async function setSetting(key, value, description = null, env) {
  try {
    await env.DB.prepare(`
      INSERT INTO system_settings (key, value, description, updated_at)
      VALUES (?, ?, COALESCE(?, ''), CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        description = COALESCE(?, description),
        updated_at = CURRENT_TIMESTAMP
    `).bind(key, value, description, description).run();
  } catch (error) {
    console.error('写入设置失败:', key, error.message);
  }
}

// 跨域响应头（公开接口响应与 OPTIONS 预检共用）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// 辅助函数：返回 JSON 响应（cors=true 用于公开/跨域接口，默认 false 仅同源）
// maxAge > 0 时允许浏览器缓存该响应若干秒（仅用于公开只读接口）
// extraHeaders 用于附加自定义响应头（如 429 的 Retry-After）
function jsonResponse(data, status = 200, cors = false, maxAge = 0, extraHeaders = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    // 默认禁用缓存避免返回陈旧结果；公开只读接口按 maxAge 缓存，
    // 数据每 5 分钟采集一次，短缓存既不影响准确性又能省掉回访时的数据库查询
    'Cache-Control': maxAge > 0
      ? `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=300`
      : 'no-store, no-cache, must-revalidate',
  };
  if (cors) {
    Object.assign(headers, CORS_HEADERS);
  }
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

// 公开只读接口的边缘缓存：同一 URL 在 TTL 内直接复用响应，省掉重复的 D1 查询。
// 仅在 GET 且运行环境提供 caches.default 时启用（本地 dev 自动降级为直连）。
// 失败（如 cache API 异常）时回退为直接查询，不影响功能。
// 缓存键参数白名单：只保留真正影响查询结果的参数。
// 直接用完整 URL 做缓存键时，?t=1699999999 这类无意义参数、参数顺序差异、
// 大小写不同的键名都会各占一份缓存，命中率被显著拉低。
// 未列出的路径保持完整 URL（避免误伤未预期的查询语义）。
const EDGE_CACHE_KEY_PARAMS = {
  '/api/price/settings': [],
  '/api/price/products': [],
  '/api/price/last-update': [],
  '/api/price/latest': ['product', 'limit'],
  '/api/price/history': ['product', 'year', 'days', 'compact'],
  '/api/price/range': ['product', 'start', 'end'],
  '/api/price/monthly': ['product', 'month', 'limit']
};

function buildEdgeCacheKey(url) {
  const allowed = EDGE_CACHE_KEY_PARAMS[url.pathname];
  if (!allowed) return url.toString();
  const params = new URLSearchParams();
  for (const key of [...allowed].sort()) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== '') params.set(key, value);
  }
  const query = params.toString();
  return url.origin + url.pathname + (query ? '?' + query : '');
}

async function withEdgeCache(request, ctx, maxAge, loader) {
  if (request.method !== 'GET' || typeof caches === 'undefined' || !caches.default) {
    return loader();
  }
  const cache = caches.default;
  const cacheKey = new Request(buildEdgeCacheKey(new URL(request.url)), { method: 'GET' });

  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('X-Edge-Cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers });
    }
  } catch (e) {}

  const response = await loader();
  if (response.status !== 200) return response;

  try {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=300`);
    headers.set('X-Edge-Cache', 'MISS');
    const body = await response.arrayBuffer();
    ctx.waitUntil(cache.put(cacheKey, new Response(body, { status: 200, headers })));
    return new Response(body, { status: 200, headers });
  } catch (e) {
    return response;
  }
}

// 辅助函数：返回 500 服务器错误
// 公开接口（cors = true）任何人都能调用，异常文本可能包含 SQL 片段、表名、
// 绑定值等内部信息，因此只回传通用错误；原始异常统一打到 Worker 日志。
// 后台接口（已通过鉴权）仍附带 details，便于排障。
function serverError(message, error, cors = false) {
  console.error('[serverError]', message, error && error.stack ? error.stack : error);
  if (cors) {
    return jsonResponse({ error: message }, 500, true);
  }
  return jsonResponse({ error: message, details: error && error.message }, 500, false);
}

// 辅助函数：返回 405 方法不支持
function methodNotAllowed() {
  return jsonResponse({ error: '请求方法不支持' }, 405);
}

// 辅助函数：判断指定表中是否存在该 id 记录（table 仅接受内部常量表名）
async function recordExists(env, table, id) {
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
  return !!row;
}

// 辅助函数：提供静态文件（HTML 走 ETag 协商缓存，静态资源走强缓存）
async function serveStaticFile(filename, env, request) {
  try {
    const isHtml = filename.endsWith('.html');
    const cacheControl = isHtml ? 'no-cache' : 'public, max-age=86400';
    const ifNoneMatch = request ? request.headers.get('If-None-Match') : null;

    // 转发条件请求头，让 ASSETS 有机会直接返回 304
    const assetHeaders = new Headers();
    if (ifNoneMatch) assetHeaders.set('If-None-Match', ifNoneMatch);
    const file = await env.ASSETS.fetch(new Request(`https://assets.internal/${filename}`, { headers: assetHeaders }));

    if (file.status === 304) {
      return new Response(null, { status: 304, headers: { 'Cache-Control': cacheControl } });
    }

    if (file.status === 200) {
      const headers = new Headers(file.headers);
      // 优先沿用 ASSETS 返回的 Content-Type，仅在缺失时按扩展名兜底
      if (!headers.get('Content-Type')) {
        headers.set('Content-Type', getContentType(filename));
      }
      headers.set('Cache-Control', cacheControl);

      if (isHtml) {
        // Assets 不返回 HTML 的 ETag，这里按内容生成，浏览器可带 If-None-Match 协商
        const body = await file.arrayBuffer();
        let etag = headers.get('ETag');
        if (!etag) {
          const digest = await crypto.subtle.digest('SHA-256', body);
          etag = '"' + Array.from(new Uint8Array(digest).slice(0, 16))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('') + '"';
        }
        headers.set('ETag', etag);
        if (ifNoneMatch === etag) {
          return new Response(null, { status: 304, headers: { 'Cache-Control': cacheControl, 'ETag': etag } });
        }
        return new Response(body, { headers });
      }

      return new Response(file.body, { headers });
    }
    
    return new Response('文件未找到', { status: file.status || 404, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return new Response('服务器错误: ' + error.message, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

// 辅助函数：获取内容类型
function getContentType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = {
    'html': 'text/html; charset=utf-8',
    'css': 'text/css',
    'js': 'application/javascript',
    'mjs': 'application/javascript',
    'json': 'application/json',
    'map': 'application/json',
    'txt': 'text/plain; charset=utf-8',
    'xml': 'application/xml',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'otf': 'font/otf',
    'eot': 'application/vnd.ms-fontobject'
  };
  
  return types[ext] || 'application/octet-stream';
}

// ========== 定时任务 Cron 调度器 ==========

// 各字段取值范围：分 0-59、时 0-23、日 1-31、月 1-12、周 0-6（周日为 0）
const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

// 解析单个 cron 字段（支持 *、*/n、a-b、a-b/n、a,b,c）；非法返回 null
// 返回 [{ type: 'any' | 'range' | 'single', lo, hi?, step }]，校验与匹配共用同一解析结果
function parseCronField(field, min, max) {
  if (typeof field !== 'string' || field === '') return null;
  const parts = [];
  for (const raw of field.split(',')) {
    if (!raw) return null;
    let base = raw;
    let step = 1;
    if (raw.includes('/')) {
      const sp = raw.split('/');
      if (sp.length !== 2 || !/^\d+$/.test(sp[1]) || parseInt(sp[1]) < 1) return null;
      base = sp[0];
      step = parseInt(sp[1]);
    }
    if (base === '*') {
      parts.push({ type: 'any', step });
    } else if (base.includes('-')) {
      const r = base.split('-');
      if (r.length !== 2 || !/^\d+$/.test(r[0]) || !/^\d+$/.test(r[1])) return null;
      const lo = parseInt(r[0]);
      const hi = parseInt(r[1]);
      if (lo < min || hi > max || lo > hi) return null;
      parts.push({ type: 'range', lo, hi, step });
    } else {
      if (!/^\d+$/.test(base)) return null;
      const v = parseInt(base);
      if (v < min || v > max) return null;
      parts.push({ type: 'single', lo: v });
    }
  }
  return parts;
}

// 校验 cron 表达式格式（5 字段：分 时 日 月 周）
function isValidCron(expr) {
  if (!expr || typeof expr !== 'string') return false;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, i) => parseCronField(f, CRON_RANGES[i][0], CRON_RANGES[i][1]) !== null);
}

// 定时任务列表/创建
async function handleAdminCronList(request, env) {
  try {
    switch (request.method) {
      case 'GET': {
        const { results } = await env.DB.prepare(`
          SELECT id, name, cron_expression, task_url,
                 enabled, last_run_at, last_run_status, last_run_message,
                 created_at, updated_at
          FROM cron_jobs ORDER BY id
        `).all();
        return jsonResponse({ jobs: results });
      }
      case 'POST': {
        const { data, error } = await parseJsonBody(request);
        if (error) return jsonResponse({ error }, 400);
        if (!data.name || !data.cron_expression || !data.task_url) {
          return jsonResponse({ error: '名称、cron 表达式和任务 URL 不能为空' }, 400);
        }
        if (!isValidCron(data.cron_expression)) {
          return jsonResponse({ error: 'cron 表达式格式错误（应为 5 个字段：分 时 日 月 周）' }, 400);
        }
        const result = await env.DB.prepare(`
          INSERT INTO cron_jobs (name, cron_expression, task_url, enabled)
          VALUES (?, ?, ?, ?)
        `).bind(data.name, data.cron_expression, data.task_url, toDbBoolean(data.enabled)).run();
        return jsonResponse({ success: true, id: result.meta.last_row_id });
      }
      default:
        return methodNotAllowed();
    }
  } catch (error) {
    return serverError('定时任务操作失败', error);
  }
}

// 定时任务详情/更新/删除/手动执行
async function handleAdminCronDetail(request, env) {
  try {
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(/^\/api\/price\/admin\/cron\/(\d+)(?:\/(run))?$/);
    if (!pathMatch) return jsonResponse({ error: '路径格式错误' }, 400);

    const jobId = parseInt(pathMatch[1]);
    const isRun = pathMatch[2] === 'run';

    // 手动执行
    if (isRun && request.method === 'POST') {
      const job = await env.DB.prepare('SELECT * FROM cron_jobs WHERE id = ?').bind(jobId).first();
      if (!job) return jsonResponse({ error: '任务不存在' }, 404);
      const result = await runCronJob(env, job);
      if (result.success) {
        return jsonResponse({ success: true, message: result.message });
      }
      return jsonResponse({ error: '执行失败', details: result.message }, 500);
    }

    switch (request.method) {
      case 'GET': {
        const job = await env.DB.prepare('SELECT * FROM cron_jobs WHERE id = ?').bind(jobId).first();
        if (!job) return jsonResponse({ error: '任务不存在' }, 404);
        return jsonResponse({ job });
      }
      case 'PUT': {
        const { data, error } = await parseJsonBody(request);
        if (error) return jsonResponse({ error }, 400);
        const existing = await recordExists(env, 'cron_jobs', jobId);
        if (!existing) return jsonResponse({ error: '任务不存在' }, 404);

        if (data.cron_expression !== undefined && !isValidCron(data.cron_expression)) {
          return jsonResponse({ error: 'cron 表达式格式错误（应为 5 个字段：分 时 日 月 周）' }, 400);
        }

        const updatable = ['name', 'cron_expression', 'task_url', 'enabled'];
        const { fields, values } = buildUpdateSet(data, updatable, (key, value) => key === 'enabled' ? toDbBoolean(value) : value);
        if (fields.length === 0) return jsonResponse({ error: '没有可更新的字段' }, 400);
        values.push(jobId);
        await env.DB.prepare(`UPDATE cron_jobs SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(...values).run();
        return jsonResponse({ success: true });
      }
      case 'DELETE': {
        const existing = await recordExists(env, 'cron_jobs', jobId);
        if (!existing) return jsonResponse({ error: '任务不存在' }, 404);
        await env.DB.prepare('DELETE FROM cron_jobs WHERE id = ?').bind(jobId).run();
        return jsonResponse({ success: true });
      }
      default:
        return methodNotAllowed();
    }
  } catch (error) {
    return serverError('任务操作失败', error);
  }
}

// 批量执行定时任务：POST /api/price/admin/cron/batch-run，body { ids: [1,2,3] }
async function handleAdminCronBatchRun(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }
  try {
    const { data, error } = await parseJsonBody(request);
    if (error) return jsonResponse({ error }, 400);
    if (!Array.isArray(data.ids) || data.ids.length === 0) {
      return jsonResponse({ error: '请选择要执行的任务' }, 400);
    }
    const ids = parseIdList(data.ids);
    if (ids.length === 0) {
      return jsonResponse({ error: '任务 ID 格式错误' }, 400);
    }

    const results = [];
    for (const id of ids) {
      const job = await env.DB.prepare('SELECT * FROM cron_jobs WHERE id = ?').bind(id).first();
      if (!job) {
        results.push({ id, name: '#' + id, success: false, message: '任务不存在' });
        continue;
      }
      const result = await runCronJob(env, job);
      results.push({ id: job.id, name: job.name, success: result.success, message: result.message });
    }

    const successCount = results.filter(r => r.success).length;
    return jsonResponse({
      success: true,
      total: results.length,
      successCount,
      failedCount: results.length - successCount,
      results
    });
  } catch (e) {
    return serverError('批量执行失败', e);
  }
}

// 清理残留的运行中日志：超过阈值分钟仍未结束的标记为超时
async function cleanupStaleRunningLogs(env, thresholdMinutes = 30) {
  const modifier = '-' + thresholdMinutes + ' minutes';
  const result = await env.DB.prepare(`
    UPDATE cron_logs
    SET status = 'timeout', message = '任务中断/超时，已自动清理', finished_at = CURRENT_TIMESTAMP
    WHERE status = 'running' AND started_at < datetime('now', ?)
  `).bind(modifier).run();
  return result.meta.changes || 0;
}

// 清理残留的运行中任务：POST /api/price/admin/cron/clear-stale，body { minutes: 30 }
async function handleAdminCronClearStale(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }
  try {
    const { data } = await parseJsonBody(request);
    const minutes = (data && data.minutes) ? parseInt(data.minutes) : 30;
    if (isNaN(minutes) || minutes <= 0) {
      return jsonResponse({ error: '阈值分钟数格式错误' }, 400);
    }
    const cleared = await cleanupStaleRunningLogs(env, minutes);
    return jsonResponse({ success: true, cleared });
  } catch (e) {
    return serverError('清理失败', e);
  }
}

// 定时任务执行日志查询/批量删除
async function handleAdminCronLogs(request, env) {
  try {
    switch (request.method) {
      case 'GET': {
        const url = new URL(request.url);
        const limit = clampInt(parseInt(url.searchParams.get('limit')) || 50, 1, 100);
        const { results } = await env.DB.prepare(`
          SELECT id, job_id, job_name, status, message, started_at, finished_at
          FROM cron_logs ORDER BY id DESC LIMIT ?
        `).bind(limit).all();
        return jsonResponse({ logs: results });
      }
      case 'DELETE': {
        const { data, error } = await parseJsonBody(request);
        if (error) return jsonResponse({ error }, 400);
        const ids = data.ids;
        if (!Array.isArray(ids) || ids.length === 0) {
          return jsonResponse({ error: '请选择要删除的日志' }, 400);
        }
        const validIds = parseIdList(ids);
        if (validIds.length === 0) {
          return jsonResponse({ error: '日志 ID 格式错误' }, 400);
        }
        const result = await env.DB.prepare(`
          DELETE FROM cron_logs WHERE id IN (${placeholders(validIds)})
        `).bind(...validIds).run();
        return jsonResponse({ success: true, deleted: result.meta.changes || validIds.length });
      }
      default:
        return methodNotAllowed();
    }
  } catch (error) {
    return serverError('日志操作失败', error);
  }
}

// 心跳状态检查（检测 Cloudflare Cron Trigger 是否正常配置并运行）
async function handleAdminCronHeartbeat(env) {
  try {
    const lastHeartbeat = await getSetting('last_heartbeat_at', env);
    const isAlive = lastHeartbeat ? (Date.now() - new Date(lastHeartbeat).getTime() < 10 * 60 * 1000) : false;
    // 转为北京时间显示
    let beijingTime = null;
    if (lastHeartbeat) {
      const d = new Date(lastHeartbeat);
      beijingTime = new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
    }
    return jsonResponse({ last_heartbeat_at: lastHeartbeat, last_heartbeat_beijing: beijingTime, is_alive: isAlive });
  } catch (error) {
    return serverError('获取心跳状态失败', error);
  }
}

// 记录定时任务开始
async function logCronStart(env, jobId, jobName) {
  const result = await env.DB.prepare(`
    INSERT INTO cron_logs (job_id, job_name, status, message, started_at)
    VALUES (?, ?, 'running', '执行中...', CURRENT_TIMESTAMP)
  `).bind(jobId, jobName).run();
  return result.meta.last_row_id;
}

// 结束定时任务日志并同步任务状态：两条 UPDATE 合并为一次 batch，省一次数据库往返
function cronFinishStatements(env, logId, jobId, status, message, now) {
  return [
    env.DB.prepare(`
      UPDATE cron_logs SET status = ?, message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(status, message, logId),
    env.DB.prepare(`
      UPDATE cron_jobs SET last_run_at = ?, last_run_status = ?, last_run_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(now.toISOString(), status, message, jobId)
  ];
}

// 执行单个定时任务：记录日志、执行、更新任务状态（手动执行 / 批量执行 / 心跳调度共用）
async function runCronJob(env, job) {
  const now = new Date();
  const logId = await logCronStart(env, job.id, job.name);
  try {
    const message = await executeCronTask(job, env);
    await env.DB.batch(cronFinishStatements(env, logId, job.id, 'success', message, now));
    return { success: true, message };
  } catch (e) {
    await env.DB.batch(cronFinishStatements(env, logId, job.id, 'failed', e.message, now));
    return { success: false, message: e.message };
  }
}

// Cron 表达式匹配（5 字段：分 时 日 月 周，按北京时间解释）
// 存储与 UI 均为北京时间；Cloudflare Cron Trigger 传入的是 UTC 时间，需 +8h 转换后匹配
function matchCron(expr, date) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const values = [bj.getUTCMinutes(), bj.getUTCHours(), bj.getUTCDate(), bj.getUTCMonth() + 1, bj.getUTCDay()];
  for (let i = 0; i < 5; i++) {
    const parts = parseCronField(fields[i], CRON_RANGES[i][0], CRON_RANGES[i][1]);
    if (!parts || !matchCronField(parts, values[i])) return false;
  }
  return true;
}

// 判断已解析的 cron 字段是否命中给定值
function matchCronField(parts, value) {
  for (const p of parts) {
    if (p.type === 'any') {
      if (value % p.step === 0) return true;
    } else if (p.type === 'range') {
      if (value >= p.lo && value <= p.hi && (value - p.lo) % p.step === 0) return true;
    } else if (p.lo === value) {
      return true;
    }
  }
  return false;
}

// 内部定时任务：重算月均价（核心逻辑，返回数据对象）
async function recalcMonthlyAverages(env) {
  // 一条聚合 SQL 全量重算，再用一条 DELETE 清理已无数据的月份；
  // 原来是「产品 × 月份」双重循环，每个组合 2 条语句，月数多了会打出上百次数据库往返
  const [insertResult] = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR REPLACE INTO monthly_averages
      (product_id, year_month, avg_price, days_count, low_price, high_price, created_at, updated_at)
      SELECT
        d.product_id,
        substr(d.trade_date, 1, 7) as year_month,
        ROUND(AVG(d.avg_price), 2) as avg_price,
        COUNT(*) as days_count,
        MIN(d.low_price) as low_price,
        MAX(d.high_price) as high_price,
        COALESCE(ma.created_at, CURRENT_TIMESTAMP),
        CURRENT_TIMESTAMP
      FROM daily_prices d
      LEFT JOIN monthly_averages ma
        ON ma.product_id = d.product_id
       AND ma.year_month = substr(d.trade_date, 1, 7)
      GROUP BY d.product_id, substr(d.trade_date, 1, 7)
    `),
    env.DB.prepare(`
      DELETE FROM monthly_averages
      WHERE NOT EXISTS (
        SELECT 1 FROM daily_prices d
        WHERE d.product_id = monthly_averages.product_id
          AND substr(d.trade_date, 1, 7) = monthly_averages.year_month
      )
    `)
  ]);

  const affected = (insertResult && insertResult.meta) ? insertResult.meta.changes : 0;
  return { success: true, message: `完成：重新计算 ${affected} 条月均价` };
}

// 内部定时任务：重算月均价（HTTP 入口）
async function handleInternalRecalc(env) {
  try {
    return jsonResponse(await recalcMonthlyAverages(env));
  } catch (e) {
    return serverError('重算月均价失败', e);
  }
}

// 内部定时任务：数据完整性检查（核心逻辑，返回数据对象）
async function checkDataIntegrity(env) {
  // 获取中国时区（UTC+8）当前日期和星期
  // 通过 epoch 加 8h 后用 getUTC* 方法取得北京时间
  const chinaNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const today = chinaNow.toISOString().slice(0, 10);
  const dow = chinaNow.getUTCDay();  // 等价于北京时间星期几
  if (dow === 0 || dow === 6) return { success: true, message: '今天非工作日，跳过数据完整性检查' };

  // 产品列表与当日已有报价并行查询，避免逐个产品各打一次数据库
  const [{ results: products }, { results: existing }] = await Promise.all([
    env.DB.prepare('SELECT id, code, name FROM products WHERE is_active = 1').all(),
    env.DB.prepare('SELECT DISTINCT product_id FROM daily_prices WHERE trade_date = ?').bind(today).all()
  ]);
  const recorded = new Set((existing || []).map(r => r.product_id));
  const messages = [];
  for (const p of products) {
    if (!recorded.has(p.id)) messages.push(`${p.name}(${p.code}) 缺少 ${today} 报价`);
  }
  return { success: true, message: messages.length > 0 ? '缺失数据：\n' + messages.join('\n') : '所有产品今日数据完整' };
}

// 内部定时任务：数据完整性检查（HTTP 入口）
async function handleInternalDataCheck(env) {
  try {
    return jsonResponse(await checkDataIntegrity(env));
  } catch (e) {
    return serverError('数据完整性检查失败', e);
  }
}

// 执行具体定时任务：URL 驱动（手动执行入口，也供 scheduled 心跳调用）
async function executeCronTask(job, env) {
  const url = job.task_url || '';
  const workerUrl = env.WORKER_URL || 'https://example.com';
  // 推送任务：直接调用 executePush，避免自请求到自身 Worker 造成 522 超时
  const pushMatch = url.match(/\/api\/price\/push\/(\d+)/);
  if (pushMatch) {
    const pushId = parseInt(pushMatch[1]);
    let pushKey = null;
    try {
      pushKey = new URL(url, workerUrl).searchParams.get('key');
    } catch (e) {
      pushKey = null;
    }
    const result = await executePush(env, pushId, pushKey);
    if (result.success === false) {
      throw new Error(result.error || result.message || '推送失败');
    }
    return result.message || '推送成功';
  }
  if (url.startsWith('/api/price/admin/cron/_internal/')) {
    if (url.includes('/recalc')) {
      const result = await recalcMonthlyAverages(env);
      return result.message || result.error || '重算完成';
    }
    if (url.includes('/data-check')) {
      const result = await checkDataIntegrity(env);
      return result.message || result.error || '检查完成';
    }
    return '未知内部任务';
  }
  // 外部 URL（带超时，避免外部接口无响应时拖垮调度）
  const fullUrl = url.startsWith('http') ? url : (workerUrl + url);
  let resp;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    resp = await fetch(fullUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
  } catch (e) {
    // 请求异常/超时视为任务失败，抛出以便 runCronJob 记录 failed
    throw new Error('外部任务请求失败: ' + (e.name === 'AbortError' ? '请求超时(30s)' : e.message));
  }
  const body = await resp.text().catch(() => '');
  const message = `HTTP ${resp.status}: ${body.slice(0, 300)}`;
  if (!resp.ok) {
    // 非 2xx 同样视为任务失败
    throw new Error('外部任务请求失败: ' + message);
  }
  return message;
}

// 定时任务调度入口：由 scheduled() 调用，URL 驱动
async function handleScheduledTask(event, env) {
  // 表结构迁移不在此执行：所有写接口入口与部署后的 isolate 已完成迁移，
  // 每 5 分钟重跑只会产生必然失败的 ALTER 与 DROP TRIGGER 噪音。
  // 心跳写入与两条清理合并为一次 batch，3 次 D1 往返降为 1 次。
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO system_settings (key, value, description, updated_at)
        VALUES (?, ?, COALESCE(?, ''), CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          description = COALESCE(?, description),
          updated_at = CURRENT_TIMESTAMP
      `).bind('last_heartbeat_at', new Date().toISOString(), null, null),
      env.DB.prepare(`
        UPDATE cron_logs
        SET status = 'timeout', message = '任务中断/超时，已自动清理', finished_at = CURRENT_TIMESTAMP
        WHERE status = 'running' AND started_at < datetime('now', ?)
      `).bind('-30 minutes'),
      // 清理已过窗口期的登录限流记录，避免伪造 username|ip 组合无限残留
      env.DB.prepare('DELETE FROM login_attempts WHERE reset_at < ?')
        .bind(Date.now() - LOGIN_WINDOW_MS),
      // 日志表保留期 90 天：cron 每 5 分钟最多一条、webhook 每次采集一条，
      // 不限保留期会无限增长；后台统计只查最近 30 天，90 天足够回溯排障
      env.DB.prepare("DELETE FROM cron_logs WHERE started_at < datetime('now', '-90 days')"),
      env.DB.prepare("DELETE FROM webhook_logs WHERE created_at < datetime('now', '-90 days')")
    ]);
  } catch (e) {
    // 心跳/清理失败不影响后续任务调度
  }

  // 以 Cloudflare 传入的 scheduledTime 作为匹配基准，避免冷启动/延迟导致与心跳边界错位；
  // 无 scheduledTime 时回退到当前时间。
  const utcNow = event && event.scheduledTime ? new Date(event.scheduledTime) : new Date();
  let jobs = [];
  try {
    const result = await env.DB.prepare('SELECT * FROM cron_jobs WHERE enabled = 1').all();
    jobs = result.results || [];
  } catch (e) {
    // 查询失败不影响心跳记录
    return;
  }

  for (const job of jobs) {
    if (!matchCron(job.cron_expression, utcNow)) continue;
    await runCronJob(env, job);
  }
}

// CORS 预检请求处理
function handleOptions() {
  return new Response(null, {
    headers: Object.assign({}, CORS_HEADERS, { 'Access-Control-Max-Age': '86400' })
  });
}