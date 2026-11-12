/* 报价查询系统 - 前台交互脚本 */
// 当前选中的产品和图表周期
var currentProduct = '';
var productList = [];
var currentPeriod = 30;
var currentYear = new Date().getFullYear();
var currentMonth = new Date().getMonth(); // 0-11，默认为当前月
var availableYears = [];
var chartMode = 'month'; // 走势图模式：'period' 按周期，'month' 按月份

// 读取上次保存的前端状态（产品/年份/月份），用于刷新后恢复
var savedState = loadFrontendState();

// 保存前端状态到 localStorage
function saveFrontendState() {
    try {
        localStorage.setItem('frontend_state', JSON.stringify({
            product: currentProduct,
            month: currentMonth
        }));
    } catch (e) {}
}

// 从 localStorage 读取前端状态
function loadFrontendState() {
    try {
        var raw = localStorage.getItem('frontend_state');
        if (raw) {
            var s = JSON.parse(raw);
            if (s && typeof s === 'object') return s;
        }
    } catch (e) {}
    return {};
}

// 产品标签切换（统一处理函数）
$('#product-tabs').on('click', '.product-tab', function() {
    var code = $(this).data('product');
    // 空态/失败态占位标签无 data-product，直接忽略，避免请求 product=undefined
    if (!code) return;

    $('.product-tab').removeClass('active');
    $(this).addClass('active');

    currentProduct = code;

    // 记录当前产品，刷新后据此恢复
    saveFrontendState();

    // 更新图表产品信息
    updateChartProductInfo(currentProduct);

    // 加载历史数据，loadPriceHistory 会统一处理年份、月份、走势图和表格
    loadPriceHistory(currentProduct);
});

// 图表周期切换
$('.chart-period-tab').click(function() {
    currentPeriod = parseInt($(this).data('period'), 10);
    if (currentPeriod === 365) {
        updateYearlyChart(currentProduct);
        return;
    }

    chartMode = 'period';
    highlightPeriodTab(currentPeriod);

    // 「月走势」= 所选年份结束前的近30天：当年截至今天，往年截至该年最后一天。
    // 年份选择器保持不变，避免切换标签时跳回当前年
    updatePriceChart(currentProduct, currentPeriod);
});

// 数字格式化（复用单个 Intl 实例，避免表格渲染时反复构造）
var numberFormatter = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});
function formatNumber(num) {
    return numberFormatter.format(num);
}

// 当前选中产品的价格单位（唯一来源为后台"产品类型"维护的 products.unit）
function getCurrentUnit() {
    var info = productList.find(function(p) { return p.code === currentProduct; });
    return (info && info.unit) ? info.unit : '';
}

// 数值 + 单位（单位缺失时仅返回数值），供列表以外的价格文案复用
function formatWithUnit(num) {
    var unit = getCurrentUnit();
    return formatNumber(num) + (unit ? ' ' + unit : '');
}

// 统一刷新依赖单位但非数据驱动的展示点：列表表头单位标注、走势图 Y 轴标题
function updateUnitDisplays() {
    var unit = getCurrentUnit();
    $('.unit-tag').text(unit ? '（' + unit + '）' : '');
    // Y 轴标题与 tooltip 单位都取自当前产品，重绘即可同步
    if (chartData) renderSvgChart();
}

// 数字补零为两位字符串
function pad2(n) { return String(n).padStart(2, '0'); }

// 构造 YYYY-MM-DD 日期字符串（month 为 0-based）
function toDateStr(year, month, day) { return year + '-' + pad2(month + 1) + '-' + pad2(day); }

// 高亮指定的图表周期标签（30=近30天，365=所选年份）
// period 为空时清除全部高亮：月份视图由月份标签表示，不代表「近30天」
function highlightPeriodTab(period) {
    $('.chart-period-tab').removeClass('active');
    if (period === null || typeof period === 'undefined') return;
    $('.chart-period-tab[data-period="' + period + '"]').addClass('active');
}

// 带超时与竞态保护的 JSON 请求
// ctrlRef（可选）：同一管线的请求引用，新请求会取消上一次未完成请求，避免旧响应覆盖新数据
function requestJSON(url, ctrlRef, timeoutMs) {
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, timeoutMs || 10000);
    if (ctrlRef) {
        if (ctrlRef.current) ctrlRef.current.abort();
        ctrlRef.current = controller;
    }
    return fetch(url, { signal: controller.signal })
        .then(function(response) { return response.json(); })
        .finally(function() { clearTimeout(timeoutId); });
}

// 历史数据管线（切换产品/年份）与走势图管线（切换周期）各自的请求引用
var chartReq = { current: null };
var rangeReq = { current: null };

// 历史数据缓存：{ 产品代码: { 年份: 按日期倒序的记录数组 } }
// 首次只加载当前年份，切换年份时再按需 AJAX 加载，避免一次拉取近十年数据
var historyCache = {};
// 同一产品+年份的进行中请求：首屏预取与正式加载复用同一个请求，避免重复拉取
var historyInflight = {};

// 产品可用年份由 /api/price/products 随产品列表返回，无需为提取年份加载全量历史
function getProductYears(product) {
    var info = productList.find(function(p) { return p.code === product; });
    return (info && Array.isArray(info.years)) ? info.years : [];
}

function setHistoryLoading(message) {
    $('#history-table-body-left').html('<tr><td colspan="4" class="text-center text-muted">' + (message || '加载中...') + '</td></tr>');
    $('#history-table-body-right').empty();
    $('#history-total').text('当月共 0 天，有数据 0 条');
}

// 解码历史接口的紧凑格式（compact=1 返回 { cols, rows }），
// 统一转换为原有对象数组，后续渲染逻辑无需感知格式差异
function decodeHistory(data) {
    if (data && Array.isArray(data.cols) && Array.isArray(data.rows)) {
        var cols = data.cols;
        return data.rows.map(function(row) {
            var item = {};
            for (var i = 0; i < cols.length; i++) item[cols[i]] = row[i];
            return item;
        });
    }
    return (data && Array.isArray(data.history)) ? data.history : [];
}

