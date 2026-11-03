/* 报价查询系统 - 后台定时任务脚本 */
// ==================== 定时任务管理 ====================
// Cron 频率切换：显示对应的参数区域
function onCronFrequencyChange() {
    var freq = $('#cron-frequency').val();
    $('#cron-param-minute, #cron-param-hourly, #cron-param-daily, #cron-param-weekly, #cron-param-monthly, #cron-param-custom').hide();
    if (freq === 'minute') $('#cron-param-minute').show();
    else if (freq === 'hourly') $('#cron-param-hourly').show();
    else if (freq === 'daily') $('#cron-param-daily').show();
    else if (freq === 'weekly') $('#cron-param-weekly').show();
    else if (freq === 'monthly') $('#cron-param-monthly').show();
    else if (freq === 'custom') $('#cron-param-custom').show();
}

// 根据可视化参数生成 cron 表达式
function buildCronExpression() {
    var freq = $('#cron-frequency').val();
    switch (freq) {
        case 'minute':
            var n = parseInt($('input[name="cron_minute_interval"]').val()) || 5;
            return '*/' + n + ' * * * *';
        case 'hourly':
            var m = parseInt($('input[name="cron_hourly_minute"]').val()) || 0;
            return m + ' * * * *';
        case 'daily':
            var t = ($('input[name="cron_daily_time"]').val() || '00:00').split(':');
            return t[1] + ' ' + t[0] + ' * * *';
        case 'weekly':
            var wt = ($('input[name="cron_weekly_time"]').val() || '00:00').split(':');
            var days = collectCheckedValues('input[name="cron_dow"]', false);
            var dows = days.length > 0 ? days.join(',') : '1-5';
            return wt[1] + ' ' + wt[0] + ' * * ' + dows;
        case 'monthly':
            var md = parseInt($('input[name="cron_monthly_day"]').val()) || 1;
            var mt = ($('input[name="cron_monthly_time"]').val() || '00:00').split(':');
            return mt[1] + ' ' + mt[0] + ' ' + md + ' * *';
        case 'custom':
            return $('input[name="cron_custom"]').val().trim() || '* * * * *';
        default: return '0 8 * * *';
    }
}

// URL 预设选择：切换自定义 URL 输入框
function onTaskUrlPresetChange() {
    var val = $('#cron-task-url-preset').val();
    if (val === '__custom__') {
        $('#cron-custom-url-container').show();
    } else {
        $('#cron-custom-url-container').hide();
    }
}

// 获取最终任务 URL
function getTaskUrl() {
    var val = $('#cron-task-url-preset').val();
    if (val === '__custom__') {
        return $('#cron-task-url-custom').val().trim();
    }
    return val;
}

function loadCronJobs() {
    checkHeartbeat();
    loadList({
        url: '/api/price/admin/cron',
        dataKey: 'jobs',
        render: data => renderCronTable(data.jobs),
        target: '#cron-jobs-table tbody',
        colspan: 8,
        errorLabel: '加载定时任务失败',
        failMessage: '加载失败',
        networkMessage: e => '加载失败：' + String(e.message)
    });
}

// Cron 日志状态徽章（success/failed/timeout 之外的取值按「运行中」处理）
function renderCronLogStatus(status) {
    var map = {
        success: ['status-success', '成功'],
        failed: ['status-danger', '失败'],
        timeout: ['status-default', '超时/已清理']
    };
    var item = map[status] || ['status-warning', '运行中'];
    return '<span class="status-badge ' + item[0] + '">' + item[1] + '</span>';
}

function loadCronLogs() {
    loadList({
        url: '/api/price/admin/cron/logs?limit=50',
        dataKey: 'logs',
        render: data => renderCronLogsTable(data.logs),
        target: '#cron-logs-table tbody',
        colspan: 6,
        errorLabel: '加载日志失败',
        failMessage: '加载失败',
        networkMessage: e => '加载失败：' + String(e.message)
    });
}

