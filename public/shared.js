/* 报价查询系统 - 前后台共用工具函数 */
/* 需在 jQuery 之后、页面内联脚本之前引入 */

// HTML 转义
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// 轻提示（toast）：根据内容自动识别类型，替代原生 alert
function notify(message, type) {
    if (!type) {
        var m = String(message || '');
        if (/失败|错误|请检查|无效|不能|不存在|格式|超时|过期|缺少|不可|异常|无响应/.test(m)) type = 'error';
        else if (/请先|请填写|请选择|请至少|请输入|请勾选|请填|请勿/.test(m)) type = 'warning';
        else if (/成功|已删除|已更新|已创建|已保存|已设置|已清理|已设为/.test(m)) type = 'success';
        else type = 'info';
    }
    var colors = { success: '#27ae60', error: '#e74c3c', warning: '#f39c12', info: '#3b82f6' };
    var $toast = $('<div></div>').css({
        position: 'fixed', top: '20px', right: '20px', zIndex: 10000,
        background: colors[type] || colors.info, color: '#fff',
        padding: '12px 20px', borderRadius: '6px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.2)', fontSize: '14px',
        maxWidth: '360px', wordBreak: 'break-all',
        opacity: 0, transition: 'opacity 0.3s'
    }).text(message);
    $('body').append($toast);
    setTimeout(function() { $toast.css('opacity', 1); }, 10);
    setTimeout(function() {
        $toast.css('opacity', 0);
        setTimeout(function() { $toast.remove(); }, 350);
    }, 3500);
}
