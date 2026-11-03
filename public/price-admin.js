/* 报价查询系统 - 后台核心脚本 */
// 侧边栏菜单切换：只改 hash，由 hashchange 统一处理
$('.sidebar-menu a').click(function(e) {
    var target = $(this).attr('href');
    if (target.indexOf('#') !== 0) return; // 外部链接不处理
    e.preventDefault();
    if (location.hash === target) {
        // 相同 hash 不会触发 hashchange，手动刷新一次
        showSection(target);
    } else {
        location.hash = target;
    }
});

// hash 变化（含浏览器前进/后退）时切换到对应模块
$(window).on('hashchange', function() {
    var h = location.hash;
    if (h && $(h + '-section').length) {
        showSection(h);
    }
});

// 显示指定后台模块（target 为 hash，如 #cron-jobs）
function showSection(target) {
    if (!$(target + '-section').length) {
        target = '#dashboard';
    }

    $('.sidebar-menu a').removeClass('active');
    $('.sidebar-menu a[href="' + target + '"]').addClass('active');

    $('.admin-section').hide();
    $(target + '-section').show();

    if (target === '#webhook-config') {
        loadWebhookConfigs();
    }
    if (target === '#push-settings') {
        loadPushConfigs();
    }
    if (target === '#product-management') {
        loadAdminProducts();
    }
    if (target === '#manual-input') {
        populateManualProductSelect();
        // 设置手工补录日期为当天（北京时间）
        $('#manual-date').val(new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10));
    }
    if (target === '#dashboard') {
        loadStats();
        loadRecentPrices();
    }
    if (target === '#system-settings') {
        loadSettings();
        loadUsers();
    }
    if (target === '#cron-jobs') {
        loadCronJobs();
        loadCronLogs();
    }

    // 记录当前模块，刷新后据此恢复
    try {
        localStorage.setItem('admin_current_section', target);
    } catch (e) {}
}

// 计算日均价
function calculateAvg() {
    var low = $('#manual-form input[name="low_price"]').val();
    var high = $('#manual-form input[name="high_price"]').val();
    if (low && high) {
        var avg = (parseFloat(low) + parseFloat(high)) / 2;
        notify('计算出的日均价为: ' + avg.toFixed(2));
    } else {
        notify('请先填写最低价和最高价');
    }
}

// 删除记录
function deleteRecord(id) {
    confirmAndRequest('确定要删除这条记录吗？删除后无法恢复。', '/api/price/admin/records/' + id, { method: 'DELETE' }, {
        successMessage: '记录已删除',
        onSuccess: function() { loadRecentPrices(); loadStats(); }
    });
}

// 全选/取消全选最近报价记录
function toggleSelectAllRecords() {
    toggleSelectAll('#price-history-section tbody .record-checkbox', $('#select-all-records').prop('checked'), updateBatchDeleteButtonState);
}

// 更新批量删除按钮状态
function updateBatchDeleteButtonState() {
    updateBatchDeleteButton('#batch-delete-btn', '#price-history-section tbody .record-checkbox');
}

// 批量删除报价记录
function batchDeleteRecords() {
    var selectedIds = collectCheckedValues('#price-history-section tbody .record-checkbox', false);

    if (selectedIds.length === 0) {
        notify('请先选择要删除的记录');
        return;
    }

    confirmAndRequest(`确定要删除选中的 ${selectedIds.length} 条记录吗？此操作不可恢复。`, '/api/price/admin/records/batch', {
        method: 'DELETE',
        body: JSON.stringify({ ids: selectedIds })
    }, {
        errorPrefix: '批量删除失败',
        onSuccess: function(data) {
            notify(`成功删除 ${data.deleted || selectedIds.length} 条记录`);
            $('#select-all-records').prop('checked', false);
            loadRecentPrices();
            loadStats();
        }
    });
}

// 监听记录复选框变化
$(document).on('change', '#price-history-section .record-checkbox', function() {
    updateBatchDeleteButtonState();
    if (!$(this).prop('checked')) {
        $('#select-all-records').prop('checked', false);
    }
});

// 通用关闭模态框
function closeModal(id) {
    $('#' + id).removeClass('active');
}

// 通用打开模态框
function openModal(id) {
    $('#' + id).addClass('active');
}

// 当前确认弹窗的回调函数
var confirmCallback = null;

// 打开确认弹窗（options: { title, okText }）
function openConfirmModal(message, onConfirm, options) {
    options = options || {};
    $('#confirm-message').text(message);
    $('#confirm-title').text(options.title || '确认删除');
    $('#confirm-ok-btn').text(options.okText || '确定删除');
    confirmCallback = onConfirm;
    openModal('confirmModal');
}

// 确认后发送请求，并统一处理成功提示、失败提示与网络异常
// options: { title, okText, successMessage, onSuccess, errorPrefix }
function confirmAndRequest(message, url, init, options) {
    options = options || {};
    var errorPrefix = options.errorPrefix || '删除失败';
    openConfirmModal(message, function() {
        apiFetch(url, init)
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    if (options.successMessage) notify(options.successMessage);
                    if (options.onSuccess) options.onSuccess(data);
                } else {
                    notify(errorPrefix + '：' + (data.error || '未知错误'));
                }
            })
            .catch(error => {
                console.error(errorPrefix + ':', error);
                notify(errorPrefix + '，请检查网络连接');
            });
    }, options);
}

// 提交 JSON 请求并统一处理成功提示、失败提示与网络异常
// options: { method, successMessage, closeModalId, onSuccess, errorPrefix }
function submitJson(url, payload, options) {
    options = options || {};
    var errorPrefix = options.errorPrefix || '保存失败';
    apiFetch(url, {
        method: options.method || 'POST',
        body: JSON.stringify(payload)
    })
    .then(response => response.json().then(data => ({ ok: response.ok, data: data })))
    .then(result => {
        if (result.ok && result.data.success) {
            notify(options.successMessage || '保存成功');
            if (options.closeModalId) closeModal(options.closeModalId);
            if (options.onSuccess) options.onSuccess(result.data);
        } else {
            notify(errorPrefix + '：' + (result.data.error || '未知错误'));
        }
    })
    .catch(error => {
        console.error(errorPrefix + ':', error);
        notify(errorPrefix + '，请检查网络连接');
    });
}

// 关闭确认弹窗
function closeConfirmModal() {
    closeModal('confirmModal');
    confirmCallback = null;
}

// 执行确认回调
function executeConfirmCallback() {
    var callback = confirmCallback;
    closeConfirmModal();
    if (typeof callback === 'function') {
        callback();
    }
}

// 表格单元格单行截断样式（长文本配合 title 提示）
var TRUNC_CELL_STYLE = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

// 渲染表格占位行（加载失败/空态统一格式，target 可为选择器或 jQuery 对象）
// message 统一在此转义，调用方直接传纯文本即可
function renderTablePlaceholder(target, colspan, message) {
    $(target).html('<tr><td colspan="' + colspan + '" class="text-center text-muted">' + escapeHtml(message) + '</td></tr>');
}