// 加载指定产品、指定年份的数据（命中缓存时不再请求）
function loadYearData(product, year, onDone, onError) {
    var cache = historyCache[product] || (historyCache[product] = {});
    if (cache[year]) {
        onDone(cache[year]);
        return;
    }

    var key = product + '|' + year;
    var request = historyInflight[key];
    if (!request) {
        request = requestJSON(
            '/api/price/history?product=' + encodeURIComponent(product) + '&year=' + year + '&compact=1',
            null,
            10000
        ).then(function(data) {
            var rows = decodeHistory(data);
            rows.sort(function(a, b) { return b.trade_date.localeCompare(a.trade_date); });
            cache[year] = rows;
            return rows;
        });
        historyInflight[key] = request;
        var cleanup = function() { delete historyInflight[key]; };
        request.then(cleanup, cleanup);
    }

    request
        .then(function(rows) {
            if (currentProduct === product && currentYear === year) {
                window.currentHistoryData = rows;
            }
            onDone(rows);
        })
        .catch(function(error) {
            console.error('获取历史数据失败:', error);
            if (onError) onError(error);
        });
}

// 加载价格历史数据并初始化年份和月份
function loadPriceHistory(product) {
    window.currentHistoryData = [];
    // 保留已加载产品的年度缓存，切回同一产品时可直接复用
    if (!historyCache[product]) historyCache[product] = {};
    setHistoryLoading();

    availableYears = getProductYears(product);
    if (availableYears.length === 0) {
        renderEmptyMonth(currentYear, currentMonth);
        return;
    }

    // 首次加载时只恢复保存的月份（产品已在产品标签渲染时恢复）
    // 年份统一使用当前年，回访用户也能直接看到最新数据；当前年无数据时再回退到最新可用年份
    if (savedState) {
        if (typeof savedState.month === 'number' && savedState.month >= 0 && savedState.month <= 11) {
            currentMonth = savedState.month;
        }
        savedState = null;
    }

    // 当前年份没有数据时，回退到最新可用年份
    if (availableYears.indexOf(currentYear) === -1) {
        currentYear = availableYears[0];
    }

    var targetYear = currentYear;
    loadYearData(product, targetYear, function(rows) {
        // 请求返回前用户已切换产品或年份，丢弃本次结果
        if (currentProduct !== product || currentYear !== targetYear) return;

        window.currentHistoryData = rows;
        currentMonth = findBestMonth(rows, currentYear, currentMonth);
        renderMonthView(rows, currentYear, currentMonth);

        // 根据当前模式统一刷新走势图
        if (chartMode === 'yearly') {
            updateYearlyChart(currentProduct);
        } else if (chartMode === 'period') {
            updatePriceChart(currentProduct, currentPeriod);
        } else {
            updatePriceChartByMonth(currentProduct, currentYear, currentMonth);
        }
    }, function() {
        if (currentProduct !== product || currentYear !== targetYear) return;
        renderEmptyMonth(currentYear, currentMonth);
    });
}

// 重建年份/月份选择器，并按指定年月刷新表格与日期区间计算器
function renderMonthView(data, year, month) {
    initYearSelector();
    initMonthTabs();
    showMonthData(data, year, month);
    initDateRangeCalculator(year, month);
}

// 初始化年份下拉菜单
function initYearSelector() {
    var yearSelect = $('#year-select');
    yearSelect.empty();
    
    availableYears.forEach(year => {
        var selected = year === currentYear ? 'selected' : '';
        yearSelect.append(`<option value="${year}" ${selected}>${year}年</option>`);
    });
}

// 初始化月份标签
function initMonthTabs() {
    var monthTabs = $('#month-tabs');
    monthTabs.empty();
    
    for (var i = 0; i < 12; i++) {
        var monthName = (i + 1) + '月';
        var activeClass = i === currentMonth ? 'active' : '';
        monthTabs.append(`
            <span class="month-tab ${activeClass}" data-month="${i}" onclick="selectMonth(${i})">
                ${monthName}
            </span>
        `);
    }
}

// 选择年份（未加载的年份通过 AJAX 按需获取）
function changeYear(year) {
    currentYear = parseInt(year, 10);
    chartMode = 'month';
    saveFrontendState();

    if (!currentProduct) {
        renderMonthView([], currentYear, currentMonth);
        return;
    }

    var cache = historyCache[currentProduct] || {};
    if (cache[currentYear]) {
        finishYearChange(cache[currentYear]);
        return;
    }

    // 该年份尚未加载：先展示加载态，取回数据后再渲染
    setHistoryLoading(currentYear + '年数据加载中...');
    var product = currentProduct;
    var targetYear = currentYear;
    loadYearData(product, targetYear, function(rows) {
        if (currentProduct !== product || currentYear !== targetYear) return;
        window.currentHistoryData = rows;
        finishYearChange(rows);
    }, function() {
        if (currentProduct === product && currentYear === targetYear) {
            renderEmptyMonth(currentYear, currentMonth);
        }
    });
}

function finishYearChange(rows) {
    window.currentHistoryData = rows;
    // 优先保留当前月份，若该月份无数据则回退到该年有数据的最晚月份
    currentMonth = findBestMonth(rows, currentYear, currentMonth);
    renderMonthView(rows, currentYear, currentMonth);
    updatePriceChartByMonth(currentProduct, currentYear, currentMonth);
}

// 选择月份
function selectMonth(month) {
    currentMonth = month;
    chartMode = 'month';
    saveFrontendState();

    var cache = historyCache[currentProduct] || {};
    if (currentYear in cache) {
        window.currentHistoryData = cache[currentYear];
        renderMonthView(window.currentHistoryData, currentYear, currentMonth);
        updatePriceChartByMonth(currentProduct, currentYear, currentMonth);
        return;
    }

    // 年份数据仍在加载中：等加载完成后再按所选月份渲染
    var targetYear = currentYear;
    loadYearData(currentProduct, targetYear, function(rows) {
        if (currentYear !== targetYear) return;
        window.currentHistoryData = rows;
        renderMonthView(rows, currentYear, currentMonth);
        updatePriceChartByMonth(currentProduct, currentYear, currentMonth);
    });
}

// 显示指定月份的数据（分两列，每列最多16行）
function showMonthData(sortedHistory, year, month) {
    var leftBody = $('#history-table-body-left');
    var rightBody = $('#history-table-body-right');
    leftBody.empty();
    rightBody.empty();

    // 生成当月所有日期
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var monthData = [];
    var dataCount = 0;
    for (var day = 1; day <= daysInMonth; day++) {
        var dateStr = toDateStr(year, month, day);
        var item = sortedHistory.find(it => it.trade_date === dateStr);
        if (item) {
            monthData.push(item);
            dataCount++;
        } else {
            monthData.push({
                trade_date: dateStr,
                low_price: null,
                high_price: null,
                avg_price: null,
                change_value: null
            });
        }
    }

    $('#history-total').text('当月共 ' + daysInMonth + ' 天，有数据 ' + dataCount + ' 条');

    // 左列最多16行，剩余放右列
    var leftData = monthData.slice(0, 16);
    var rightData = monthData.slice(16, 32);

    renderHistoryRows(leftData, leftBody);
    renderHistoryRows(rightData, rightBody);
}