function renderCronLogsTable(logs) {
    var tbody = $('#cron-logs-table tbody');
    tbody.empty();
    if (!logs || logs.length === 0) {
        renderTablePlaceholder(tbody, 6, '暂无日志');
        return;
    }
    var cellStyle = TRUNC_CELL_STYLE;
    logs.forEach(log => {
        var nameHtml = escapeHtml(log.job_name);
        var msgText = log.message || '-';
        var msgHtml = escapeHtml(msgText.length > 80 ? msgText.substring(0, 80) + '...' : msgText);
        tbody.append(`<tr>
            <td><input type="checkbox" class="log-checkbox" value="${log.id}" onchange="updateBatchDeleteBtn()"></td>
            <td title="${nameHtml}" style="${cellStyle} max-width: 120px;">${nameHtml}</td>
            <td>${renderCronLogStatus(log.status)}</td>
            <td title="${escapeHtml(msgText)}" style="${cellStyle} max-width: 300px;">${msgHtml}</td>
            <td title="${escapeHtml(log.started_at || '') || '-'}" style="${cellStyle} max-width: 130px;">${toBeijingTime(log.started_at)}</td>
            <td title="${escapeHtml(log.finished_at || '') || '-'}" style="${cellStyle} max-width: 130px;">${toBeijingTime(log.finished_at)}</td>
        </tr>`);
    });
}

function renderCronTable(jobs) {
    var tbody = $('#cron-jobs-table tbody');
    tbody.empty();
    if (!jobs || jobs.length === 0) {
        renderTablePlaceholder(tbody, 8, '暂无定时任务，请在 Cloudflare Dashboard 添加 Cron Trigger 心跳后在此创建任务');
        return;
    }
    // 类型列改为显示 URL 摘要
    var cellStyle = TRUNC_CELL_STYLE;
    jobs.forEach(job => {
        var status = renderStatusBadge(job.enabled, '启用', '停用');
        var lastRunRaw = job.last_run_at || '-';
        var lastRun = toBeijingTime(job.last_run_at);
        var lastMsg = job.last_run_message ? job.last_run_message.substring(0, 50) : '-';
        var nameHtml = escapeHtml(job.name);
        var cronHtml = escapeHtml(job.cron_expression);
        var msgHtml = escapeHtml(lastMsg);
        var fullMsg = escapeHtml(job.last_run_message || '');
        var urlShort = (job.task_url || '');
        if (urlShort.startsWith('/api/price/admin/cron/_internal/')) {
            urlShort = urlShort.replace('/api/price/admin/cron/_internal/', '内部: ');
        }
        if (urlShort.length > 30) urlShort = urlShort.substring(0, 30) + '...';
        tbody.append(`<tr>
            <td style="text-align: center;"><input type="checkbox" class="cron-row-check" value="${job.id}"></td>
            <td title="${nameHtml}" style="${cellStyle} max-width: 140px;"><strong>${nameHtml}</strong></td>
            <td title="${cronHtml}" style="${cellStyle} max-width: 130px;"><code>${cronHtml}</code></td>
            <td title="${escapeHtml(job.task_url || '')}" style="${cellStyle} max-width: 140px;">${escapeHtml(urlShort)}</td>
            <td>${status}</td>
            <td title="${escapeHtml(lastRunRaw)}" style="${cellStyle} max-width: 150px;">${lastRun}</td>
            <td title="${fullMsg}" style="${cellStyle} max-width: 130px;">${msgHtml}</td>
            <td style="white-space: nowrap;">
                <div class="action-buttons">
                    <button class="action-btn cron-run-btn" data-job-id="${job.id}" style="color: #27ae60;">执行</button>
                    <button class="action-btn edit-btn cron-edit-btn" data-job-id="${job.id}">编辑</button>
                    <button class="action-btn delete-btn cron-delete-btn" data-job-id="${job.id}" data-job-name="${escapeHtml(job.name)}">删除</button>
                </div>
            </td>
        </tr>`);
    });
}

function openCronModal(id) {
    $('#cron-form')[0].reset();
    $('#cron-id').val('');
    $('#cron-modal-title').text('新增定时任务');
    $('#cron-frequency').val('daily').change();
    $('#cron-task-url-preset').val('').change();
    if (id) {
        $('#cron-modal-title').text('编辑定时任务');
        apiFetch('/api/price/admin/cron/' + id)
            .then(r => r.json())
            .then(data => {
                if (data.job) {
                    $('#cron-id').val(data.job.id);
                    $('#cron-name').val(data.job.name);
                    // 尝试还原 cron 表达式到可视化表单
                    setCronFormFromExpression(data.job.cron_expression);
                    // 还原 URL
                    var url = data.job.task_url || '';
                    if (url === '/api/price/admin/cron/_internal/recalc' || url === '/api/price/admin/cron/_internal/data-check') {
                        $('#cron-task-url-preset').val(url);
                    } else if (url) {
                        $('#cron-task-url-preset').val('__custom__');
                        $('#cron-task-url-custom').val(url);
                    }
                    onTaskUrlPresetChange();
                    $('#cron-enabled').prop('checked', data.job.enabled == 1);
                }
            });
    }
    openModal('cronModal');
}