// 统一列表加载：成功时交由 render(data) 渲染，业务失败/网络异常时渲染占位行
// options: { url, dataKey, render, target, colspan, errorLabel, failMessage, networkMessage }
// failMessage/networkMessage 支持字符串或 (arg) => string，缺省为业务错误/网络错误文案
function loadList(options) {
    apiFetch(options.url)
    .then(response => response.json())
    .then(data => {
        if (data[options.dataKey]) {
            options.render(data);
            return;
        }
        var failMessage = options.failMessage || (d => '加载失败：' + (d.error || '未知错误'));
        renderTablePlaceholder(options.target, options.colspan,
            typeof failMessage === 'function' ? failMessage(data) : failMessage);
    })
    .catch(error => {
        console.error(options.errorLabel || '加载失败:', error);
        var networkMessage = options.networkMessage || '加载失败，请检查网络连接';
        renderTablePlaceholder(options.target, options.colspan,
            typeof networkMessage === 'function' ? networkMessage(error) : networkMessage);
    });
}

// 渲染启用状态徽章（onText/offText 默认「启用/禁用」）
function renderStatusBadge(enabled, onText, offText) {
    return enabled
        ? '<span class="status-badge status-success">' + (onText || '启用') + '</span>'
        : '<span class="status-badge status-warning">' + (offText || '禁用') + '</span>';
}

// 收集复选框选中值（asInt 为 true 时转为整数）
function collectCheckedValues(selector, asInt) {
    return $(selector + ':checked').map(function() {
        return asInt ? parseInt(this.value) : $(this).val();
    }).get();
}

// 读取复选框选中状态，返回可直接提交给 API 的布尔值（1/0）
function checkedBit(selector) {
    return $(selector).is(':checked') ? 1 : 0;
}

// 全选/取消全选：将 itemSelector 命中的复选框同步为 checked，可选刷新按钮状态
function toggleSelectAll(itemSelector, checked, refresh) {
    $(itemSelector).prop('checked', checked);
    if (refresh) refresh();
}

// 批量删除按钮状态：按 itemSelector 选中数量控制 btnSelector 禁用态，可选按数量刷新文案
function updateBatchDeleteButton(btnSelector, itemSelector, labelFn) {
    var count = $(itemSelector + ':checked').length;
    var $btn = $(btnSelector).prop('disabled', count === 0);
    if (labelFn) $btn.text(labelFn(count));
}

// HTML 转义与轻提示（toast）见 shared.js

// 显示执行结果弹窗（results: [{ name, success, message }]）
function showResultModal(title, results) {
    $('#result-modal-title').text(title);
    var html = '';
    results.forEach(function(r) {
        var icon = r.success
            ? '<i class="fa fa-check-circle" style="color: #27ae60;"></i>'
            : '<i class="fa fa-times-circle" style="color: #e74c3c;"></i>';
        html += '<div style="padding: 10px 0; border-bottom: 1px solid #eee;">'
            + '<div style="display: flex; align-items: center; gap: 8px;">' + icon + '<strong>' + escapeHtml(r.name) + '</strong></div>'
            + '<div style="margin-top: 4px; font-size: 13px; color: #666; white-space: pre-wrap; word-break: break-all;">' + escapeHtml(r.message || '') + '</div>'
            + '</div>';
    });
    if (!html) html = '<div class="text-center text-muted">无结果</div>';
    $('#result-list').html(html);
    openModal('resultModal');
}

// 保存编辑
function saveEdit() {
    var id = $('#edit-form input[name="id"]').val();
    if (!id) {
        notify('记录 ID 无效，请重新打开编辑窗口');
        return;
    }
    // 涨跌值：留空或非数字时传 null，由后端按上一交易日自动计算
    var changeRaw = $('#edit-form input[name="change"]').val();
    var changeValue = (changeRaw === '' || changeRaw === null || changeRaw === undefined || isNaN(parseFloat(changeRaw)))
        ? null
        : parseFloat(changeRaw);

    var formData = {
        product_code: $('#edit-form select[name="product_code"]').val(),
        low_price: parseFloat($('#edit-form input[name="low_price"]').val()),
        high_price: parseFloat($('#edit-form input[name="high_price"]').val()),
        avg_price: parseFloat($('#edit-form input[name="avg_price"]').val()),
        change_value: changeValue,
        remark: $('#edit-form textarea[name="remark"]').val()
    };

    submitJson('/api/price/admin/records/' + id, formData, {
        method: 'PUT',
        successMessage: '更改已保存！',
        closeModalId: 'editModal',
        onSuccess: function() { loadRecentPrices(); loadStats(); }
    });
}

// 页面加载时检查登录状态
$(document).ready(function() {
    checkLogin();

    // 登录表单提交（回车键等场景兜底）
    $('#login-form').submit(function(e) {
        e.preventDefault();
        e.stopPropagation();
        login();
        return false;
    });

    // 输入框回车直接登录
    $('#login-form input').keypress(function(e) {
        if (e.which === 13) {
            e.preventDefault();
            login();
            return false;
        }
    });

    // 用户管理按钮事件委托
    $('#users-table tbody').on('click', '.edit-btn', function() {
        var userId = $(this).data('user-id');
        var username = $(this).data('username');
        openUserModal(userId, username);
    });

    $('#users-table tbody').on('click', '.delete-btn', function() {
        var userId = $(this).data('user-id');
        var username = $(this).data('username');
        deleteUser(userId, username);
    });

    // 产品类型按钮事件委托
    $('#products-table tbody').on('click', '.edit-btn', function() {
        var productId = $(this).data('product-id');
        openProductModal(productId);
    });

    $('#products-table tbody').on('click', '.delete-btn', function() {
        var productId = $(this).data('product-id');
        var productName = $(this).data('product-name');
        deleteProduct(productId, productName);
    });

    $('#products-table tbody').on('click', '.set-homepage-btn', function() {
        var productCode = $(this).data('product-code');
        var productName = $(this).data('product-name');
        setHomepageProduct(productCode, productName);
    });

    // 定时任务按钮事件委托（使用 data-* 属性替代内联 onclick，防御 XSS）
    $('#cron-jobs-table tbody').on('click', '.cron-run-btn', function() {
        var id = $(this).data('job-id');
        runCronJob(id);
    });
    $('#cron-jobs-table tbody').on('click', '.cron-edit-btn', function() {
        var id = $(this).data('job-id');
        openCronModal(id);
    });
    $('#cron-jobs-table tbody').on('click', '.cron-delete-btn', function() {
        var id = $(this).data('job-id');
        var name = $(this).data('job-name');
        deleteCronJob(id, name);
    });

    // 定时任务全选/取消全选
    $('#cron-select-all').on('change', function() {
        toggleSelectAll('.cron-row-check', this.checked);
    });
});

// 解析 JWT 格式 token（payloadB64.signature）
function parseToken(token) {
    if (!token) return null;
    var parts = token.split('.');
    if (parts.length !== 2) return null;
    try {
        var payloadB64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
        var padLen = (4 - (payloadB64.length % 4)) % 4;
        payloadB64 += new Array(padLen + 1).join('=');
        return JSON.parse(atob(payloadB64));
    } catch (e) {
        return null;
    }
}

// 检查登录状态
function checkLogin() {
    $('#setupOverlay').hide();
    $('#loginOverlay').hide();
    var token = getAdminToken();
    if (token) {
        var payload = parseToken(token);
        if (payload && payload.exp && payload.exp > Math.floor(Date.now() / 1000)) {
            showAdminApp(payload.username || 'admin');
            return;
        }
        localStorage.removeItem('admin_token');
    }
    showLogin();
}

// 显示首次初始化界面
function showSetup() {
    $('#loginOverlay').hide();
    $('#setupOverlay').css('display', 'flex');
    $('#adminSidebar').hide();
    $('#adminApp').hide();
}