// 渲染历史数据行
function renderHistoryRows(data, tbody) {
    data.forEach(item => {
        // 无数据时显示占位符
        if (item.avg_price === null || item.avg_price === undefined) {
            var row = `
                <tr class="row-neutral">
                    <td title="${escapeHtml(item.trade_date)}">${escapeHtml(item.trade_date)}</td>
                    <td class="col-price-range text-muted" title="-">-</td>
                    <td class="text-muted" title="-">-</td>
                    <td class="text-muted" title="-">-</td>
                </tr>
            `;
            tbody.append(row);
            return;
        }

        var changeClass = '';
        var rowClass = '';
        var changeSign = '';

        if (item.change_value > 0) {
            changeClass = 'change-up';
            rowClass = 'row-up';
            changeSign = '+' + formatNumber(item.change_value);
        } else if (item.change_value < 0) {
            changeClass = 'change-down';
            rowClass = 'row-down';
            changeSign = formatNumber(item.change_value);
        } else {
            changeClass = 'change-neutral';
            rowClass = 'row-neutral';
            changeSign = item.change_value == null ? '-' : formatNumber(item.change_value);
        }

        var row = `
            <tr class="${rowClass}">
                <td title="${escapeHtml(item.trade_date)}">${escapeHtml(item.trade_date)}</td>
                <td class="col-price-range" title="${formatNumber(item.low_price)} - ${formatNumber(item.high_price)}">${formatNumber(item.low_price)} - ${formatNumber(item.high_price)}</td>
                <td title="${formatNumber(item.avg_price)}">${formatNumber(item.avg_price)}</td>
                <td class="${changeClass}" title="${changeSign}">${changeSign}</td>
            </tr>
        `;
        tbody.append(row);
    });
}

// 日期格式化 YYYY-MM-DD
function formatDate(date) {
    return toDateStr(date.getFullYear(), date.getMonth(), date.getDate());
}

// 渲染无数据月份的完整日期表格（所有日期显示为 -），保持与 zinc1 有数据时一致的列表结构
function renderEmptyMonth(year, month) {
    // 已有年份信息时保留产品真实年份；仅在完全没有年份数据时回退到最近 5 年
    if (!availableYears || availableYears.length === 0) {
        availableYears = [];
        for (var y = new Date().getFullYear(); y >= new Date().getFullYear() - 4; y--) {
            availableYears.push(y);
        }
    }
    if (availableYears.indexOf(year) === -1) {
        year = availableYears[0];
        currentYear = year;
    }

    renderMonthView([], year, month);
    updatePriceChartByMonth(currentProduct, year, month);
}

// 选择指定年份下最优月份：优先使用当前月份，无数据则回退到该年有数据的最晚月份
function findBestMonth(sortedHistory, year, preferredMonth) {
    var monthsWithData = new Set();
    sortedHistory.forEach(function(item) {
        var parts = item.trade_date.split('-');
        if (parts.length >= 2 && parseInt(parts[0], 10) === year) {
            monthsWithData.add(parseInt(parts[1], 10) - 1); // 0-based
        }
    });

    if (monthsWithData.size === 0) {
        return 0;
    }
    if (monthsWithData.has(preferredMonth)) {
        return preferredMonth;
    }
    return Math.max.apply(null, Array.from(monthsWithData));
}

// 初始化日期区间计算器默认值（当前选中月份）
function initDateRangeCalculator(year, month) {
    var startDate = new Date(year, month, 1);
    var endDate = new Date(year, month + 1, 0);
    $('#range-start-date').val(formatDate(startDate));
    $('#range-end-date').val(formatDate(endDate));
    calculateDateRangeAverage();
}

// 打印当前报价
function printCurrentQuote() {
    // 同步打印区域的标题和统计数据
    $('#print-product-name').text($('#chart-product-name').text());
    $('#print-high').text($('#chart-high').text());
    $('#print-low').text($('#chart-low').text());
    $('#print-monthly-avg').text($('#chart-monthly-avg').text());
    $('#print-change').text($('#chart-change').text());
    window.print();
}

// 日期区间平均价格计算器
function calculateDateRangeAverage() {
    var startDate = $('#range-start-date').val();
    var endDate = $('#range-end-date').val();

    if (!startDate || !endDate) {
        return;
    }

    if (startDate > endDate) {
        notify('开始日期不能晚于结束日期');
        return;
    }

    var startYear = startDate.slice(0, 4);
    var endYear = endDate.slice(0, 4);
    var cache = historyCache[currentProduct] || {};

    // 同一年且该年数据已缓存：本地计算，避免额外请求
    if (startYear === endYear && cache[startYear]) {
        applyRangeResult(aggregateRows(cache[startYear], startDate, endDate));
        return;
    }

    // 跨年份或该年份数据未加载：交由服务端聚合，避免为区间统计加载全部历史
    if (!currentProduct) {
        applyRangeResult({ count: 0 });
        return;
    }

    requestJSON(
        '/api/price/range?product=' + encodeURIComponent(currentProduct) +
        '&start=' + encodeURIComponent(startDate) + '&end=' + encodeURIComponent(endDate),
        rangeReq,
        10000
    ).then(function(data) {
        applyRangeResult({
            count: data.count || 0,
            avg: data.avg_price,
            high: data.high_price,
            low: data.low_price
        });
    }).catch(function(error) {
        if (error.name === 'AbortError') return;
        console.error('区间均价计算失败:', error);
        applyRangeResult({ count: 0 });
    });
}

// 在已加载的年度数据中统计区间均价（仅统计有报价的日期）
function aggregateRows(rows, startDate, endDate) {
    var total = 0;
    var validCount = 0;
    var high = -Infinity;
    var low = Infinity;

    (rows || []).forEach(function(item) {
        if (item.trade_date < startDate || item.trade_date > endDate) return;
        if (item.avg_price == null) return;
        total += item.avg_price;
        validCount++;
        if (item.avg_price > high) high = item.avg_price;
        if (item.avg_price < low) low = item.avg_price;
    });

    return {
        count: validCount,
        avg: validCount > 0 ? total / validCount : null,
        high: validCount > 0 ? high : null,
        low: validCount > 0 ? low : null
    };
}

