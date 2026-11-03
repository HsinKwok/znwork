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
            year: currentYear,
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
    highlightPeriodTab(currentPeriod);
    if (currentPeriod === 365) {
        updateYearlyChart(currentProduct);
    } else {
        chartMode = 'period';
        updatePriceChart(currentProduct, currentPeriod);
    }
});

// 数字格式化
function formatNumber(num) {
    return new Intl.NumberFormat('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(num);
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
    if (priceChart) {
        priceChart.options.scales.y.title.text = unit ? '价格 (' + unit + ')' : '价格';
        priceChart.update();
    }
}

// 数字补零为两位字符串
function pad2(n) { return String(n).padStart(2, '0'); }

// 构造 YYYY-MM-DD 日期字符串（month 为 0-based）
function toDateStr(year, month, day) { return year + '-' + pad2(month + 1) + '-' + pad2(day); }

// 高亮指定的图表周期标签（30=月走势，365=年走势）
function highlightPeriodTab(period) {
    $('.chart-period-tab').removeClass('active');
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
var historyReq = { current: null };
var chartReq = { current: null };
var rangeReq = { current: null };

// 历史数据缓存：{ 产品代码: { 年份: 按日期倒序的记录数组 } }
// 首次只加载当前年份，切换年份时再按需 AJAX 加载，避免一次拉取近十年数据
var historyCache = {};

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

// 加载指定产品、指定年份的数据（命中缓存时不再请求）
function loadYearData(product, year, onDone, onError) {
    var cache = historyCache[product] || (historyCache[product] = {});
    if (cache[year]) {
        onDone(cache[year]);
        return;
    }

    var request = requestJSON(
        '/api/price/history?product=' + encodeURIComponent(product) + '&year=' + year,
        historyReq,
        10000
    );
    var myCtrl = historyReq.current; // 用于区分“超时”与“被新请求取代”
    request
        .then(function(data) {
            var rows = (data && Array.isArray(data.history)) ? data.history : [];
            rows.sort(function(a, b) { return b.trade_date.localeCompare(a.trade_date); });
            cache[year] = rows;
            if (currentProduct === product && currentYear === year) {
                window.currentHistoryData = rows;
            }
            onDone(rows);
        })
        .catch(function(error) {
            if (error.name === 'AbortError') {
                if (historyReq.current === myCtrl && onError) onError(error);
                return;
            }
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

    // 首次加载时恢复保存的年份/月份（仅一次）
    if (savedState) {
        if (savedState.year && availableYears.indexOf(savedState.year) !== -1) {
            currentYear = savedState.year;
        }
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

// 价格走势图实例
var priceChart = null;

// Chart.js 按需加载：首屏数据就绪后才注入，避免与首屏资源抢占带宽
var chartLoadPromise = null;
var chartLoading = false;
var pendingChartOpts = null;

function ensureChart() {
    if (window.Chart) return Promise.resolve();
    if (chartLoadPromise) return chartLoadPromise;
    chartLoadPromise = new Promise(function(resolve, reject) {
        var script = document.createElement('script');
        script.src = '/assets/js/chart.min.js?v=3';
        script.onload = function() { resolve(); };
        script.onerror = function() {
            chartLoadPromise = null;
            reject(new Error('chart.min.js 加载失败'));
        };
        document.head.appendChild(script);
    });
    return chartLoadPromise;
}

// Chart.js 不识别 CSS 变量，深浅色下的文字/网格配色需按系统偏好显式给定
function getChartTheme() {
    var dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    return dark
        ? { text: '#ecf0f1', grid: 'rgba(255, 255, 255, 0.12)', border: 'rgba(255, 255, 255, 0.2)', pointBorder: '#2c3e50' }
        : { text: '#2c3e50', grid: 'rgba(0, 0, 0, 0.08)', border: 'rgba(0, 0, 0, 0.1)', pointBorder: '#fff' };
}

// 初始化价格走势图
function initPriceChart() {
    var ctx = document.getElementById('price-chart').getContext('2d');
    var theme = getChartTheme();
    
    priceChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: '日均价',
                    data: [],
                    borderColor: '#3498db',
                    backgroundColor: 'rgba(52, 152, 219, 0.1)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.4,
                    pointBackgroundColor: '#3498db',
                    pointBorderColor: theme.pointBorder,
                    pointBorderWidth: 2,
                    pointRadius: 5,
                    pointHoverRadius: 7
                },
                {
                    label: '月均价参考线',
                    data: [],
                    borderColor: '#e74c3c',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0,
                    pointRadius: 0,
                    pointHoverRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        font: {
                            size: 11,
                            family: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
                        },
                        color: theme.text,
                        boxWidth: 12,
                        padding: 8
                    }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleFont: {
                        size: 12,
                        weight: 'bold'
                    },
                    bodyFont: {
                        size: 12
                    },
                    padding: 10,
                    cornerRadius: 4,
                    callbacks: {
                        label: function(context) {
                            var label = context.dataset.label || '';
                            if (label.includes('日均价')) {
                                return '日均价: ' + formatWithUnit(context.parsed.y);
                            } else if (label.includes('月均价')) {
                                return '月均价: ' + formatWithUnit(context.parsed.y);
                            } else if (label.includes('年均价')) {
                                return '年均价: ' + formatWithUnit(context.parsed.y);
                            }
                            return label + ': ' + formatWithUnit(context.parsed.y);
                        },
                        title: function(tooltipItems) {
                            return '日期: ' + tooltipItems[0].label;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: theme.grid,
                        drawBorder: true,
                        borderColor: theme.border
                    },
                    ticks: {
                        font: {
                            size: 10,
                            family: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
                        },
                        color: theme.text,
                        // 自动调整刻度显示，避免重叠
                        maxTicksLimit: 12,
                        autoSkip: true,
                        maxRotation: 45,
                        minRotation: 0
                    },
                    // 确保X轴以日期顺序排列
                    type: 'category',
                    title: {
                        display: true,
                        text: '日期 (月-日)',
                        font: {
                            size: 11,
                            weight: 'bold'
                        },
                        color: theme.text,
                        padding: {top: 6, bottom: 2}
                    }
                },
                y: {
                    beginAtZero: false,
                    grid: {
                        color: theme.grid,
                        drawBorder: true,
                        borderColor: theme.border,
                        drawTicks: true
                    },
                    ticks: {
                        font: {
                            size: 10,
                            family: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
                        },
                        color: theme.text,
                        callback: function(value) {
                            return formatNumber(value);
                        },
                        // 以100元为区间递增
                        stepSize: 100,
                        padding: 6
                    },
                    // Y 轴上下限参考当月最高价和最低价，上下各留 10% 余量
                    afterDataLimits: function(scale) {
                        var minPrice = scale.min;
                        var maxPrice = scale.max;
                        if (!isFinite(minPrice) || !isFinite(maxPrice)) return;
                        
                        var range = maxPrice - minPrice;
                        var padding = range * 0.1;
                        var min = Math.max(0, minPrice - padding);
                        var max = maxPrice + padding;
                        
                        // 以 100 元为间隔取整
                        min = Math.floor(min / 100) * 100;
                        max = Math.ceil(max / 100) * 100;
                        
                        scale.min = min;
                        scale.max = max;
                    },
                    title: {
                        display: true,
                        text: '价格',
                        font: {
                            size: 11,
                            weight: 'bold'
                        },
                        color: theme.text,
                        padding: {top: 2, bottom: 6}
                    }
                }
            },
            interaction: {
                intersect: false,
                mode: 'nearest',
                axis: 'x'
            },
            animation: {
                duration: 750,
                easing: 'easeOutQuart'
            },
            elements: {
                line: {
                    tension: 0.4
                }
            },
            hover: {
                mode: 'nearest',
                intersect: true
            }
        }
    });

    // 系统深浅色切换时同步刷新图表文字/网格配色
    if (window.matchMedia) {
        var schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
        var onSchemeChange = function() {
            if (!priceChart) return;
            var t = getChartTheme();
            var opt = priceChart.options;
            opt.plugins.legend.labels.color = t.text;
            opt.scales.x.grid.color = t.grid;
            opt.scales.x.grid.borderColor = t.border;
            opt.scales.y.grid.color = t.grid;
            opt.scales.y.grid.borderColor = t.border;
            opt.scales.x.ticks.color = t.text;
            opt.scales.x.title.color = t.text;
            opt.scales.y.ticks.color = t.text;
            opt.scales.y.title.color = t.text;
            priceChart.data.datasets[0].pointBorderColor = t.pointBorder;
            priceChart.update();
        };
        if (schemeQuery.addEventListener) schemeQuery.addEventListener('change', onSchemeChange);
        else if (schemeQuery.addListener) schemeQuery.addListener(onSchemeChange);
    }
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

    // 空数据：清空图表与统计项
    if (labels.length === 0) {
        if (priceChart) {
            priceChart.data.labels = [];
            priceChart.data.datasets[0].data = [];
            priceChart.data.datasets[1].data = [];
            priceChart.update();
        }
        $('#chart-high').text('-');
        $('#chart-low').text('-');
        $('#chart-monthly-avg').text('-');
        $('#chart-change').text('-').removeClass('text-success text-danger');
        return;
    }

    // 首次绘制时才加载 Chart.js；加载期间只保留最新一次参数，避免重复初始化
    if (!priceChart) {
        pendingChartOpts = opts;
        if (!chartLoading) {
            chartLoading = true;
            ensureChart().then(function() {
                chartLoading = false;
                var latest = pendingChartOpts;
                pendingChartOpts = null;
                if (!priceChart) initPriceChart();
                // 图表晚于单位信息就绪，补一次单位标注（Y 轴标题）
                if (priceChart) updateUnitDisplays();
                if (latest) applyChartSeries(latest);
            }).catch(function(error) {
                chartLoading = false;
                pendingChartOpts = null;
                console.error('加载图表库失败:', error);
            });
        }
        return;
    }

    var highPrice = -Infinity;
    var lowPrice = Infinity;
    for (var i = 0; i < prices.length; i++) {
        if (prices[i] > highPrice) highPrice = prices[i];
        if (prices[i] < lowPrice) lowPrice = prices[i];
    }

    // 参考线数据（所有点取同一均价）
    var avgLine = [];
    for (var j = 0; j < labels.length; j++) avgLine.push(opts.avgValue);

    if (priceChart) {
        priceChart.data.labels = labels;
        priceChart.data.datasets[0].data = prices;
        priceChart.data.datasets[0].label = opts.seriesLabel;
        // 年视图需要显式设置主序列配色，其余视图沿用 initPriceChart 的默认色
        if (opts.colors) {
            priceChart.data.datasets[0].borderColor = opts.colors.border;
            priceChart.data.datasets[0].backgroundColor = opts.colors.bg;
            priceChart.data.datasets[0].pointBackgroundColor = opts.colors.point;
        }
        priceChart.data.datasets[1].data = avgLine;
        priceChart.data.datasets[1].label = opts.avgLabel;
        if (opts.avgColor) priceChart.data.datasets[1].borderColor = opts.avgColor;
        priceChart.options.scales.x.title.text = opts.xTitle;
        priceChart.update();
    }

    // 更新统计信息（涨跌 = 首点 → 末点变化率）
    var latestPrice = prices[prices.length - 1];
    var prevPrice = prices.length > 1 ? prices[prices.length - 2] : latestPrice;
    var firstPrice = prices[0];
    updateChartStats(highPrice, lowPrice, opts.avgValue, latestPrice, prevPrice, firstPrice);
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
        xTitle: '日期 (月-日)'
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
        colors: { border: '#3498db', bg: 'rgba(52, 152, 219, 0.1)', point: '#3498db' },
        avgColor: '#e74c3c'
    });
}