// 首次创建管理员
function initSetup() {
    var username = $('#setup-form input[name="username"]').val().trim();
    var password = $('#setup-form input[name="password"]').val();
    var confirm = $('#setup-form input[name="confirm"]').val();

    if (!username || !password) {
        $('#setupError').text('请填写用户名和密码').show();
        return;
    }
    if (password !== confirm) {
        $('#setupError').text('两次密码不一致').show();
        return;
    }
    if (password.length < 8) {
        $('#setupError').text('密码长度不能少于 8 位').show();
        return;
    }
    var $btn = $('#setupBtn');
    if ($btn.prop('disabled')) return;
    $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> 创建中...');
    $('#setupError').hide();

    fetch('/api/price/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
    })
    .then(function(response) {
        return response.json().then(function(data) {
            return { ok: response.ok, status: response.status, data: data };
        });
    })
    .then(function(result) {
        $btn.prop('disabled', false).html('<i class="fa fa-check"></i> 创建管理员');
        if (result.ok && result.data.success) {
            notify('管理员「' + (result.data.user ? result.data.user.username : username) + '」创建成功！请登录。');
            $('#setupOverlay').hide();
            showLogin();
        } else {
            $('#setupError').text(result.data.error || '创建失败').show();
        }
    })
    .catch(function(error) {
        $btn.prop('disabled', false).html('<i class="fa fa-check"></i> 创建管理员');
        $('#setupError').text('网络错误：' + error.message).show();
    });
}

// 检查管理员是否已存在（探测 setup 接口，发送不完整请求体避免误创建账号）
function checkAdminExists() {
    return fetch('/api/price/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    })
    .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
    .then(function(result) {
        // 403: 管理员已存在；400: 缺少字段 → 管理员不存在
        return result.status === 403;
    })
    .catch(function() { return false; });
}

// 显示登录界面
function showLogin() {
    $('#setupOverlay').hide();
    $('#loginOverlay').css('display', 'flex');
    $('#adminSidebar').hide();
    $('#adminApp').hide();

    // 检测管理员是否已存在，存在则隐藏"首次部署"链接
    checkAdminExists().then(function(exists) {
        $('#setup-link-wrap').toggle(!exists);
    });
}

// 显示后台主界面
function showAdminApp(username) {
    $('#setupOverlay').hide();
    $('#loginOverlay').hide();
    $('#adminSidebar').show();
    $('#adminApp').show();
    $('#sidebar-username').text(username);
    $('#header-username').text(username);

    // 预加载产品数据（供手工补录/产品管理/Webhook 下拉使用）
    loadAdminProducts();

    // 恢复上次所在页面：优先 localStorage，其次 URL hash，最后默认数据看板
    var saved = null;
    try { saved = localStorage.getItem('admin_current_section'); } catch (e) {}
    var initialHash = (saved && $(saved + '-section').length) ? saved : location.hash;
    if (initialHash && $(initialHash + '-section').length) {
        showSection(initialHash);
    } else {
        showSection('#dashboard');
    }
}

// 登录
function login() {
    var username = $('#login-form input[name="username"]').val().trim();
    var password = $('#login-form input[name="password"]').val();
    var $btn = $('#loginBtn');

    if (!username || !password) {
        $('#loginError').text('请输入用户名和密码').show();
        return;
    }

    // 防止重复提交
    if ($btn.prop('disabled')) return;
    $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> 登录中...');
    $('#loginError').hide();

    fetch('/api/price/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
    })
    .then(function(response) {
        return response.json().then(function(data) {
            return { ok: response.ok, status: response.status, data: data };
        });
    })
    .then(function(result) {
        $btn.prop('disabled', false).html('<i class="fa fa-sign-in"></i> 登录');
        if (result.ok && result.data.success && result.data.token) {
            localStorage.setItem('admin_token', result.data.token);
            $('#loginError').hide();
            showAdminApp(result.data.user ? result.data.user.username : username);
        } else {
            $('#loginError').text(result.data.error || ('登录失败 (HTTP ' + result.status + ')')).show();
        }
    })
    .catch(function(error) {
        $btn.prop('disabled', false).html('<i class="fa fa-sign-in"></i> 登录');
        console.error('登录失败:', error);
        $('#loginError').text('登录失败，请检查网络连接：' + error.message).show();
    });
}

// 退出登录
function logout() {
    openConfirmModal('确定要退出登录吗？', function() {
        localStorage.removeItem('admin_token');
        showLogin();
        $('#login-form')[0].reset();
    }, { title: '确认退出', okText: '退出登录' });
}

// 加载后台统计数据
function loadStats() {
    apiFetch('/api/price/admin/stats')
    .then(response => response.json())
    .then(data => {
        if (data.total_records !== undefined) {
            $('#stat-total').text(formatNumber(data.total_records));
            $('#stat-monthly').text(formatNumber(data.monthly_updates));
            $('#stat-success').text(data.success_rate != null ? data.success_rate + '%' : '-');

            if (data.last_update) {
                var parts = data.last_update.split(' ');
                $('#stat-last-date').text(parts[0] || '-');
                $('#stat-last-time').text(parts[1] ? parts[1].substring(0, 5) : '-');
            } else {
                $('#stat-last-date').text('-');
                $('#stat-last-time').text('-');
            }
        }
    })
    .catch(error => {
        console.error('加载统计数据失败:', error);
    });
}

// 最近报价记录分页状态
var currentPage = 1;
var pageSize = 20;
var totalPages = 1;
var totalRecords = 0;

// 加载最近报价数据
function loadRecentPrices(page, size) {
    currentPage = page || currentPage;
    pageSize = size || pageSize;

    loadList({
        url: '/api/price/admin/recent?page=' + currentPage + '&pageSize=' + pageSize,
        dataKey: 'records',
        render: data => updateRecentPricesTable(data.records, data.pagination),
        target: '#price-history-section tbody',
        colspan: 10,
        errorLabel: '加载最近记录失败'
    });
}