function applyRangeResult(result) {
    var count = result.count || 0;
    $('#range-count').text(count);
    if (count === 0 || result.avg == null) {
        $('#range-avg').text('-');
        $('#range-high').text('-');
        $('#range-low').text('-');
        return;
    }
    $('#range-avg').text(formatWithUnit(result.avg));
    $('#range-high').text(formatWithUnit(result.high));
    $('#range-low').text(formatWithUnit(result.low));
}



// 更新图表产品信息
function updateChartProductInfo(product) {
    var productName = product;
    var productInfo = productList.find(p => p.code === product);
    if (productInfo) {
        productName = productInfo.name;
    }
    $('#chart-product-name').text(productName);
    // 产品切换后同步刷新列表表头单位与走势图 Y 轴标题
    updateUnitDisplays();
}

// 加载并渲染产品分类标签，优先返回有数据的产品
function loadProductTabs() {
    return requestJSON('/api/price/products', null, 10000)
        .then(data => {
            // 站点设置与最后更新时间随产品列表一起返回（同一响应），不再单独请求
            applySiteSettings(data.settings);
            applyLastUpdate(data.last_update, data.last_trade_date);

            if (data.products && data.products.length > 0) {
                productList = data.products;
                // 从后端读取默认首页产品，若未设置或不存在则回退到首个有数据的产品
                const configuredHome = data.homepage_product || '';
                const homepageExists = productList.find(p => p.code === configuredHome);
                const firstWithData = productList.find(p => p.record_count > 0);
                // 优先恢复上次选中的产品（若仍存在），否则按默认规则选择
                const savedProduct = (savedState && savedState.product) ? savedState.product : '';
                const savedProductExists = productList.find(p => p.code === savedProduct);
                const selectedCode = savedProductExists
                    ? savedProduct
                    : (homepageExists ? configuredHome : (firstWithData ? firstWithData.code : data.products[0].code));

                renderProductTabs(data.products, selectedCode);
                return selectedCode;
            } else {
                $('#product-tabs').html('<div class="product-tab active">暂无产品</div>');
                return null;
            }
        })
        .catch(error => {
            console.error('加载产品分类失败:', error);
            $('#product-tabs').html('<div class="product-tab active">加载失败</div>');
            return null;
        });
}

// 渲染产品分类标签
function renderProductTabs(products, activeCode) {
    var tabsHtml = '';
    products.slice().sort(function(a, b) {
        return (a.sort_order || 0) - (b.sort_order || 0);
    }).forEach(function(product) {
        var isActive = product.code === activeCode;
        tabsHtml += `<div class="product-tab ${isActive ? 'active' : ''}" data-product="${escapeHtml(product.code)}">${escapeHtml(product.name)}</div>`;
    });
    $('#product-tabs').html(tabsHtml);
}

// HTML 转义与轻提示（toast）见 shared.js

// ===== 价格走势图：自绘 SVG，零依赖（省掉图表库的请求、解析与执行开销） =====
// 待绘制数据：{ labels, prices, avgValue, seriesLabel, avgLabel, xTitle, colors, avgColor }
var chartData = null;
// 最近一次绘制的几何信息，供 hover 命中计算使用
var chartGeom = null;
var chartResizeObserver = null;
var chartThemeBound = false;
var chartHoverBound = false;
var chartRenderFrame = 0;
// 最近一次渲染时的容器尺寸：ResizeObserver 注册后会立即回调一次，
// 用它跳过尺寸未变化的重复绘制（首屏 SVG 只画一遍）
var chartLastWidth = 0;
var chartLastHeight = 0;

// 坐标数值保留两位小数，避免 SVG 属性里出现超长小数或科学计数法
function svgNum(n) { return Math.round(n * 100) / 100; }

// SVG 取不到 CSS 变量的计算值，深浅色下的文字/网格配色按系统偏好显式给定
function getChartTheme() {
    var dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    return dark
        ? { text: '#ecf0f1', grid: 'rgba(255, 255, 255, 0.12)', border: 'rgba(255, 255, 255, 0.2)', pointBorder: '#2c3e50' }
        : { text: '#2c3e50', grid: 'rgba(0, 0, 0, 0.08)', border: 'rgba(0, 0, 0, 0.1)', pointBorder: '#fff' };
}

// 估算文本宽度（11px 字号）：中日韩字符按 1em，其余按 0.55em
function estimateTextWidth(text, size) {
    var width = 0;
    for (var i = 0; i < text.length; i++) {
        width += text.charCodeAt(i) > 255 ? size : size * 0.55;
    }
    return width;
}

// 平滑曲线：Catmull-Rom 转三次贝塞尔，0.2 系数约等于 Chart.js 的 tension 0.4
function buildSmoothPath(pts) {
    if (!pts.length) return '';
    if (pts.length === 1) return 'M' + svgNum(pts[0].x) + ',' + svgNum(pts[0].y);
    var t = 0.2;
    var d = 'M' + svgNum(pts[0].x) + ',' + svgNum(pts[0].y);
    for (var i = 0; i < pts.length - 1; i++) {
        var p0 = pts[i - 1] || pts[i];
        var p1 = pts[i];
        var p2 = pts[i + 1];
        var p3 = pts[i + 2] || p2;
        var c1x = p1.x + (p2.x - p0.x) * t;
        var c1y = p1.y + (p2.y - p0.y) * t;
        var c2x = p2.x - (p3.x - p1.x) * t;
        var c2y = p2.y - (p3.y - p1.y) * t;
        d += ' C' + svgNum(c1x) + ',' + svgNum(c1y) + ' ' + svgNum(c2x) + ',' + svgNum(c2y) +
            ' ' + svgNum(p2.x) + ',' + svgNum(p2.y);
    }
    return d;
}