// 按年份更新走势图（使用月均价和年均价）
function updateYearlyChart(product) {
    chartMode = 'yearly';
    // 取消尚未完成的周期/月份走势请求，避免旧响应覆盖年度视图
    if (chartReq.current) { chartReq.current.abort(); chartReq.current = null; }
    // 高亮年走势标签
    highlightPeriodTab(365);

    requestJSON('/api/price/monthly?product=' + encodeURIComponent(product) + '&limit=12', chartReq, 10000)
        .then(function(data) { renderYearlyChart(data && data.monthly, product); })
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
    // 高亮月走势标签，表示当前为月份视图
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

    requestJSON(
        '/api/price/history?product=' + encodeURIComponent(product) + '&days=' + period,
        chartReq,
        10000
    ).then(function(data) {
        renderPriceChart((data && data.history) || [], product, period);
    }).catch(function(error) {
        if (error.name === 'AbortError') return; // 已被新的走势图请求取代
        console.error('获取走势数据失败:', error);
        renderPriceChart([], product, period);
    });
}

// 加载站点设置
function loadSiteSettings() {
    requestJSON('/api/price/settings', null, 10000)
        .then(data => {
            if (data.settings) {
                const settings = data.settings;
                const title = settings.frontend_title || '报价查询系统';
                const sourceName = settings.data_source_name || '数据源';

                document.title = title;
                $('.site-title').text(title);
                $('.data-source-name').text(sourceName);

                // 打印标题使用数据源名称的简称（去掉括号内容）
                const shortName = sourceName.split('（')[0].split('(')[0].trim();
                $('.data-source-name-short').text(shortName);
            }
        })
        .catch(error => {
            console.error('加载站点设置失败:', error);
        });
}

// 加载最后更新时间
function loadLastUpdate() {
    requestJSON('/api/price/last-update', null, 10000)
        .then(data => {
            if (data.last_update) {
                // 数据库时间为 UTC，按 UTC 解析后再转为本地时间显示
                var utcStr = data.last_update.replace(' ', 'T') + 'Z';
                var date = new Date(utcStr);
                $('#last-update').text(date.toLocaleString('zh-CN'));
            } else if (data.last_trade_date) {
                $('#last-update').text(data.last_trade_date);
            } else {
                $('#last-update').text('-');
            }
        })
        .catch(error => {
            console.error('获取最后更新时间失败:', error);
            $('#last-update').text('-');
        });
}

// 页面加载时执行
$(document).ready(function() {
    // 让出首帧：先让浏览器完成首次绘制，再发起数据请求，避免阻塞 FCP
    requestAnimationFrame(function() {
        setTimeout(function() {
            // 加载站点设置
            loadSiteSettings();

            // 加载最后更新时间
            loadLastUpdate();

            // 走势图在首屏数据返回后按需加载 Chart.js（见 applyChartSeries）

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