// 更新最近报价表格
function updateRecentPricesTable(data, pagination) {
    var tbody = $('#price-history-section tbody');
    tbody.empty();
    $('#select-all-records').prop('checked', false);
    updateBatchDeleteButtonState();
    
    if (!data || data.length === 0) {
        renderTablePlaceholder(tbody, 10, '暂无报价数据');
        renderPagination(pagination || { page: 1, pageSize: 20, total: 0, totalPages: 1 });
        // 当前页删除后为空且不是第一页时，自动回到上一页
        if (currentPage > 1 && totalPages > 0 && currentPage > totalPages) {
            loadRecentPrices(totalPages);
        }
        return;
    }
    
    data.forEach(item => {
        var cv = parseFloat(item.change_value);
        var changeNum = isNaN(cv) ? 0 : cv;
        var changeClass = changeNum > 0 ? 'change up' : 
                         changeNum < 0 ? 'change down' : 'change neutral';
        var changeSign = changeNum > 0 ? '+' + formatNumber(changeNum) : 
                        changeNum < 0 ? formatNumber(changeNum) : '0';
        var changeArrow = changeNum > 0 ? '↑' : 
                         changeNum < 0 ? '↓' : '→';
        
        var sourceBadge;
        var sourceText;
        if (item.source === 'api') {
            sourceBadge = '<span class="status-badge status-success">API自动</span>';
            sourceText = 'API自动';
        } else if (item.source === 'webhook') {
            sourceBadge = '<span class="status-badge status-info">Webhook</span>';
            sourceText = 'Webhook';
        } else if (item.source === 'manual') {
            sourceBadge = '<span class="status-badge status-warning">手工补录</span>';
            sourceText = '手工补录';
        } else {
            sourceBadge = '<span class="status-badge status-default">' + escapeHtml(item.source || '未知') + '</span>';
            sourceText = item.source || '未知';
        }
        
        var collectDate = item.collect_date || '-';
        
        var row = `
            <tr>
                <td style="text-align: center;"><input type="checkbox" class="record-checkbox" value="${item.id}"></td>
                <td title="${escapeHtml(item.trade_date)}">${escapeHtml(item.trade_date)}</td>
                <td title="${escapeHtml(collectDate)}">${escapeHtml(collectDate)}</td>
                <td title="${escapeHtml(item.product_name)}"><strong>${escapeHtml(item.product_name)}</strong></td>
                <td title="${formatNumber(item.low_price)} - ${formatNumber(item.high_price)}">${formatNumber(item.low_price)} - ${formatNumber(item.high_price)}</td>
                <td title="${formatNumber(item.avg_price)}">${formatNumber(item.avg_price)}</td>
                <td title="${changeSign} ${changeArrow}"><span class="${changeClass}">${changeSign} ${changeArrow}</span></td>
                <td title="${item.monthly_avg != null ? formatNumber(item.monthly_avg) : '-'}">${item.monthly_avg != null ? formatNumber(item.monthly_avg) : '-'}</td>
                <td title="${escapeHtml(sourceText)}">${sourceBadge}</td>
                <td class="cell-wrap">
                    <div class="action-buttons">
                        <button class="action-btn edit-btn" onclick="editRecord(${item.id})">编辑</button>
                        <button class="action-btn delete-btn" onclick="deleteRecord(${item.id})">删除</button>
                    </div>
                </td>
            </tr>
        `;
        tbody.append(row);
    });
    
    renderPagination(pagination || { page: 1, pageSize: 20, total: 0, totalPages: 1 });
}

// 渲染分页控件
function renderPagination(pagination) {
    currentPage = pagination.page;
    pageSize = pagination.pageSize;
    totalRecords = pagination.total;
    totalPages = pagination.totalPages;
    
    $('#pagination-total').text(formatNumber(totalRecords));
    $('#pagination-page').text(currentPage);
    $('#pagination-total-pages').text(totalPages);
    
    $('#page-first').prop('disabled', currentPage <= 1);
    $('#page-prev').prop('disabled', currentPage <= 1);
    $('#page-next').prop('disabled', currentPage >= totalPages);
    $('#page-last').prop('disabled', currentPage >= totalPages);
    
    var pagesHtml = '';
    var maxVisible = 5;
    var startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    var endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage + 1 < maxVisible) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }
    
    for (var i = startPage; i <= endPage; i++) {
        var activeClass = i === currentPage ? 'btn-primary' : 'btn-default';
        pagesHtml += '<button type="button" class="btn btn-sm ' + activeClass + '" onclick="changePage(' + i + ')">' + i + '</button>';
    }
    $('#pagination-pages').html(pagesHtml);
    
    $('#page-size').val(pageSize);
}

// 切换页码
function changePage(page) {
    if (page < 1 || page > totalPages || page === currentPage) {
        return;
    }
    loadRecentPrices(page);
}

// 切换每页条数
function changePageSize() {
    var newSize = parseInt($('#page-size').val());
    if (isNaN(newSize) || newSize < 1) {
        return;
    }
    loadRecentPrices(1, newSize);
}