// 按当前数据与容器尺寸重绘 SVG
function renderSvgChart() {
    var host = document.getElementById('price-chart');
    if (!host) return;

    var labels = chartData ? chartData.labels : [];
    var prices = chartData ? chartData.prices : [];

    // 空数据：清空图表，占位文案居中
    if (!labels.length || !prices.length) {
        chartGeom = null;
        host.innerHTML = '<div class="chart-empty">暂无数据</div>';
        return;
    }

    var width = host.clientWidth || 600;
    var height = host.clientHeight || 260;
    chartLastWidth = width;
    chartLastHeight = height;
    var theme = getChartTheme();
    var unit = getCurrentUnit();
    var pad = { top: 26, right: 14, bottom: 42, left: 56 };
    var plotW = Math.max(20, width - pad.left - pad.right);
    var plotH = Math.max(20, height - pad.top - pad.bottom);
    var baseline = pad.top + plotH;

    // Y 轴范围：按数据（含均价参考线）上下留 10% 余量，再按 100 取整
    var avgValue = (typeof chartData.avgValue === 'number' && isFinite(chartData.avgValue)) ? chartData.avgValue : null;
    var min = prices[0];
    var max = prices[0];
    for (var i = 1; i < prices.length; i++) {
        if (prices[i] < min) min = prices[i];
        if (prices[i] > max) max = prices[i];
    }
    if (avgValue !== null) {
        min = Math.min(min, avgValue);
        max = Math.max(max, avgValue);
    }
    if (max === min) { min -= 50; max += 50; }
    var margin = (max - min) * 0.1;
    var yMin = Math.max(0, Math.floor((min - margin) / 100) * 100);
    var yMax = Math.ceil((max + margin) / 100) * 100;
    if (yMax <= yMin) yMax = yMin + 100;

    // 刻度步长默认 100，区间过大时按 100 的整数倍放大，网格线最多约 7 条
    var step = 100;
    if ((yMax - yMin) / step > 6) step = Math.ceil((yMax - yMin) / 6 / 100) * 100;

    function xAt(index) {
        return labels.length === 1 ? pad.left + plotW / 2 : pad.left + plotW * index / (labels.length - 1);
    }
    function yAt(value) {
        return pad.top + plotH * (1 - (value - yMin) / (yMax - yMin));
    }

    var points = [];
    for (var k = 0; k < prices.length; k++) points.push({ x: xAt(k), y: yAt(prices[k]) });

    var linePath = buildSmoothPath(points);
    var areaPath = points.length > 1
        ? linePath + ' L' + svgNum(points[points.length - 1].x) + ',' + svgNum(baseline) +
          ' L' + svgNum(points[0].x) + ',' + svgNum(baseline) + ' Z'
        : '';

    var mainColor = (chartData.colors && chartData.colors.border) || '#3498db';
    var pointColor = (chartData.colors && chartData.colors.point) || '#3498db';
    var avgColor = chartData.avgColor || '#e74c3c';
    var mainName = (chartData.seriesLabel || '日均价').split(/[ (（]/)[0];
    var avgName = (chartData.avgLabel || '均价').split(/[:：]/)[0];

    var svg = [];
    svg.push('<svg class="price-chart-svg" viewBox="0 0 ' + width + ' ' + height + '" aria-label="' + escapeHtml(chartData.seriesLabel || '') + '">');
    svg.push('<defs><linearGradient id="pc-area-grad" x1="0" y1="0" x2="0" y2="1">');
    svg.push('<stop offset="0%" stop-color="' + mainColor + '" stop-opacity="0.28"/>');
    svg.push('<stop offset="100%" stop-color="' + mainColor + '" stop-opacity="0"/>');
    svg.push('</linearGradient></defs>');

    // 顶部图例：主序列 + 均价参考线
    var legendItems = [
        { text: mainName, color: mainColor, dash: '' },
        { text: chartData.avgLabel || '均价参考线', color: avgColor, dash: '5 4' }
    ];
    var legendGap = 18;
    var legendWidths = legendItems.map(function(item) { return 19 + estimateTextWidth(item.text, 11); });
    var legendTotal = legendWidths[0] + legendWidths[1] + legendGap;
    var legendX = Math.max(pad.left, (width - legendTotal) / 2);
    var legendY = 15;
    legendItems.forEach(function(item, index) {
        if (index > 0) legendX += legendGap;
        svg.push('<line x1="' + svgNum(legendX) + '" y1="' + legendY + '" x2="' + svgNum(legendX + 14) +
            '" y2="' + legendY + '" stroke="' + item.color + '" stroke-width="3" stroke-linecap="round"' +
            (item.dash ? ' stroke-dasharray="' + item.dash + '"' : '') + '/>');
        legendX += 19;
        svg.push('<text x="' + svgNum(legendX) + '" y="' + (legendY + 4) + '" font-size="11" fill="' +
            theme.text + '">' + escapeHtml(item.text) + '</text>');
        legendX += estimateTextWidth(item.text, 11);
    });

    // Y 轴网格与刻度
    for (var v = yMin; v <= yMax + 0.01; v += step) {
        var gy = yAt(v);
        svg.push('<line x1="' + pad.left + '" y1="' + svgNum(gy) + '" x2="' + (width - pad.right) + '" y2="' +
            svgNum(gy) + '" stroke="' + theme.grid + '" stroke-width="1"/>');
        svg.push('<text x="' + (pad.left - 8) + '" y="' + svgNum(gy + 3.5) +
            '" text-anchor="end" font-size="10" fill="' + theme.text + '">' +
            Math.round(v).toLocaleString('zh-CN') + '</text>');
    }

    // 轴线
    svg.push('<line x1="' + pad.left + '" y1="' + pad.top + '" x2="' + pad.left + '" y2="' + baseline +
        '" stroke="' + theme.border + '" stroke-width="1"/>');
    svg.push('<line x1="' + pad.left + '" y1="' + baseline + '" x2="' + (width - pad.right) + '" y2="' +
        baseline + '" stroke="' + theme.border + '" stroke-width="1"/>');

    // X 轴刻度：按可用宽度控制标签密度，最多 12 个；末端刻度必须标注，避免与时间区间末日不一致
    var maxLabels = Math.max(2, Math.min(12, Math.floor(plotW / 56)));
    var xStep = Math.max(1, Math.ceil(labels.length / maxLabels));
    var tickIndexes = [];
    for (var xi = 0; xi < labels.length; xi += xStep) tickIndexes.push(xi);
    var lastIndex = labels.length - 1;
    if (tickIndexes[tickIndexes.length - 1] !== lastIndex) {
        // 与倒数第二个刻度过近时直接替换，避免文字重叠
        if (tickIndexes.length > 1 && lastIndex - tickIndexes[tickIndexes.length - 2] < xStep * 0.6) {
            tickIndexes.pop();
        }
        tickIndexes.push(lastIndex);
    }
    tickIndexes.forEach(function(index) {
        svg.push('<text x="' + svgNum(xAt(index)) + '" y="' + (baseline + 14) +
            '" text-anchor="middle" font-size="10" fill="' + theme.text + '">' +
            escapeHtml(labels[index]) + '</text>');
    });

    // 轴标题
    svg.push('<text x="' + svgNum(pad.left + plotW / 2) + '" y="' + (height - 6) +
        '" text-anchor="middle" font-size="11" font-weight="bold" fill="' + theme.text + '">' +
        escapeHtml(chartData.xTitle || '') + '</text>');
    var yTitle = '价格' + (unit ? ' (' + unit + ')' : '');
    svg.push('<text transform="rotate(-90 12 ' + svgNum(pad.top + plotH / 2) + ')" x="12" y="' +
        svgNum(pad.top + plotH / 2) + '" text-anchor="middle" font-size="11" font-weight="bold" fill="' +
        theme.text + '">' + escapeHtml(yTitle) + '</text>');

    // 面积填充 → 折线 → 均价虚线 → 数据点（点过多时省略圆点，靠 hover 高亮定位）
    if (areaPath) svg.push('<path d="' + areaPath + '" fill="url(#pc-area-grad)" stroke="none"/>');
    if (points.length > 1) {
        svg.push('<path d="' + linePath + '" fill="none" stroke="' + mainColor +
            '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>');
    }
    if (avgValue !== null) {
        var ay = yAt(avgValue);
        svg.push('<line x1="' + pad.left + '" y1="' + svgNum(ay) + '" x2="' + (width - pad.right) + '" y2="' +
            svgNum(ay) + '" stroke="' + avgColor + '" stroke-width="2" stroke-dasharray="5 5"/>');
    }
    if (points.length <= 45) {
        points.forEach(function(p) {
            svg.push('<circle cx="' + svgNum(p.x) + '" cy="' + svgNum(p.y) + '" r="3.5" fill="' + pointColor +
                '" stroke="' + theme.pointBorder + '" stroke-width="2"/>');
        });
    }

    // hover 辅助元素（默认隐藏，由指针事件驱动）
    svg.push('<line id="pc-hover-line" x1="0" y1="' + pad.top + '" x2="0" y2="' + baseline +
        '" stroke="' + theme.border + '" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>');
    svg.push('<circle id="pc-hover-dot" r="5" cx="0" cy="0" fill="' + pointColor +
        '" stroke="' + theme.pointBorder + '" stroke-width="2" style="display:none"/>');
    svg.push('</svg>');
    svg.push('<div class="chart-tooltip" style="display:none"></div>');

    host.innerHTML = svg.join('');
    chartGeom = {
        width: width,
        height: height,
        pad: pad,
        plotW: plotW,
        baseline: baseline,
        points: points,
        labels: labels,
        prices: prices,
        avgValue: avgValue,
        mainColor: mainColor,
        avgColor: avgColor,
        mainName: mainName,
        avgName: avgName
    };

    bindChartResize();
    bindChartTheme();
    bindChartHover();
}

// 容器尺寸变化（窗口缩放、布局切换）时按帧合并重绘
function bindChartResize() {
    if (chartResizeObserver || !window.ResizeObserver) return;
    var host = document.getElementById('price-chart');
    if (!host) return;
    chartResizeObserver = new ResizeObserver(function() {
        if (!chartData || chartRenderFrame) return;
        // 尺寸未变化时无需重绘（含注册后的首次回调）
        if (host.clientWidth === chartLastWidth && host.clientHeight === chartLastHeight) return;
        chartRenderFrame = requestAnimationFrame(function() {
            chartRenderFrame = 0;
            renderSvgChart();
        });
    });
    chartResizeObserver.observe(host);
}

// 系统深浅色切换时重绘，同步文字/网格配色
function bindChartTheme() {
    if (chartThemeBound || !window.matchMedia) return;
    chartThemeBound = true;
    var query = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function() { renderSvgChart(); };
    if (query.addEventListener) query.addEventListener('change', onChange);
    else if (query.addListener) query.addListener(onChange);
}

function bindChartHover() {
    if (chartHoverBound) return;
    var host = document.getElementById('price-chart');
    if (!host) return;
    chartHoverBound = true;
    host.addEventListener('pointermove', onChartPointerMove);
    host.addEventListener('pointerleave', hideChartTooltip);
}

function hideChartTooltip() {
    var host = document.getElementById('price-chart');
    if (!host) return;
    var line = host.querySelector('#pc-hover-line');
    var dot = host.querySelector('#pc-hover-dot');
    var tooltip = host.querySelector('.chart-tooltip');
    if (line) line.style.display = 'none';
    if (dot) dot.style.display = 'none';
    if (tooltip) tooltip.style.display = 'none';
}

// 按指针位置命中最近数据点，定位辅助线与 tooltip
function onChartPointerMove(event) {
    var g = chartGeom;
    var host = document.getElementById('price-chart');
    if (!g || !host) return;
    var svg = host.querySelector('svg');
    if (!svg) return;
    var rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    // 事件坐标换算回 viewBox 坐标
    var x = (event.clientX - rect.left) * (g.width / rect.width);

    // 只在绘图区内响应，避免坐标轴/图例上出现游离的 tooltip
    if (x < g.pad.left - 8 || x > g.width - g.pad.right + 8) {
        hideChartTooltip();
        return;
    }

    var index = g.points.length > 1
        ? Math.round((x - g.pad.left) / g.plotW * (g.points.length - 1))
        : 0;
    index = Math.max(0, Math.min(g.points.length - 1, index));
    var point = g.points[index];

    var line = host.querySelector('#pc-hover-line');
    var dot = host.querySelector('#pc-hover-dot');
    var tooltip = host.querySelector('.chart-tooltip');
    if (!line || !dot || !tooltip) return;

    line.setAttribute('x1', point.x);
    line.setAttribute('x2', point.x);
    line.style.display = '';
    dot.setAttribute('cx', point.x);
    dot.setAttribute('cy', point.y);
    dot.style.display = '';

    var html = '<div class="chart-tooltip-title">日期: ' + escapeHtml(g.labels[index]) + '</div>' +
        '<div class="chart-tooltip-row"><i style="background:' + g.mainColor + '"></i>' +
        escapeHtml(g.mainName) + ': ' + escapeHtml(formatWithUnit(g.prices[index])) + '</div>';
    if (g.avgValue !== null) {
        html += '<div class="chart-tooltip-row"><i style="background:' + g.avgColor + '"></i>' +
            escapeHtml(g.avgName) + ': ' + escapeHtml(formatWithUnit(g.avgValue)) + '</div>';
    }
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';

    // 换算成 CSS 像素后定位，左右收敛避免 tooltip 溢出容器
    var cssX = point.x / g.width * rect.width;
    var cssY = point.y / g.height * rect.height;
    var half = tooltip.offsetWidth / 2 + 4;
    cssX = Math.max(half, Math.min(rect.width - half, cssX));
    tooltip.style.left = cssX + 'px';
    tooltip.style.top = Math.max(tooltip.offsetHeight + 6, cssY - 10) + 'px';
}

// 根据走势图模式切换统计项文案，避免年视图仍显示“本月/当月”
function setChartStatLabels(mode) {
    var labels = {
        month: ['本月最高', '本月最低', '当月均价', '当月涨跌'],
        yearly: ['年最高', '年最低', '年均价', '年涨跌'],
        period: ['区间最高', '区间最低', '区间均价', '区间涨跌']
    }[mode] || ['最高', '最低', '均价', '涨跌'];
    $('#chart-high-label').text(labels[0]);
    $('#chart-low-label').text(labels[1]);
    $('#chart-monthly-avg-label').text(labels[2]);
    $('#chart-change-label').text(labels[3]);
}

// 更新走势图下方统计信息
function updateChartStats(highPrice, lowPrice, avgPrice, latestPrice, prevPrice, firstPrice) {
    // 当月涨跌 = 首日 → 末日变化率（首末日数据均有效时优先使用）
    var changePercent;
    if (firstPrice !== undefined && firstPrice > 0) {
        changePercent = (latestPrice - firstPrice) / firstPrice * 100;
    } else if (prevPrice != null && prevPrice !== 0) {
        changePercent = (latestPrice - prevPrice) / prevPrice * 100;
    } else {
        changePercent = 0;
    }
    $('#chart-high').text(formatWithUnit(highPrice));
    $('#chart-low').text(formatWithUnit(lowPrice));
    $('#chart-monthly-avg').text(formatWithUnit(avgPrice));

    var changeElement = $('#chart-change');
    // 仅正值加 "+" 前缀；0 显示 "0.00%"，负值自带 "-"
    changeElement.text((changePercent > 0 ? '+' : '') + changePercent.toFixed(2) + '%');
    changeElement.removeClass('text-success text-danger');
    if (changePercent > 0) {
        changeElement.addClass('text-success');
    } else if (changePercent < 0) {
        changeElement.addClass('text-danger');
    }
}

// 走势图统一渲染核心：接收已排序好的 labels/prices 与参考线取值
// opts: { labels, prices, avgValue, seriesLabel, avgLabel, xTitle, colors, avgColor }
function applyChartSeries(opts) {
    var labels = opts.labels || [];
    var prices = opts.prices || [];

    // 空数据：清空图表、统计项与时间区间
    if (labels.length === 0) {
        chartData = null;
        renderSvgChart();
        setChartRange(null, null);
        $('#chart-high').text('-');
        $('#chart-low').text('-');
        $('#chart-monthly-avg').text('-');
        $('#chart-change').text('-').removeClass('text-success text-danger');
        return;
    }

    var highPrice = -Infinity;
    var lowPrice = Infinity;
    for (var i = 0; i < prices.length; i++) {
        if (prices[i] > highPrice) highPrice = prices[i];
        if (prices[i] < lowPrice) lowPrice = prices[i];
    }

    // 数据与几何计算解耦：先存下当前序列，再按容器尺寸整体重绘 SVG
    chartData = opts;
    renderSvgChart();
    setChartRange(opts.rangeStart, opts.rangeEnd, opts.rangeUnit);

    // 更新统计信息（涨跌 = 首点 → 末点变化率）
    var latestPrice = prices[prices.length - 1];
    var prevPrice = prices.length > 1 ? prices[prices.length - 2] : latestPrice;
    var firstPrice = prices[0];
    updateChartStats(highPrice, lowPrice, opts.avgValue, latestPrice, prevPrice, firstPrice);
}

// 走势图头部时间区间：同年只在起始处带年份，跨年两端都带年份
// unit 为 'month' 时只显示到月（年走势图的月均价没有具体日期）
function formatChartRange(start, end, unit) {
    if (!start || !end) return '';
    var s = String(start).split('-');
    var e = String(end).split('-');
    if (s.length < 2 || e.length < 2) return '';

    var sm = parseInt(s[1], 10);
    var em = parseInt(e[1], 10);
    var startText = s[0] + '年' + sm + '月';
    var endText = (s[0] === e[0] ? '' : e[0] + '年') + em + '月';

    if (unit !== 'month' && s.length >= 3 && e.length >= 3) {
        startText += parseInt(s[2], 10) + '日';
        endText += parseInt(e[2], 10) + '日';
    }
    return startText + '-' + endText;
}

// 时间区间只在有数据时展示，空态清空避免残留上一组区间
function setChartRange(start, end, unit) {
    $('#chart-range').text(formatChartRange(start, end, unit));
}

// 渲染走势图数据（日均价 + 月均价参考线）
function renderPriceChart(history, product, period, labelSuffix) {
    labelSuffix = labelSuffix || '';
    // 月份视图与按周期视图的统计文案不同
    setChartStatLabels(chartMode === 'month' ? 'month' : 'period');

    // 按日期倒序排序后截取最近 period 条，再按正序排列（字符串比较，避免 new Date 时区陷阱）
    var sortedHistory = (history || [])
        .filter(function(item) { return item.avg_price > 0; })
        .sort(function(a, b) { return b.trade_date.localeCompare(a.trade_date); })
        .slice(0, period)
        .sort(function(a, b) { return a.trade_date.localeCompare(b.trade_date); });

    var dates = [];
    var prices = [];
    var totalPrice = 0;
    sortedHistory.forEach(function(item) {
        dates.push(item.trade_date.substring(5)); // 只显示月-日
        prices.push(item.avg_price);
        totalPrice += item.avg_price;
    });

    // 计算区间均价
    var monthlyAvg = totalPrice / (sortedHistory.length || 1);

    applyChartSeries({
        labels: dates,
        prices: prices,
        avgValue: monthlyAvg,
        seriesLabel: '日均价 (' + product.toUpperCase() + labelSuffix + ')',
        avgLabel: (chartMode === 'month' ? '当月均价: ' : '区间均价: ') + formatWithUnit(monthlyAvg),
        xTitle: '日期 (月-日)',
        // 时间区间取实际有数据的首末日期，而非自然月/自然周期
        rangeStart: sortedHistory.length ? sortedHistory[0].trade_date : '',
        rangeEnd: sortedHistory.length ? sortedHistory[sortedHistory.length - 1].trade_date : ''
    });
}

// 渲染年走势图（月均价 + 年均价参考线）
function renderYearlyChart(monthlyData, product) {
    setChartStatLabels('yearly');

    // 过滤掉无月均价的数据点，避免 NaN / ±∞ 参与计算与展示
    var validData = (monthlyData || []).filter(function(item) {
        return item && item.avg_price !== null && item.avg_price !== undefined && !isNaN(item.avg_price);
    });

    // 按年月正序排列
    var sortedData = validData.slice().sort(function(a, b) {
        return a.year_month.localeCompare(b.year_month);
    });

    var labels = [];
    var prices = [];
    var totalPrice = 0;
    sortedData.forEach(function(item) {
        labels.push(item.year_month);
        prices.push(item.avg_price);
        totalPrice += item.avg_price;
    });

    // 计算年均价
    var yearlyAvg = totalPrice / (sortedData.length || 1);

    applyChartSeries({
        labels: labels,
        prices: prices,
        avgValue: yearlyAvg,
        seriesLabel: '月均价 (' + product.toUpperCase() + ')',
        avgLabel: '年均价: ' + formatWithUnit(yearlyAvg),
        xTitle: '月份',
        colors: { border: '#3498db', point: '#3498db' },
        avgColor: '#e74c3c',
        // 年走势按月展示，时间区间只精确到月
        rangeStart: sortedData.length ? sortedData[0].year_month : '',
        rangeEnd: sortedData.length ? sortedData[sortedData.length - 1].year_month : '',
        rangeUnit: 'month'
    });
}

// 按年份更新走势图（使用所选年份的月均价和年均价）
function updateYearlyChart(product) {
    chartMode = 'yearly';
    // 取消尚未完成的周期/月份走势请求，避免旧响应覆盖年度视图
    if (chartReq.current) { chartReq.current.abort(); chartReq.current = null; }
    // 高亮年走势标签
    highlightPeriodTab(365);

    // 年走势随年份选择器：以该年 12 月为上限取最近 12 条，再过滤掉跨年回补的月份
    var year = currentYear;
    requestJSON('/api/price/monthly?product=' + encodeURIComponent(product) +
        '&month=' + year + '-12&limit=12', chartReq, 10000)
        .then(function(data) {
            var list = (data && data.monthly) || [];
            renderYearlyChart(list.filter(function(item) {
                return item && item.year_month && item.year_month.indexOf(year + '-') === 0;
            }), product);
        })
        .catch(function(error) {
            if (error.name === 'AbortError') return; // 已被新的走势图请求取代
            console.error('获取月均价数据失败:', error);
            renderYearlyChart([], product);
        });
}

// 按月份更新走势图
function updatePriceChartByMonth(product, year, month) {
    chartMode = 'month';
    // 取消尚未完成的周期/年度走势请求，避免旧响应覆盖月份视图
    if (chartReq.current) { chartReq.current.abort(); chartReq.current = null; }
    // 月份视图同样属于「月走势」，点亮该标签，让标签状态始终与实际图表一致
    highlightPeriodTab(30);

    var history = window.currentHistoryData || [];
    // 使用字符串比较避免跨时区 Date 解析问题（new Date("YYYY-MM-DD") 在不同时区可能偏移一天）
    var targetPrefix = year + '-' + pad2(month + 1);
    var monthData = history.filter(function(item) {
        return item.trade_date && item.trade_date.startsWith(targetPrefix);
    });
    var labelSuffix = ' - ' + year + '年' + (month + 1) + '月';
    renderPriceChart(monthData, product, 31, labelSuffix);
}

// 更新价格走势图（按周期）
// 服务端按天数裁剪数据，只取图表需要的区间，避免为走势图加载全部历史
function updatePriceChart(product, period) {
    if (typeof period === 'undefined') period = currentPeriod;
    chartMode = 'period';

    // 往年没有「截至今天」的近30天：改用该年有数据的最近30条
    // 年份数据已在切换年份时按需加载并缓存，这里不额外请求
    if (currentYear !== new Date().getFullYear()) {
        var targetYear = currentYear;
        loadYearData(product, targetYear, function(rows) {
            if (currentProduct !== product || currentYear !== targetYear || chartMode !== 'period') return;
            renderPriceChart(rows, product, period);
        }, function() {
            if (currentProduct !== product || currentYear !== targetYear) return;
            renderPriceChart([], product, period);
        });
        return;
    }

    requestJSON(
        '/api/price/history?product=' + encodeURIComponent(product) + '&days=' + period + '&compact=1',
        chartReq,
        10000
    ).then(function(data) {
        renderPriceChart(decodeHistory(data), product, period);
    }).catch(function(error) {
        if (error.name === 'AbortError') return; // 已被新的走势图请求取代
        console.error('获取走势数据失败:', error);
        renderPriceChart([], product, period);
    });
}

// 应用站点设置（数据随 /api/price/products 一并返回，省掉一次额外请求）
function applySiteSettings(settings) {
    if (!settings) return;
    const title = settings.frontend_title || '报价查询系统';
    const sourceName = settings.data_source_name || '数据源';

    document.title = title;
    $('.site-title').text(title);
    $('.data-source-name').text(sourceName);

    // 打印标题使用数据源名称的简称（去掉括号内容）
    const shortName = sourceName.split('（')[0].split('(')[0].trim();
    $('.data-source-name-short').text(shortName);
}

// 应用最后更新时间（同上，随产品列表接口返回）
function applyLastUpdate(lastUpdate, lastTradeDate) {
    if (lastUpdate) {
        // 数据库时间为 UTC，按 UTC 解析后再转为本地时间显示
        var utcStr = lastUpdate.replace(' ', 'T') + 'Z';
        var date = new Date(utcStr);
        $('#last-update').text(date.toLocaleString('zh-CN'));
    } else if (lastTradeDate) {
        $('#last-update').text(lastTradeDate);
    } else {
        $('#last-update').text('-');
    }
}

// 页面加载时执行
$(document).ready(function() {
    // 让出首帧：先让浏览器完成首次绘制，再发起数据请求，避免阻塞 FCP
    requestAnimationFrame(function() {
        setTimeout(function() {
            // 预取历史数据：仅当存在上次选中的产品时预取，与产品列表请求并行，
            // 少一个串行往返。首次访问没有可用产品代码，避免用硬编码产品做无效预取。
            var guessProduct = (savedState && savedState.product) ? savedState.product : '';
            if (guessProduct) loadYearData(guessProduct, currentYear, function() {}, function() {});

            // 从后台加载产品分类，然后初始化第一个产品
            loadProductTabs().then(function(firstProduct) {
                if (firstProduct) {
                    currentProduct = firstProduct;
                    updateChartProductInfo(currentProduct);
                    loadPriceHistory(currentProduct);
                    // loadPriceHistory 内部会根据 chartMode 自动调用走势图更新，无需重复调用
                }
            });
        }, 0);
    });
});