// 根据 cron 表达式还原可视化表单（简单启发式匹配）
function setCronFormFromExpression(expr) {
    if (!expr) return;
    expr = expr.trim();
    // */5 * * * * → minute
    var mm = expr.match(/^\*\/(\d+) \* \* \* \*$/);
    if (mm) { $('#cron-frequency').val('minute'); $('input[name="cron_minute_interval"]').val(mm[1]); onCronFrequencyChange(); return; }
    // M * * * * → hourly
    var hm = expr.match(/^(\d+) \* \* \* \*$/);
    if (hm && !expr.includes('/')) { $('#cron-frequency').val('hourly'); $('input[name="cron_hourly_minute"]').val(hm[1]); onCronFrequencyChange(); return; }
    // M H * * DOW → weekly
    var wm = expr.match(/^(\d+) (\d+) \* \* (.+)$/);
    if (wm) {
        var parts = expr.split(/\s+/);
        if (parts.length >= 5) {
            var min = parts[0], hour = parts[1], dom = parts[2], mon = parts[3], dow = parts[4];
            if (dom === '*' && mon === '*' && dow !== '*') {
                // weekly
                $('#cron-frequency').val('weekly');
                $('input[name="cron_weekly_time"]').val(hour.padStart(2,'0') + ':' + min.padStart(2,'0'));
                $('input[name="cron_dow"]').prop('checked', false);
                dow.split(',').forEach(function(d) { $('input[name="cron_dow"][value="' + d + '"]').prop('checked', true); });
                onCronFrequencyChange(); return;
            }
            if (dom !== '*' && mon === '*' && dow === '*') {
                // monthly
                $('#cron-frequency').val('monthly');
                $('input[name="cron_monthly_day"]').val(dom);
                $('input[name="cron_monthly_time"]').val(hour.padStart(2,'0') + ':' + min.padStart(2,'0'));
                onCronFrequencyChange(); return;
            }
            if (dom === '*' && mon === '*' && dow === '*') {
                // daily
                $('#cron-frequency').val('daily');
                $('input[name="cron_daily_time"]').val(hour.padStart(2,'0') + ':' + min.padStart(2,'0'));
                onCronFrequencyChange(); return;
            }
        }
    }
    // fallback: custom
    $('#cron-frequency').val('custom');
    $('input[name="cron_custom"]').val(expr);
    onCronFrequencyChange();
}

// 心跳状态检测
function checkHeartbeat() {
    apiFetch('/api/price/admin/cron/heartbeat')
        .then(r => r.json())
        .then(data => {
            var dot = $('#heartbeat-dot');
            var text = $('#heartbeat-text');
            var timeEl = $('#heartbeat-time');
            if (data.is_alive) {
                dot.css('background', '#28a745');
                text.text('正常运行');
                text.css('color', '#28a745');
                timeEl.text('上次心跳：' + (data.last_heartbeat_beijing || data.last_heartbeat_at || '-'));
            } else {
                dot.css('background', '#dc3545');
                text.text('未检测到心跳，请在 Cloudflare Dashboard → Workers → Triggers 添加 Cron Trigger');
                text.css('color', '#dc3545');
                timeEl.text(data.last_heartbeat_at ? '上次心跳：' + (data.last_heartbeat_beijing || data.last_heartbeat_at) + '（已超时）' : '从未检测到心跳');
            }
        })
        .catch(e => {
            $('#heartbeat-dot').css('background', '#ffc107');
            $('#heartbeat-text').text('检测失败').css('color', '#ffc107');
        });
}

// 日志全选/取消全选
function toggleAllLogs(checkbox) {
    toggleSelectAll('.log-checkbox', checkbox.checked, updateBatchDeleteBtn);
}

// 更新批量删除按钮状态
function updateBatchDeleteBtn() {
    updateBatchDeleteButton('#btn-batch-delete-logs', '.log-checkbox', function(count) {
        return count > 0 ? '删除选中日志 (' + count + ')' : '批量删除选中日志';
    });
}