// 格式化数字（添加千位分隔符）
function formatNumber(num) {
    if (num === null || num === undefined) return '0';
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 导出当前页数据为 CSV，格式：日期,产品,价格区间,日均价,涨/跌,月均价,来源
function exportToCSV() {
    var rows = [];
    rows.push('数据日期,录入时间,产品,价格区间,日均价,涨/跌,月均价,来源');

    $('#recent-records-table tbody tr').each(function() {
        var tds = this.querySelectorAll('td');
        if (tds.length < 10) return; // 跳过提示/加载行（colspan 合并行）

        // 跳过全选框(0)、操作(9)，取数据列 1-8（含来源）
        var cols = [];
        for (var i = 1; i <= 8; i++) {
            var text = tds[i].textContent.trim();
            if (text === '-') text = '';
            // CSV 标准转义：引号包裹，内部引号双写
            cols.push('"' + text.replace(/"/g, '""') + '"');
        }
        rows.push(cols.join(','));
    });

    var bom = '\uFEFF';
    var csv = bom + rows.join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = '报价记录_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// Webhook 配置管理
function getAdminToken() {
    return localStorage.getItem('admin_token') || '';
}

function getApiHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var token = getAdminToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
}

// API 请求封装：自动注入 token、10 秒超时、401 自动跳转登录
function apiFetch(url, options) {
    options = options || {};
    options.headers = options.headers || getApiHeaders();
    // 超时控制
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 10000);
    options.signal = controller.signal;
    return fetch(url, options)
        .then(function(response) {
            if (response.status === 401) {
                localStorage.removeItem('admin_token');
                showLogin();
                throw new Error('登录已过期，请重新登录');
            }
            return response;
        })
        .catch(function(error) {
            if (error.name === 'AbortError') {
                throw new Error('请求超时，请检查网络连接');
            }
            throw error;
        })
        .finally(function() { clearTimeout(timeout); });
}

function loadWebhookConfigs() {
    // 绑定产品下拉由 loadAdminProducts 统一填充（应用启动时已预加载），此处无需重复调用

    loadList({
        url: '/api/price/webhooks',
        dataKey: 'configs',
        render: data => renderWebhookTable(data.configs),
        target: '#webhook-table tbody',
        colspan: 8,
        errorLabel: '加载 Webhook 配置失败'
    });
}

function renderWebhookTable(configs) {
    var tbody = $('#webhook-table tbody');
    tbody.empty();
    
    if (!configs || configs.length === 0) {
        renderTablePlaceholder(tbody, 8, '暂无 Webhook 配置');
        return;
    }
    
    var cellStyle = TRUNC_CELL_STYLE;
    configs.forEach(config => {
        var webhookUrl = window.location.origin + '/api/price/webhook/' + config.id;
        var authDesc = config.auth_type === 'header' ? 'Header: ' + config.auth_header_name :
                       config.auth_type === 'query' ? 'Query: ' + config.auth_header_name : '不验证';
        var mapping = `产品:${config.product_code_field} 数据日期:${config.trade_date_field} 采集日期:${config.collect_date_field || 'collect_date'} 最低价:${config.low_price_field} 最高价:${config.high_price_field}`;
        var statusBadge = renderStatusBadge(config.enabled);
        var productName = config.target_product_code || '按推送数据';
        
        var row = `
            <tr>
                <td>${escapeHtml(String(config.id))}</td>
                <td title="${escapeHtml(config.name)}" style="${cellStyle} max-width: 120px;">${escapeHtml(config.name)}</td>
                <td title="${escapeHtml(authDesc)}" style="${cellStyle} max-width: 140px;">${escapeHtml(authDesc)}</td>
                <td title="${escapeHtml(mapping)}" style="${cellStyle} max-width: 280px;">${escapeHtml(mapping)}</td>
                <td title="${escapeHtml(productName)}" style="${cellStyle} max-width: 100px;">${escapeHtml(productName)}</td>
                <td>${statusBadge}</td>
                <td title="${webhookUrl}" style="${cellStyle} max-width: 220px;"><code style="font-size: 11px;">${webhookUrl}</code></td>
                <td class="cell-wrap">
                    <div class="action-buttons">
                        <button class="action-btn edit-btn" onclick="openWebhookModal(${config.id})">编辑</button>
                        <button class="action-btn delete-btn" onclick="deleteWebhookConfig(${config.id})">删除</button>
                    </div>
                </td>
            </tr>
        `;
        tbody.append(row);
    });
}

function openWebhookModal(id) {
    $('#webhook-form')[0].reset();
    $('#webhook-id').val('');
    $('#webhook-modal-title').text('新增 Webhook 配置');
    
    if (id) {
        $('#webhook-modal-title').text('编辑 Webhook 配置');
        apiFetch('/api/price/webhooks/' + id)
        .then(response => response.json())
        .then(data => {
            if (data.config) {
                var config = data.config;
                $('#webhook-id').val(config.id);
                $('#webhook-form input[name="name"]').val(config.name);
                $('#webhook-form input[name="webhook_key"]').val(config.webhook_key);
                $('#webhook-form select[name="auth_type"]').val(config.auth_type);
                $('#webhook-form input[name="auth_header_name"]').val(config.auth_header_name);
                $('#webhook-form input[name="product_code_field"]').val(config.product_code_field);
                $('#webhook-form input[name="trade_date_field"]').val(config.trade_date_field);
                $('#webhook-form input[name="collect_date_field"]').val(config.collect_date_field || 'collect_date');
                $('#webhook-form input[name="low_price_field"]').val(config.low_price_field);
                $('#webhook-form input[name="high_price_field"]').val(config.high_price_field);
                $('#webhook-form input[name="avg_price_field"]').val(config.avg_price_field);
                $('#webhook-form input[name="change_value_field"]').val(config.change_value_field);
                $('#webhook-form input[name="data_array_field"]').val(config.data_array_field || '');
                $('#webhook-form select[name="target_product_code"]').val(config.target_product_code || '');
                $('#webhook-form input[name="enabled"]').prop('checked', config.enabled == 1);
            } else {
                notify('获取配置失败');
            }
        })
        .catch(error => {
            console.error('获取配置失败:', error);
            notify('获取配置失败');
        });
    }
    
    openModal('webhookModal');
}

function saveWebhookConfig() {
    var id = $('#webhook-id').val();
    var formData = {
        name: $('#webhook-form input[name="name"]').val(),
        webhook_key: $('#webhook-form input[name="webhook_key"]').val(),
        auth_type: $('#webhook-form select[name="auth_type"]').val(),
        auth_header_name: $('#webhook-form input[name="auth_header_name"]').val(),
        product_code_field: $('#webhook-form input[name="product_code_field"]').val() || 'product_code',
        trade_date_field: $('#webhook-form input[name="trade_date_field"]').val() || 'trade_date',
        collect_date_field: $('#webhook-form input[name="collect_date_field"]').val() || 'collect_date',
        low_price_field: $('#webhook-form input[name="low_price_field"]').val() || 'low_price',
        high_price_field: $('#webhook-form input[name="high_price_field"]').val() || 'high_price',
        avg_price_field: $('#webhook-form input[name="avg_price_field"]').val() || 'avg_price',
        change_value_field: $('#webhook-form input[name="change_value_field"]').val() || 'change_value',
        data_array_field: $('#webhook-form input[name="data_array_field"]').val() || null,
        target_product_code: $('#webhook-form select[name="target_product_code"]').val() || null,
        enabled: checkedBit('#webhook-form input[name="enabled"]')
    };
    
    submitJson(id ? '/api/price/webhooks/' + id : '/api/price/webhooks', formData, {
        method: id ? 'PUT' : 'POST',
        successMessage: '配置保存成功',
        closeModalId: 'webhookModal',
        onSuccess: function() { loadWebhookConfigs(); }
    });
}

function deleteWebhookConfig(id) {
    confirmAndRequest('确定要删除该 Webhook 配置吗？', '/api/price/webhooks/' + id, { method: 'DELETE' }, {
        successMessage: '配置已删除',
        onSuccess: function() { loadWebhookConfigs(); }
    });
}

// ==================== 推送设置管理 ====================

var PUSH_DEFAULT_TEMPLATE = '**{产品}** 最新报价\n日期：{日期}\n日均价：{均价} {单位}\n涨跌：{涨跌}';

function loadPushConfigs() {
    // 产品缓存为空时先加载产品，保证绑定产品下拉框有数据
    var ensureProducts = adminProductsCache.length === 0
        ? apiFetch('/api/price/admin/products').then(r => r.json()).then(data => {
              if (data.products) adminProductsCache = data.products;
          }).catch(() => {})
        : Promise.resolve();
    ensureProducts.then(() => populatePushProductSelect());

    loadList({
        url: '/api/price/admin/push',
        dataKey: 'configs',
        render: data => renderPushTable(data.configs),
        target: '#push-table tbody',
        colspan: 8,
        errorLabel: '加载推送配置失败'
    });
}

// 解析推送配置绑定的产品 ID 列表（product_ids JSON 优先，兼容旧单产品字段）
function parsePushProductIds(config) {
    var ids = [];
    try { ids = JSON.parse(config.product_ids || '[]'); } catch (e) { ids = []; }
    if (ids.length === 0 && config.product_id) ids = [config.product_id];
    return ids;
}

// 解析配置的产品名称列表
function resolvePushProductNames(config) {
    var ids = parsePushProductIds(config);
    if (ids.length === 0) return '-';
    if (adminProductsCache.length > 0) {
        return ids.map(id => {
            var p = adminProductsCache.find(x => String(x.id) === String(id));
            return p ? p.name : ('#' + id);
        }).join('、');
    }
    return config.product_name || ('#' + ids[0]);
}

function renderPushTable(configs) {
    var tbody = $('#push-table tbody');
    tbody.empty();

    if (!configs || configs.length === 0) {
        renderTablePlaceholder(tbody, 8, '暂无推送配置');
        return;
    }

    var cellStyle = TRUNC_CELL_STYLE;
    configs.forEach(config => {
        var msgTypeText = config.msg_type === 'text' ? '纯文本' : (config.msg_type === 'card' ? '模版卡片' : 'Markdown');
        var pushUrl = window.location.origin + '/api/price/push/' + config.id + '?key=' + encodeURIComponent(config.push_key);
        var statusBadge = renderStatusBadge(config.enabled);
        var lastPush = '-';
        if (config.last_push_at) {
            lastPush = toBeijingTime(config.last_push_at) + (config.last_push_status === 'success' ? '（成功）' : '（失败）');
        }
        var productNames = resolvePushProductNames(config);

        var row = `
            <tr>
                <td>${escapeHtml(String(config.id))}</td>
                <td title="${escapeHtml(config.name)}" style="${cellStyle} max-width: 120px;">${escapeHtml(config.name)}</td>
                <td title="${escapeHtml(productNames)}" style="${cellStyle} max-width: 150px;">${escapeHtml(productNames)}</td>
                <td>${msgTypeText}</td>
                <td>${statusBadge}</td>
                <td title="${escapeHtml(pushUrl)}" style="${cellStyle} max-width: 260px;"><code style="font-size: 11px;">${escapeHtml(pushUrl)}</code></td>
                <td style="font-size: 12px;">${escapeHtml(lastPush)}</td>
                <td class="cell-wrap">
                    <div class="action-buttons">
                        <button class="action-btn edit-btn" onclick="openPushModal(${config.id})">编辑</button>
                        <button class="action-btn" onclick="testPushConfig(${config.id})" style="color: #27ae60;">测试</button>
                        <button class="action-btn delete-btn" onclick="deletePushConfig(${config.id})">删除</button>
                    </div>
                </td>
            </tr>
        `;
        tbody.append(row);
    });
}

// 生成 24 位随机密钥并填入目标输入框（默认推送配置的密钥框，供两个模态框复用）
function generatePushKey(targetId) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    var key = '';
    for (var i = 0; i < arr.length; i++) key += chars[arr[i] % chars.length];
    $('#' + (targetId || 'push-key')).val(key);
}

// 模版卡片类型由系统自动生成内容，隐藏模板编辑区
function togglePushTemplateState() {
    var isCard = $('#push-msg-type').val() === 'card';
    $('#push-template-group').toggle(!isCard);
    $('#push-card-hint').toggle(isCard);
}

function populatePushProductSelect() {
    var select = $('#push-product-select');
    select.empty();

    var activeProducts = adminProductsCache.filter(p => p.is_active);
    activeProducts.forEach(product => {
        select.append(`<option value="${product.id}">${escapeHtml(product.name)}</option>`);
    });
}

function openPushModal(id) {
    $('#push-form')[0].reset();
    $('#push-id').val('');
    $('#push-modal-title').text('新增推送配置');
    populatePushProductSelect();
    // 新增时默认纯文本
    $('#push-msg-type').val('text');
    togglePushTemplateState();

    if (id) {
        $('#push-modal-title').text('编辑推送配置');
        apiFetch('/api/price/admin/push/' + id)
        .then(response => response.json())
        .then(data => {
            if (data.config) {
                var c = data.config;
                $('#push-id').val(c.id);
                $('#push-name').val(c.name);
                // 恢复多选产品（兼容旧单产品字段）
                var productIds = parsePushProductIds(c);
                $('#push-product-select option').each(function() {
                    $(this).prop('selected', productIds.includes(parseInt($(this).val())));
                });
                $('#push-webhook-url').val(c.webhook_url);
                $('#push-key').val(c.push_key);
                $('#push-msg-type').val(c.msg_type || 'text');
                $('#push-template').val(c.template || PUSH_DEFAULT_TEMPLATE);
                $('#push-enabled').prop('checked', c.enabled == 1);
                togglePushTemplateState();
            } else {
                notify('获取推送配置失败');
            }
        })
        .catch(error => {
            console.error('获取推送配置失败:', error);
            notify('获取推送配置失败');
        });
    } else {
        generatePushKey();
        $('#push-template').val(PUSH_DEFAULT_TEMPLATE);
        togglePushTemplateState();
    }

    openModal('pushModal');
}

function savePushConfig() {
    var id = $('#push-id').val();
    var productIds = ($('#push-product-select').val() || []).map(v => parseInt(v)).filter(v => v);
    var formData = {
        name: $('#push-name').val(),
        webhook_url: $('#push-webhook-url').val(),
        push_key: $('#push-key').val(),
        product_ids: productIds,
        msg_type: $('#push-msg-type').val(),
        template: $('#push-template').val(),
        enabled: checkedBit('#push-enabled')
    };

    if (!formData.name) { notify('请填写配置名称'); return; }
    if (!formData.webhook_url) { notify('请填写微信 Webhook 推送地址'); return; }
    if (!formData.push_key) { notify('请填写验证密钥'); return; }
    if (productIds.length === 0) { notify('请至少选择一个绑定产品'); return; }

    submitJson(id ? '/api/price/admin/push/' + id : '/api/price/admin/push', formData, {
        method: id ? 'PUT' : 'POST',
        successMessage: id ? '推送配置已更新' : '推送配置已创建',
        closeModalId: 'pushModal',
        onSuccess: function() { loadPushConfigs(); }
    });
}

function deletePushConfig(id) {
    confirmAndRequest('确定要删除该推送配置吗？删除后推送地址将立即失效。', '/api/price/admin/push/' + id, { method: 'DELETE' }, {
        successMessage: '推送配置已删除',
        onSuccess: function() { loadPushConfigs(); }
    });
}

function testPushConfig(id) {
    apiFetch('/api/price/admin/push/' + id + '/test', { method: 'POST' })
    .then(response => response.json())
    .then(data => {
        showResultModal('测试推送', [{
            name: '推送测试',
            success: !!data.success,
            message: data.success ? (data.message || '推送成功') : (data.message || data.error || '推送失败')
        }]);
        loadPushConfigs();
    })
    .catch(error => {
        console.error('测试推送失败:', error);
        showResultModal('测试推送', [{ name: '推送测试', success: false, message: '测试请求失败，请检查网络连接' }]);
    });
}

// 在光标处插入字段占位符
function insertPushField(field) {
    var textarea = $('#push-template')[0];
    var start = textarea.selectionStart, end = textarea.selectionEnd;
    var text = textarea.value;
    textarea.value = text.slice(0, start) + field + text.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + field.length;
    textarea.focus();
}

// 客户端模板渲染（预览用）
function renderPushTemplateClient(template, rec) {
    var change = rec.change_value === null || rec.change_value === undefined ? 0 : Number(rec.change_value);
    var changeStr = change > 0 ? '↑ +' + change : (change < 0 ? '↓ ' + change : '- 0');
    return String(template)
        .replace(/\{日期\}/g, rec.trade_date || '')
        .replace(/\{产品\}/g, rec.product_name || '')
        .replace(/\{均价\}/g, rec.avg_price === null || rec.avg_price === undefined ? '' : String(rec.avg_price))
        .replace(/\{单位\}/g, rec.unit || '')
        .replace(/\{涨跌\}/g, changeStr);
}

// 客户端模版卡片预览渲染（模拟企业微信 text_notice 卡片结构）
function renderPushCardClient(records) {
    var fmtChange = function(v) {
        var c = v === null || v === undefined ? 0 : Number(v);
        return c > 0 ? '↑ +' + c : (c < 0 ? '↓ ' + c : '- 0');
    };
    if (records.length === 1) {
        var rec = records[0];
        return '【模版卡片预览】\n'
            + '来源：报价播报\n'
            + '「' + (rec.product_name || '-') + '」\n'
            + '报价日期 ' + (rec.trade_date || '-') + '\n'
            + '★ ' + (rec.avg_price === null || rec.avg_price === undefined ? '-' : rec.avg_price) + '\n'
            + '日均价（' + (rec.unit || '-') + '）\n'
            + '涨跌：' + fmtChange(rec.change_value) + '\n'
            + '单位：' + (rec.unit || '-');
    }
    var latestDate = records[0].trade_date || '';
    records.forEach(function(r) {
        if (r.trade_date && r.trade_date > latestDate) latestDate = r.trade_date;
    });
    var lines = records.map(function(r) {
        return '· ' + (r.product_name || '-') + '：'
            + (r.avg_price === null || r.avg_price === undefined ? '-' : r.avg_price)
            + ' ' + (r.unit || '')
            + '（' + fmtChange(r.change_value) + '）';
    });
    return '【模版卡片预览】\n'
        + '来源：报价播报\n'
        + '「最新报价播报」\n'
        + '报价日期 ' + (latestDate || '-') + '\n'
        + lines.join('\n');
}

// 使用最新报价数据预览消息效果（弹窗展示，多产品逐个渲染后拼接）
function previewPushMessage() {
    var productIds = ($('#push-product-select').val() || []).map(v => parseInt(v)).filter(v => v);
    if (productIds.length === 0) { notify('请先选择绑定产品'); return; }

    var isCard = $('#push-msg-type').val() === 'card';
    var template = $('#push-template').val() || PUSH_DEFAULT_TEMPLATE;
    var preview = $('#push-preview');
    preview.text('加载中...');
    openModal('pushPreviewModal');

    var fetches = productIds.map(pid => {
        var product = adminProductsCache.find(p => String(p.id) === String(pid));
        if (!product) return Promise.resolve(null);
        return fetch('/api/price/latest?product=' + encodeURIComponent(product.code) + '&limit=1')
        .then(r => r.json())
        .then(data => (data.prices && data.prices.length > 0) ? data.prices[0] : null)
        .catch(() => null);
    });

    Promise.all(fetches).then(results => {
        var records = results.filter(r => r);
        if (records.length === 0) {
            preview.text('所选产品均无报价数据，无法预览');
            return;
        }
        preview.text(isCard
            ? renderPushCardClient(records)
            : records.map(rec => renderPushTemplateClient(template, rec)).join('\n\n'));
    });
}

// 系统设置管理
function loadSettings() {
    apiFetch('/api/price/admin/settings')
    .then(response => response.json())
    .then(data => {
        if (data.settings) {
            systemSettingsCache = {};
            data.settings.forEach(item => {
                systemSettingsCache[item.key] = item.value;
                var input = $('#settings-form [name="' + item.key + '"]');
                if (input.length) {
                    input.val(item.value);
                }
            });
        }
    })
    .catch(error => {
        console.error('加载系统设置失败:', error);
        notify('加载系统设置失败，请检查网络连接');
    });
}

function saveSettings() {
    var formData = {};
    $('#settings-form').serializeArray().forEach(item => {
        formData[item.name] = item.value;
    });
    
    submitJson('/api/price/admin/settings', formData, {
        method: 'PUT',
        successMessage: '设置保存成功',
        onSuccess: function() { loadSettings(); }
    });
}

// 用户管理
function loadUsers() {
    loadList({
        url: '/api/price/admin/users',
        dataKey: 'users',
        render: data => updateUsersTable(data.users),
        target: '#users-table tbody',
        colspan: 4,
        errorLabel: '加载用户列表失败'
    });
}

function updateUsersTable(users) {
    var tbody = $('#users-table tbody');
    tbody.empty();
    
    if (!users || users.length === 0) {
        renderTablePlaceholder(tbody, 4, '暂无用户');
        return;
    }
    
    var currentUsername = $('#header-username').text().trim();
    var totalCount = users.length;
    
    users.forEach(user => {
        var isSelf = user.username === currentUsername;
        var isLastAdmin = totalCount <= 1;
        var canDelete = !isSelf && !isLastAdmin;
        
        var row = `
            <tr>
                <td title="${escapeHtml(user.username)}"><strong>${escapeHtml(user.username)}</strong>${isSelf ? ' <span class="text-muted">(当前用户)</span>' : ''}</td>
                <td title="${user.last_login || '-'}">${user.last_login || '-'}</td>
                <td title="${user.created_at || '-'}">${user.created_at || '-'}</td>
                <td class="cell-wrap">
                    <div class="action-buttons">
                        <button class="action-btn edit-btn" data-user-id="${user.id}" data-username="${escapeHtml(user.username)}">编辑</button>
                        <button class="action-btn delete-btn" data-user-id="${user.id}" data-username="${escapeHtml(user.username)}" ${canDelete ? '' : 'disabled'}>删除</button>
                    </div>
                </td>
            </tr>
        `;
        tbody.append(row);
    });
}

// UTC 时间字符串转北京时间显示（Cloudflare Workers/D1 存储均为 UTC）
function toBeijingTime(utcStr) {
    if (!utcStr) return '-';
    try {
        var d = new Date(utcStr.replace(' ', 'T') + (utcStr.indexOf('Z') === -1 && utcStr.indexOf('+') === -1 ? 'Z' : ''));
        if (isNaN(d.getTime())) return utcStr;
        return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    } catch (e) {
        return utcStr;
    }
}

function openUserModal(userId, username) {
    $('#user-form')[0].reset();
    
    if (userId) {
        $('#user-modal-title').text('编辑用户');
        $('#user-id').val(userId);
        $('#user-username').val(username || '');
        $('#user-password').attr('placeholder', '留空表示不修改密码');
    } else {
        $('#user-modal-title').text('新增用户');
        $('#user-id').val('');
        $('#user-password').attr('placeholder', '请输入密码');
    }
    
    openModal('userModal');
}

function saveUser() {
    var userId = $('#user-id').val();
    var username = $('#user-username').val().trim();
    var password = $('#user-password').val();
    
    if (!username) {
        notify('请输入用户名');
        return;
    }
    
    if (!userId && !password) {
        notify('新增用户时必须设置密码');
        return;
    }
    
    if (password && password.length < 8) {
        notify('密码长度不能少于 8 位');
        return;
    }
    
    var payload = { username: username };
    if (password) {
        payload.password = password;
    }
    
    submitJson(userId ? '/api/price/admin/users/' + userId : '/api/price/admin/users', payload, {
        method: userId ? 'PUT' : 'POST',
        successMessage: userId ? '用户更新成功' : '用户创建成功',
        closeModalId: 'userModal',
        onSuccess: function() { loadUsers(); }
    });
}

function deleteUser(userId, username) {
    confirmAndRequest('确定要删除用户 "' + username + '" 吗？此操作不可恢复。', '/api/price/admin/users/' + userId, { method: 'DELETE' }, {
        successMessage: '用户已删除',
        onSuccess: function() { loadUsers(); }
    });
}

// 产品类型
var adminProductsCache = [];
var systemSettingsCache = {};

function loadAdminProducts() {
    Promise.all([
        apiFetch('/api/price/admin/products').then(function(r) { return r.json(); }),
        apiFetch('/api/price/admin/settings').then(function(r) { return r.json(); })
    ])
    .then(([productData, settingData]) => {
        if (productData.products) {
            adminProductsCache = productData.products;
            if (settingData.settings) {
                systemSettingsCache = {};
                settingData.settings.forEach(item => {
                    systemSettingsCache[item.key] = item.value;
                });
            }
            updateProductsTable(productData.products);
            populateManualProductSelect();
            populateWebhookProductSelect();
            populateEditProductSelect();
        } else {
            renderTablePlaceholder('#products-table tbody', 7, '加载失败：' + (productData.error || '未知错误'));
        }
    })
    .catch(error => {
        console.error('加载产品类型失败:', error);
        renderTablePlaceholder('#products-table tbody', 7, '加载失败，请检查网络连接');
    });
}

function updateProductsTable(products) {
    var tbody = $('#products-table tbody');
    tbody.empty();
    var homepageProduct = systemSettingsCache.homepage_product || '';

    if (!products || products.length === 0) {
        renderTablePlaceholder(tbody, 7, '暂无产品类型');
        return;
    }

    products.forEach(product => {
        var isHomepage = product.code === homepageProduct;
        var homepageBtn = isHomepage
            ? '<span class="status-badge status-success">当前首页</span>'
            : `<button class="action-btn set-homepage-btn" data-product-code="${escapeHtml(product.code)}" data-product-name="${escapeHtml(product.name)}">设为首页</button>`;

        var row = `
            <tr>
                <td title="${escapeHtml(product.code)}"><code>${escapeHtml(product.code)}</code></td>
                <td title="${escapeHtml(product.name)}"><strong>${escapeHtml(product.name)}</strong></td>
                <td title="${escapeHtml(product.unit)}">${escapeHtml(product.unit)}</td>
                <td title="${escapeHtml(product.spec || '-')}">${escapeHtml(product.spec || '-')}</td>
                <td>${product.sort_order}</td>
                <td>${renderStatusBadge(product.is_active, '启用', '停用')}</td>
                <td class="cell-wrap">
                    <div class="action-buttons">
                        ${homepageBtn}
                        <button class="action-btn edit-btn" data-product-id="${product.id}">编辑</button>
                        <button class="action-btn delete-btn" data-product-id="${product.id}" data-product-name="${escapeHtml(product.name)}">删除</button>
                    </div>
                </td>
            </tr>
        `;
        tbody.append(row);
    });
}

// 设置前台默认首页产品
function setHomepageProduct(productCode, productName) {
    apiFetch('/api/price/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ homepage_product: productCode })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            notify(`已将「${productName}」设为前台首页`);
            systemSettingsCache.homepage_product = productCode;
            updateProductsTable(adminProductsCache);
        } else {
            notify('设置失败：' + (data.error || '未知错误'));
        }
    })
    .catch(error => {
        console.error('设置首页产品失败:', error);
        notify('设置失败，请检查网络连接');
    });
}

// 重建产品下拉选项（保留当前选中值；renderOption 接收产品对象并返回 option 的 HTML）
function rebuildProductSelect(selector, products, renderOption) {
    var select = $(selector);
    var currentVal = select.val();
    select.find('option:not(:first)').remove();
    products.forEach(product => select.append(renderOption(product)));
    if (currentVal && select.find('option[value="' + currentVal.replace(/"/g, '\\"') + '"]').length) {
        select.val(currentVal);
    }
}

function populateManualProductSelect() {
    rebuildProductSelect('#manual-product-select', adminProductsCache.filter(p => p.is_active), product => {
        var optionText = escapeHtml(product.name) + ' (' + escapeHtml(product.unit) + ')';
        return `<option value="${escapeHtml(product.code)}" title="${optionText}">${optionText}</option>`;
    });
}

function populateWebhookProductSelect() {
    rebuildProductSelect('#webhook-target-product-select', adminProductsCache.filter(p => p.is_active), product => {
        return `<option value="${escapeHtml(product.code)}">${escapeHtml(product.name)}</option>`;
    });
}

function populateEditProductSelect() {
    // 编辑时应包含所有产品（含已停用），否则已停用产品的历史记录无法编辑
    rebuildProductSelect('#edit-product-select', adminProductsCache, product => {
        var optionText = escapeHtml(product.name) + ' (' + escapeHtml(product.unit) + ')' + (product.is_active ? '' : ' [已停用]');
        return `<option value="${escapeHtml(product.code)}" title="${optionText}">${optionText}</option>`;
    });
}

function openProductModal(productId) {
    $('#product-form')[0].reset();
    $('#product-code').prop('readonly', false);
    
    if (productId) {
        var product = adminProductsCache.find(p => p.id === productId);
        if (!product) {
            notify('未找到产品类型信息');
            return;
        }
        
        $('#product-modal-title').text('编辑产品类型');
        $('#product-id').val(product.id);
        $('#product-code').val(product.code).prop('readonly', true);
        $('#product-name').val(product.name);
        $('#product-unit').val(product.unit);
        $('#product-spec').val(product.spec || '');
        $('#product-sort-order').val(product.sort_order);
        $('#product-is-active').prop('checked', product.is_active == 1 || product.is_active === true);
    } else {
        $('#product-modal-title').text('新增产品类型');
        $('#product-id').val('');
        $('#product-is-active').prop('checked', true);
    }
    
    openModal('productModal');
}

function saveProduct() {
    var productId = $('#product-id').val();
    var code = $('#product-code').val().trim();
    var name = $('#product-name').val().trim();
    var unit = $('#product-unit').val().trim();
    var spec = $('#product-spec').val().trim();
    var sortOrder = parseInt($('#product-sort-order').val()) || 0;
    var isActive = $('#product-is-active').is(':checked');
    
    if (!code || !name || !unit) {
        notify('产品代码、名称和单位不能为空');
        return;
    }
    
    if (!/^[a-zA-Z0-9_-]+$/.test(code)) {
        notify('产品代码只能包含字母、数字、下划线和横线');
        return;
    }
    
    var payload = {
        code: code,
        name: name,
        unit: unit,
        spec: spec,
        sort_order: sortOrder,
        is_active: isActive
    };
    
    submitJson(productId ? '/api/price/admin/products/' + productId : '/api/price/admin/products', payload, {
        method: productId ? 'PUT' : 'POST',
        successMessage: productId ? '产品类型更新成功' : '产品类型创建成功',
        closeModalId: 'productModal',
        onSuccess: function() { loadAdminProducts(); }
    });
}

function deleteProduct(productId, productName) {
    confirmAndRequest('确定要删除产品类型 "' + productName + '" 吗？已有报价数据的产品类型无法删除。', '/api/price/admin/products/' + productId, { method: 'DELETE' }, {
        successMessage: '产品类型已删除',
        onSuccess: function() { loadAdminProducts(); }
    });
}

// 手工补录表单提交（实际API调用）
$('#manual-form').submit(function(e) {
    e.preventDefault();

    var formData = {
        product_code: $('#manual-form select[name="product"]').val(),
        trade_date: $('#manual-form input[name="date"]').val(),
        low_price: parseFloat($('#manual-form input[name="low_price"]').val()),
        high_price: parseFloat($('#manual-form input[name="high_price"]').val()),
        avg_price: $('#manual-form input[name="avg_price"]').val() || undefined,
        change_value: parseFloat($('#manual-form input[name="change"]').val()),
        remark: $('#manual-form textarea[name="remark"]').val()
    };
    
    apiFetch('/api/price/manual', {
        method: 'POST',
        body: JSON.stringify(formData)
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            notify('数据保存成功！');
            // 清空表单
            $('#manual-form')[0].reset();
            // 重新加载数据
            loadRecentPrices();
        } else {
            notify('保存失败：' + (data.error || '未知错误'));
        }
    })
    .catch(error => {
        console.error('保存失败:', error);
        notify('保存失败，请检查网络连接');
    });
});

// 编辑记录
function editRecord(id) {
    apiFetch(`/api/price/admin/records/${id}`)
        .then(response => response.json())
        .then(data => {
        if (data.record) {
            var record = data.record;
            $('#edit-form input[name="id"]').val(record.id);
            $('#edit-form select[name="product_code"]').val(record.product_code);
            $('#edit-form input[name="low_price"]').val(record.low_price);
            $('#edit-form input[name="high_price"]').val(record.high_price);
            $('#edit-form input[name="avg_price"]').val(record.avg_price);
            $('#edit-form input[name="change"]').val(record.change_value);
            $('#edit-form textarea[name="remark"]').val(record.remark || '');

            openModal('editModal');
        } else {
            notify('获取记录失败：' + (data.error || '未知错误'));
        }
    })
    .catch(error => {
        console.error('获取记录失败:', error);
        notify('获取记录失败，请检查网络连接');
    });
}