// 批量删除日志
function batchDeleteCronLogs() {
    var ids = collectCheckedValues('.log-checkbox', true);
    if (ids.length === 0) return;
    confirmAndRequest('确定要删除选中的 ' + ids.length + ' 条日志吗？此操作不可恢复。', '/api/price/admin/cron/logs', {
        method: 'DELETE',
        body: JSON.stringify({ ids: ids })
    }, {
        successMessage: '已删除选中日志',
        onSuccess: function() { loadCronLogs(); }
    });
}

// 清理残留的运行中任务（超过 30 分钟仍未结束的标记为超时）
function clearStaleRunningTasks() {
    openConfirmModal('将把「运行中」超过 30 分钟的任务标记为超时/已清理，确定继续吗？', function() {
        apiFetch('/api/price/admin/cron/clear-stale', {
            method: 'POST',
            body: JSON.stringify({ minutes: 30 })
        })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    showResultModal('清理残留任务', [{ name: '清理完成', success: true, message: '已清理 ' + (data.cleared || 0) + ' 条残留运行中任务' }]);
                    loadCronLogs();
                } else {
                    showResultModal('清理残留任务', [{ name: '清理失败', success: false, message: data.error || data.details || '未知错误' }]);
                }
            })
            .catch(e => showResultModal('清理残留任务', [{ name: '清理失败', success: false, message: '请求失败：' + e.message }]));
    }, { title: '确认清理', okText: '确定清理' });
}

function saveCronJob() {
    var id = $('#cron-id').val();
    var payload = {
        name: $('#cron-name').val().trim(),
        cron_expression: buildCronExpression(),
        task_url: getTaskUrl(),
        enabled: checkedBit('#cron-enabled')
    };
    var missing = [];
    if (!payload.name) missing.push('任务名称');
    if (!payload.cron_expression) missing.push('执行频率');
    if (!payload.task_url) missing.push('任务 URL');
    if (missing.length > 0) { notify('请填写：' + missing.join('、')); return; }
    submitJson(id ? '/api/price/admin/cron/' + id : '/api/price/admin/cron', payload, {
        method: id ? 'PUT' : 'POST',
        successMessage: '保存成功',
        closeModalId: 'cronModal',
        onSuccess: function() { loadCronJobs(); }
    });
}

function deleteCronJob(id, name) {
    confirmAndRequest('确定要删除任务 "' + name + '" 吗？', '/api/price/admin/cron/' + id, { method: 'DELETE' }, {
        successMessage: '已删除',
        onSuccess: function() { loadCronJobs(); }
    });
}

function runCronJob(id) {
    openConfirmModal('确定要立即执行该任务吗？', function() {
        apiFetch('/api/price/admin/cron/' + id + '/run', { method: 'POST' })
            .then(r => r.json())
            .then(d => {
                showResultModal('任务执行', [{
                    name: '任务 #' + id,
                    success: !!d.success,
                    message: d.success ? (d.message || '执行成功') : (d.error || d.details || '执行失败')
                }]);
                loadCronJobs(); loadCronLogs();
            })
            .catch(e => showResultModal('任务执行', [{ name: '任务 #' + id, success: false, message: '请求失败：' + e.message }]));
    }, { title: '确认执行', okText: '立即执行' });
}

function batchRunCronJobs() {
    var ids = collectCheckedValues('.cron-row-check', true);
    if (ids.length === 0) { notify('请先勾选要执行的任务'); return; }
    openConfirmModal('确定批量执行 ' + ids.length + ' 个任务吗？', function() {
        apiFetch('/api/price/admin/cron/batch-run', {
            method: 'POST',
            body: JSON.stringify({ ids: ids })
        })
            .then(r => r.json())
            .then(d => {
                if (d && d.results) {
                    showResultModal('批量执行（成功 ' + d.successCount + ' / 失败 ' + d.failedCount + '）', d.results.map(function(x) {
                        return { name: x.name || ('任务 #' + x.id), success: !!x.success, message: x.message || '' };
                    }));
                    loadCronJobs(); loadCronLogs();
                } else {
                    showResultModal('批量执行', [{ name: '批量执行', success: false, message: d.error || d.details || '未知错误' }]);
                }
            })
            .catch(e => showResultModal('批量执行', [{ name: '批量执行', success: false, message: '请求失败：' + e.message }]));
    }, { title: '确认执行', okText: '批量执行' });
}

