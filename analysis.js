// analysis.js

// === UI & Initialization ===
const analysisModal = document.getElementById('analysisModal');
const closeAnalysisBtn = document.getElementById('closeAnalysisBtn');
const analysisTitle = document.getElementById('analysisTitle');
const analysisBody = document.getElementById('analysisBody');

// Close modal handlers
closeAnalysisBtn.addEventListener('click', () => {
    analysisModal.classList.remove('active');
});

analysisModal.addEventListener('click', (e) => {
    if (e.target === analysisModal) {
        analysisModal.classList.remove('active');
    }
});

// Use event delegation for dynamically created buttons
document.body.addEventListener('click', async (e) => {
    if (e.target.closest('.btn-analyze')) {
        const btn = e.target.closest('.btn-analyze');
        const symbol = btn.getAttribute('data-code');
        const name = btn.getAttribute('data-name');
        const avgCost = btn.getAttribute('data-avg-cost');
        
        openAnalysisModal(symbol, name, avgCost);
    }
});

// Caches for APIs to avoid repeated large fetches
let twseBasicCache = null;

async function openAnalysisModal(symbol, name, avgCost) {
    analysisTitle.textContent = `📊 ${name} (${symbol}) 分析報告`;
    analysisModal.classList.add('active');
    
    // Show Loading
    analysisBody.innerHTML = `
        <div class="analysis-loading">
            <div class="analysis-spinner"></div>
            <span>正在載入多方數據與運算中，請稍候...</span>
        </div>
    `;

    try {
        const [chartData, twseBasic, chipsData, revData, finData, marginData, institutionalData] = await Promise.all([
            fetchYahooChart(symbol),
            fetchTWSEBasic(symbol),
            fetchYahooChipsProxy(symbol),
            fetchFinMindRevenue(symbol),
            fetchFinMindFinancial(symbol),
            fetchFinMindMargin(symbol),
            fetchFinMindInstitutional(symbol)
        ]);

        renderAnalysis(symbol, name, chartData, twseBasic, chipsData, revData, finData, marginData, institutionalData, avgCost);

    } catch (err) {
        console.error("Analysis fetch error:", err);
        analysisBody.innerHTML = `
            <div style="text-align:center; padding:40px; color:#f87171;">
                載入分析失敗：${err.message}
            </div>
        `;
    }
}

// === Network Helper ===
async function analysisFetchProxy(targetUrl, isJson = false) {
    const proxies = [
        (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
        (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
        (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
    ];

    let lastError = null;
    for (let getProxyUrl of proxies) {
        const proxyUrl = getProxyUrl(targetUrl);
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            const res = await fetch(proxyUrl, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (res.ok) {
                if (proxyUrl.includes('allorigins.win/get')) {
                    const data = await res.json();
                    if (data && data.contents) {
                        return isJson ? JSON.parse(data.contents) : data.contents;
                    }
                } else {
                    return isJson ? await res.json() : await res.text();
                }
            }
        } catch (e) {
            lastError = e;
        }
    }
    throw new Error(`Failed to fetch after trying all proxies. Last error: ${lastError?.message || 'Unknown'}`);
}

// === Data Fetching Functions ===

async function fetchYahooChart(symbol) {
    // 取得純數字代號
    const rawSymbol = symbol.trim().replace(/\.TW$/i, '').replace(/\.TWO$/i, '');
    
    // 設定起始日期 (抓過去 400 天確保有 240 個交易日)
    const d = new Date();
    d.setDate(d.getDate() - 400);
    const startDate = d.toISOString().split('T')[0];
    
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${rawSymbol}&start_date=${startDate}`;
    
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("API 回應錯誤");
        const json = await res.json();
        
        if (!json || !json.data || json.data.length === 0) {
            throw new Error("無歷史股價資料");
        }
        
        const data = json.data;
        const closes = data.map(item => item.close);
        const highs  = data.map(item => item.max);
        const lows   = data.map(item => item.min);
        const vols   = data.map(item => item.Trading_Volume || item.volume || 0);
        const currentPrice = closes[closes.length - 1];
        
        // === 均線 ===
        const ma5   = calcMA(closes, 5);
        const ma10  = calcMA(closes, 10);
        const ma20  = calcMA(closes, 20);
        const ma60  = calcMA(closes, 60);
        const ma120 = calcMA(closes, 120);
        const ma240 = calcMA(closes, 240);

        // === 52週高低點 ===
        const recentCloses = closes.slice(-252); // 約 252 個交易日
        const high52w = Math.max(...recentCloses);
        const low52w  = Math.min(...recentCloses);
        const posIn52w = ((currentPrice - low52w) / (high52w - low52w) * 100).toFixed(1); // 位置百分比

        // === RSI 14 ===
        const rsi14 = calcRSI(closes, 14);

        // === 布林週道 20日 ===
        const bb = calcBollinger(closes, 20, 2);
        
        // === 5日均量 ===
        const avgVol5 = vols.length >= 5 ? Math.round(vols.slice(-5).reduce((a,b)=>a+b,0) / 5) : null;

        // === KD (9,3,3) ===
        const kd = calcKD(highs, lows, closes, 9);

        // === MACD (12, 26, 9) ===
        const macd = calcMACD(closes, 12, 26, 9);

        return {
            currentPrice,
            ma: { ma5, ma10, ma20, ma60, ma120, ma240 },
            high52w, low52w, posIn52w,
            rsi14,
            bb,
            avgVol5,
            kd,
            macd
        };
    } catch (e) {
        throw new Error(`FinMind API 失敗: ${e.message}`);
    }
}

// === Technical Indicator Calculations ===

function calcMA(closes, period) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    const recent = closes.slice(-(period + 1));
    let gains = 0, losses = 0;
    for (let i = 1; i < recent.length; i++) {
        const diff = recent[i] - recent[i - 1];
        if (diff > 0) gains += diff;
        else losses += Math.abs(diff);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return parseFloat((100 - (100 / (1 + rs))).toFixed(1));
}

function calcEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = [data[0]];
    for (let i = 1; i < data.length; i++) {
        ema.push(data[i] * k + ema[i-1] * (1 - k));
    }
    return ema;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow + signal) return null;
    const emaFast = calcEMA(closes, fast);
    const emaSlow = calcEMA(closes, slow);
    const dif = emaFast.map((v, i) => v - emaSlow[i]);
    const macdLine = calcEMA(dif, signal);
    const osc = dif.map((v, i) => v - macdLine[i]);
    return {
        dif: dif[dif.length - 1],
        macd: macdLine[macdLine.length - 1],
        osc: osc[osc.length - 1]
    };
}

function calcBollinger(prices, period, stdDev) {
    if (prices.length < period) return null;
    const mid = calcMA(prices.slice(-period), period);
    const sumSq = prices.slice(-period).reduce((a, b) => a + Math.pow(b - mid, 2), 0);
    const sigma = Math.sqrt(sumSq / period);
    return {
        upper: parseFloat((mid + sigma * stdDev).toFixed(2)),
        mid: parseFloat(mid.toFixed(2)),
        lower: parseFloat((mid - sigma * stdDev).toFixed(2))
    };
}

function calcKD(highs, lows, closes, period = 9) {
    if (closes.length < period) return null;
    let k = 50, d = 50;
    // Iterate to stabilize KD values
    const startIdx = Math.max(0, closes.length - 60); // Check last 60 days for stabilization
    for (let i = startIdx; i < closes.length; i++) {
        const start = Math.max(0, i - period + 1);
        const highPeriod = Math.max(...highs.slice(start, i + 1));
        const lowPeriod  = Math.min(...lows.slice(start, i + 1));
        const rsv = (highPeriod === lowPeriod) ? 0 : (closes[i] - lowPeriod) / (highPeriod - lowPeriod) * 100;
        k = (2/3) * k + (1/3) * rsv;
        d = (2/3) * d + (1/3) * k;
    }
    return { k: Math.round(k), d: Math.round(d) };
}

async function fetchTWSEBasic(symbol) {
    const rawSymbol = symbol.trim().replace(/\.TW$/i, '').replace(/\.TWO$/i, '');
    
    // 設定起始日期 (抓過去 10 天確保有最新交易日)
    const d = new Date();
    d.setDate(d.getDate() - 10);
    const startDate = d.toISOString().split('T')[0];
    
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPER&data_id=${rawSymbol}&start_date=${startDate}`;
    
    try {
        const res = await fetch(url);
        const json = await res.json();
        
        if (json && json.data && json.data.length > 0) {
            // 取得最新一筆本益比與殖利率資料
            const latest = json.data[json.data.length - 1];
            return {
                pe: latest.PER || null,
                yield: latest.dividend_yield || null,
                pb: latest.PBR || null
            };
        }
    } catch (err) {
        console.warn("FinMind PER API failed, skipping.");
    }
    return null;
}

// Fetch FinMind Dividends & Shareholding + Scrape Yahoo Finance TW for others
async function fetchYahooChipsProxy(symbol) {
    const rawSymbol = symbol.trim().replace(/\.TW$/i, '').replace(/\.TWO$/i, '');
    
    // --- 1. FinMind 股利資料 ---
    let exDivDate = '無資料';
    let exDivAmt = null;
    let divGrowth3y = null;
    try {
        const dDiv = new Date();
        dDiv.setDate(dDiv.getDate() - 1100); 
        const urlDiv = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockDividend&data_id=${rawSymbol}&start_date=${dDiv.toISOString().split('T')[0]}`;
        const resDiv = await fetch(urlDiv);
        const jsonDiv = await resDiv.json();
        if (jsonDiv && jsonDiv.data && jsonDiv.data.length > 0) {
            const sortedDiv = jsonDiv.data.filter(d => d.CashEarningsDistribution).sort((a,b) => new Date(b.date) - new Date(a.date));
            if (sortedDiv.length > 0) {
                exDivDate = sortedDiv[0].CashExDividendTradingDate || '無資料';
                exDivAmt = sortedDiv[0].CashEarningsDistribution;
                
                if (sortedDiv.length >= 3) {
                    const latest = sortedDiv[0].CashEarningsDistribution;
                    const threeYearsAgo = sortedDiv[sortedDiv.length - 1].CashEarningsDistribution;
                    if (threeYearsAgo > 0) {
                        divGrowth3y = ((latest - threeYearsAgo) / threeYearsAgo) * 100;
                    }
                }
            }
        }
    } catch (e) {
        console.warn("FinMind Dividend failed", e);
    }

    // --- 2. FinMind 外資持股 ---
    let foreign = null;
    let sharesIssued = null;
    try {
        const dShare = new Date();
        dShare.setDate(dShare.getDate() - 30);
        const urlShare = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockShareholding&data_id=${rawSymbol}&start_date=${dShare.toISOString().split('T')[0]}`;
        const resShare = await fetch(urlShare);
        const jsonShare = await resShare.json();
        if (jsonShare && jsonShare.data && jsonShare.data.length > 0) {
            const latest = jsonShare.data[jsonShare.data.length - 1];
            foreign = latest.ForeignInvestmentSharesRatio;
            sharesIssued = latest.NumberOfSharesIssued || null;
        }
    } catch (e) {
        console.warn("FinMind Shareholding failed", e);
    }

    // --- 3. Yahoo Proxy (for 投信, 大戶, 散戶) ---
    const targetUrl = `https://tw.stock.yahoo.com/quote/${rawSymbol}/major-shareholders`;
    let html = "";
    try {
        html = await analysisFetchProxy(targetUrl, false);
    } catch (e) {
        console.warn("Failed to fetch Yahoo proxy for chips", e);
    }

    const extractPercent = (keyword) => {
        const reg = new RegExp(`${keyword}.*?(\\d+\\.?\\d*)%`);
        const match = html.match(reg);
        return match ? parseFloat(match[1]) : null;
    };

    if (foreign === null) foreign = extractPercent('外資');
    const trust = extractPercent('投信');
    let large = extractPercent('400張大戶');
    if(large === null) large = extractPercent('大戶持股');
    const retail = extractPercent('散戶');
    
    if (exDivAmt === null) {
        const divMatch = html.match(/(?:除權息|除息).*?(\d{4}-\d{2}-\d{2}).*?([\d\.]+)\s*元/);
        if (divMatch) {
            exDivDate = divMatch[1];
            exDivAmt = parseFloat(divMatch[2]);
        }
    }

    return { foreign, trust, large, retail, exDivDate, exDivAmt, sharesIssued, divGrowth3y };
}

// --- 4. FinMind 月營收 ---
async function fetchFinMindRevenue(symbol) {
    const rawSymbol = symbol.trim().replace(/\.TW$/i, '').replace(/\.TWO$/i, '');
    const d = new Date();
    d.setDate(d.getDate() - 400);
    const startDate = d.toISOString().split('T')[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue&data_id=${rawSymbol}&start_date=${startDate}`;
    try {
        const res = await fetch(url);
        const json = await res.json();
        if (json && json.data && json.data.length >= 2) {
            const data = json.data;
            const current = data[data.length - 1];
            const prev    = data[data.length - 2];
            const lastYear = data.find(x => x.revenue_year === current.revenue_year - 1 && x.revenue_month === current.revenue_month);
            
            const mom = ((current.revenue - prev.revenue) / prev.revenue) * 100;
            const yoy = lastYear ? ((current.revenue - lastYear.revenue) / lastYear.revenue) * 100 : null;
            
            // 近 12 個月累計營收
            const last12 = data.slice(-12);
            const cum12m = last12.reduce((s, x) => s + x.revenue, 0);
            
            // YTD 營收（當年已公告月份總計）
            const ytdMonths = data.filter(x => x.revenue_year === current.revenue_year);
            const ytd = ytdMonths.reduce((s, x) => s + x.revenue, 0);
            
            // 年增次數（近 12 個月中有幾個月份 YoY > 0）
            let yoyUpMonths = 0;
            for (const m of last12) {
                const ly = data.find(x => x.revenue_year === m.revenue_year - 1 && x.revenue_month === m.revenue_month);
                if (ly && m.revenue > ly.revenue) yoyUpMonths++;
            }

            return {
                month: `${current.revenue_year}年${current.revenue_month}月`,
                revenue: current.revenue,
                mom,
                yoy,
                cum12m,
                ytd,
                ytdMonthCount: ytdMonths.length,
                yoyUpMonths,
                totalMonths: last12.length
            };
        }
    } catch(e) { console.warn("FinMind Revenue failed", e); }
    return null;
}

// --- 5. FinMind 財報、比率、現金流 ---
async function fetchFinMindFinancial(symbol) {
    const rawSymbol = symbol.trim().replace(/\.TW$/i, '').replace(/\.TWO$/i, '');
    const d = new Date();
    d.setDate(d.getDate() - 600);
    const startDate = d.toISOString().split('T')[0];
    
    const datasets = [
        'TaiwanStockFinancialStatements',
        'TaiwanStockBalanceSheet',
        'TaiwanStockCashFlowsStatement'
    ];

    try {
        const promises = datasets.map(ds => 
            fetch(`https://api.finmindtrade.com/api/v4/data?dataset=${ds}&data_id=${rawSymbol}&start_date=${startDate}`)
            .then(res => res.ok ? res.json() : { data: [] })
            .catch(() => ({ data: [] }))
        );
        const results = await Promise.all(promises);
        const [jsonS, jsonB, jsonC] = results;
        
        if (jsonS?.data?.length > 0 && jsonB?.data?.length > 0) {
            const allDates = [...new Set(jsonS.data.map(x => x.date))].sort();
            const latestDate = allDates[allDates.length - 1];
            
            const getQData = (dataset, date) => dataset ? dataset.filter(x => x.date === date) : [];
            const getVal = (qData, type) => {
                const item = qData.find(x => x.type === type);
                return item ? item.value : 0;
            };

            const latestS = getQData(jsonS.data, latestDate);
            
            // Helper to get latest data from other datasets if the exact date is missing
            const getLatestDataFromDataset = (dataset) => {
                if (!dataset || dataset.length === 0) return [];
                const dts = [...new Set(dataset.map(x => x.date))].sort();
                const d = dts.includes(latestDate) ? latestDate : dts[dts.length - 1];
                return dataset.filter(x => x.date === d);
            };

            const latestB = getLatestDataFromDataset(jsonB?.data);
            const latestC = getLatestDataFromDataset(jsonC?.data);

            const rev = getVal(latestS, 'Revenue');
            const netIncome = getVal(latestS, 'IncomeAfterTaxes');
            const equity = getVal(latestB, 'Equity');
            const assets = getVal(latestB, 'TotalAssets');
            const curAssets = getVal(latestB, 'CurrentAssets');
            const curLiab = getVal(latestB, 'CurrentLiabilities');
            const inv = getVal(latestB, 'Inventories');

            return {
                quarter: latestDate,
                grossMargin: rev > 0 ? (getVal(latestS, 'GrossProfit') / rev) * 100 : 0,
                opMargin:    rev > 0 ? (getVal(latestS, 'OperatingIncome') / rev) * 100 : 0,
                netMargin:   rev > 0 ? (netIncome / rev) * 100 : 0,
                eps:         getVal(latestS, 'EPS'),
                roe:         equity > 0 ? (netIncome / equity) * 100 : null,
                roa:         assets > 0 ? (netIncome / assets) * 100 : null,
                debtRatio:   getVal(latestB, 'Liabilities_per'),
                currentRatio: curLiab > 0 ? (curAssets / curLiab) * 100 : null,
                quickRatio:   curLiab > 0 ? ((curAssets - inv) / curLiab) * 100 : null,
                inventoryTurnover: inv > 0 ? (rev / inv) : null,
                opCashFlow:   getVal(latestC, 'CashFlowsFromOperatingActivities') || getVal(latestC, 'NetCashInflowFromOperatingActivities'),
                freeCashFlow: (getVal(latestC, 'CashFlowsFromOperatingActivities') || getVal(latestC, 'NetCashInflowFromOperatingActivities')) + getVal(latestC, 'CashProvidedByInvestingActivities'),
                epsTrend: allDates.slice(-4).map(date => {
                    const qd = getQData(jsonS.data, date);
                    return { label: date, eps: getVal(qd, 'EPS') };
                })
            };
        }
    } catch(e) { console.warn("FinMind Multi-Financial failed", e); }
    return null;
}

// --- 6. FinMind 融資融券 ---
async function fetchFinMindMargin(symbol) {
    const rawSymbol = symbol.trim().replace(/\.TW$/i, '').replace(/\.TWO$/i, '');
    const d = new Date();
    d.setDate(d.getDate() - 10);
    const startDate = d.toISOString().split('T')[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMarginPurchaseShortSale&data_id=${rawSymbol}&start_date=${startDate}`;
    try {
        const res = await fetch(url);
        const json = await res.json();
        if (json && json.data && json.data.length > 0) {
            const latest = json.data[json.data.length - 1];
            return {
                marginPurchase: latest.MarginPurchaseTodayBalance || 0,
                shortSale: latest.ShortSaleTodayBalance || 0,
                marginLimit: latest.MarginPurchaseLimit || 0,
                marginUseRate: (latest.MarginPurchaseTodayBalance / latest.MarginPurchaseLimit * 100).toFixed(1)
            };
        }
    } catch(e) { console.warn("FinMind Margin failed", e); }
    return null;
}

// --- 7. FinMind 三大法人近一個月買賣超 ---
async function fetchFinMindInstitutional(symbol) {
    const rawSymbol = symbol.trim().replace(/\.TW$/i, '').replace(/\.TWO$/i, '');
    const d = new Date();
    d.setDate(d.getDate() - 33); // 過去約一個月
    const startDate = d.toISOString().split('T')[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${rawSymbol}&start_date=${startDate}`;
    try {
        const res = await fetch(url);
        const json = await res.json();
        if (json && json.data && json.data.length > 0) {
            const allDates = [...new Set(json.data.map(x => x.date))].sort();
            const calcTotal = (dataset) => {
                const foreign = dataset.filter(x => x.name === 'Foreign_Investor').reduce((a,b)=>a+(b.buy - b.sell)/1000, 0);
                const trust = dataset.filter(x => x.name === 'Investment_Trust').reduce((a,b)=>a+(b.buy - b.sell)/1000, 0);
                const dealer = dataset.filter(x => x.name.toLowerCase().includes('dealer')).reduce((a,b)=>a+(b.buy - b.sell)/1000, 0);
                return { foreign, trust, dealer };
            };

            const latestDate = allDates[allDates.length - 1];
            const latestDayData = json.data.filter(x => x.date === latestDate);
            const latestDay = calcTotal(latestDayData);

            const monthTotal = calcTotal(json.data);
            
            // 5-day total
            const fiveDayDates = allDates.slice(-5);
            const fiveDayData = json.data.filter(x => fiveDayDates.includes(x.date));
            const fiveDayTotal = calcTotal(fiveDayData);

            return {
                periodStart: allDates[0],
                periodEnd: latestDate,
                monthTotal,
                latestDay,
                fiveDayTotal
            };
        }
    } catch(e) { console.warn("FinMind Institutional failed", e); }
    return null;
}

// === Rendering Logic ===

function renderAnalysis(symbol, name, chartData, twseBasic, chipsData, revData, finData, marginData, institutionalData, avgCost = null) {
    const { currentPrice, ma, high52w, low52w, posIn52w, rsi14, bb, avgVol5, kd, macd } = chartData;
    
    // 市値計算
    const marketCap = chipsData.sharesIssued ? (currentPrice * chipsData.sharesIssued / 100000000) : null; // 億元
    
    // --- Valuations ---
    // If fundamental data is missing, we don't calculate fake valuations
    const eps = twseBasic?.pe && currentPrice ? currentPrice / twseBasic.pe : null;
    const currentDiv = twseBasic?.yield && currentPrice ? currentPrice * (twseBasic.yield / 100) : null;
    
    // 成本殖利率
    const costYield = (currentDiv && avgCost && avgCost > 0) ? (currentDiv / avgCost * 100) : null;
    
    // 1. Dividend Method
    const divCheap = currentDiv ? currentDiv / 0.05 : null;
    const divReasonable = currentDiv ? currentDiv / 0.04 : null;
    const divExpensive = currentDiv ? currentDiv / 0.03 : null;
    
    // 2. PE Method
    const peCheap = eps ? eps * 12 : null;
    const peReasonable = eps ? eps * 15 : null;
    const peExpensive = eps ? eps * 20 : null;

    // AI Summary logic
    let summaryText = `【${name}】目前股價 ${currentPrice.toFixed(2)} 元。`;
    
    if (currentPrice > ma.ma60) {
        summaryText += "技術面顯示目前位於季線之上，屬於多頭格局。";
    } else {
        summaryText += "技術面顯示目前跌破季線，走勢偏弱。";
    }

    if (chipsData.foreign && chipsData.foreign > 30) {
        summaryText += `外資持股高達 ${chipsData.foreign}%，籌碼集中度高。`;
    }
    
    if (twseBasic?.pe && twseBasic.pe < 12) {
        summaryText += `目前本益比約 ${twseBasic.pe} 倍，相對便宜。`;
    } else if (twseBasic?.pe && twseBasic.pe > 20) {
        summaryText += `目前本益比約 ${twseBasic.pe} 倍，估值偏高需留意風險。`;
    }

    if (twseBasic?.yield && twseBasic.yield > 5) {
        summaryText += `目前殖利率達 ${twseBasic.yield}%，屬於高殖利率標的，具備收息吸引力。`;
    }

    if (costYield && costYield > 6) {
        summaryText += `您的成本殖利率高達 ${costYield.toFixed(2)}%，遠優於市場平均，是一筆非常成功的長線投資。`;
    }
    
    if (revData?.yoy && revData.yoy > 10) {
        summaryText += `最新營收大幅年增 ${revData.yoy.toFixed(1)}%，具備強勁成長動能。`;
    }

    if (finData?.grossMargin > 30) {
        summaryText += `毛利率高達 ${finData.grossMargin.toFixed(1)}%，產品競爭力強。`;
    }
    if (rsi14 !== null) {
        if (rsi14 > 70) summaryText += `RSI(14) 高達 ${rsi14}，技術面呈現超買，短線注意回調風險。`;
        else if (rsi14 < 30) summaryText += `RSI(14) 僅 ${rsi14}，技術面超賣，可能出現反彈機會。`;
    }
    if (kd) {
        if (kd.k > 80) summaryText += "KD 指標目前大於 80，顯示處於高檔超買區。";
        else if (kd.k < 20) summaryText += "KD 指標目前小於 20，顯示處於低檔超賣區。";
    }

    if (finData?.roe > 15) {
        summaryText += `ROE 高達 ${finData.roe.toFixed(1)}%，展現極佳的獲利效率。`;
    }
    if (finData?.freeCashFlow > 0) {
        summaryText += "自由現金流為正，財務體質穩健且具備發放股利潛力。";
    } else if (finData?.freeCashFlow < 0) {
        summaryText += "自由現金流呈現流出，需留意公司資金調度與資本支出狀況。";
    }

    analysisBody.innerHTML = `
        <div class="analysis-grid">
            <!-- 1. 市值與規模 -->
            <div class="analysis-card">
                <div class="analysis-card-title">🏢 市值與股本規模</div>
                ${renderStatRow('市值', marketCap ? formatCurrency(marketCap * 100000000) : 'N/A')}
                ${renderStatRow('實收股本', chipsData.sharesIssued ? formatCurrency(chipsData.sharesIssued * 10) : 'N/A')}
                ${renderStatRow('發行股數', chipsData.sharesIssued ? chipsData.sharesIssued.toLocaleString() + ' 股' : 'N/A')}
                ${renderStatRow('5日均量', avgVol5 ? avgVol5.toLocaleString() + ' 股' : 'N/A')}
                ${renderStatRow('52週最高', high52w ? high52w.toFixed(2) + ' 元' : 'N/A')}
                ${renderStatRow('52週最低', low52w ? low52w.toFixed(2) + ' 元' : 'N/A')}
                ${renderStatRow('52週位置', posIn52w !== null ? posIn52w + '%' : 'N/A')}
            </div>

            <!-- 2. 合理價格評估 -->
            <div class="analysis-card">
                <div class="analysis-card-title">💰 合理價格評估</div>
                <div style="display:flex; justify-content:space-between; margin-bottom:12px; background:rgba(37, 99, 235, 0.1); padding:8px 12px; border-radius:8px; border:1px solid rgba(37, 99, 235, 0.2);">
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:10px; color:#94a3b8;">當前本益比 (PE)</div>
                        <div style="font-size:15px; font-weight:700; color:#fff;">${twseBasic?.pe ? twseBasic.pe + ' 倍' : 'N/A'}</div>
                    </div>
                    <div style="width:1px; background:rgba(255,255,255,0.1); margin:0 10px;"></div>
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:10px; color:#94a3b8;">當前殖利率 (Yield)</div>
                        <div style="font-size:15px; font-weight:700; color:#ef4444;">${twseBasic?.yield ? twseBasic.yield + '%' : 'N/A'}</div>
                    </div>
                    ${avgCost ? `
                    <div style="width:1px; background:rgba(255,255,255,0.1); margin:0 10px;"></div>
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:10px; color:#94a3b8;">成本殖利率</div>
                        <div style="font-size:15px; font-weight:700; color:#fbbf24;">${costYield ? costYield.toFixed(2) + '%' : 'N/A'}</div>
                    </div>` : ''}
                </div>
                <div style="font-size:11px; color:#94a3b8; margin-bottom:8px;">基於歷年股利推算 (5% / 4% / 3%)</div>
                ${renderValuationRow('便宜價 (5%殖利率)', divCheap)}
                ${renderValuationRow('合理價 (4%殖利率)', divReasonable)}
                ${renderValuationRow('昂貴價 (3%殖利率)', divExpensive)}
                
                <div style="font-size:11px; color:#94a3b8; margin:12px 0 8px;">基於本益比推算 (12倍 / 15倍 / 20倍)</div>
                ${renderValuationRow('便宜價 (12倍PE)', peCheap)}
                ${renderValuationRow('合理價 (15倍PE)', peReasonable)}
                ${renderValuationRow('昂貴價 (20倍PE)', peExpensive)}
            </div>

            <!-- 3. 獲利能力 -->
            <div class="analysis-card">
                <div class="analysis-card-title">💵 財報獲利能力</div>
                <div style="font-size:11px; color:#94a3b8; margin-bottom:8px;">季度: ${finData?.quarter || 'N/A'}</div>
                ${renderPercentRow('毛利率', finData?.grossMargin, false)}
                ${renderPercentRow('營業利益率', finData?.opMargin, false)}
                ${renderPercentRow('稅後淨利率', finData?.netMargin, false)}
                ${renderStatRow('單季 EPS', finData?.eps ? finData.eps + ' 元' : 'N/A')}
                ${renderPercentRow('ROE (股東權益報酬)', finData?.roe)}
                ${renderPercentRow('ROA (資產報酬率)', finData?.roa)}
            </div>

            <!-- 4. 月營收表現 -->
            <div class="analysis-card">
                <div class="analysis-card-title">📊 月營收趨勢</div>
                <div style="font-size:11px; color:#94a3b8; margin-bottom:8px;">月份: ${revData?.month || 'N/A'}</div>
                ${renderStatRow('單月營收', revData?.revenue ? formatCurrency(revData.revenue) : 'N/A')}
                ${renderPercentRow('月增率 (MoM)', revData?.mom)}
                ${renderPercentRow('年增率 (YoY)', revData?.yoy)}
                ${renderStatRow('近 12 月累計', revData?.cum12m ? formatCurrency(revData.cum12m) : 'N/A')}
                ${renderStatRow('年增次數 (近 12 月)', revData ? `${revData.yoyUpMonths} / ${revData.totalMonths}` : 'N/A')}
            </div>

            <!-- 5. 財務安全與現金流 [NEW] -->
            <div class="analysis-card">
                <div class="analysis-card-title">🛡️ 財務健康指標</div>
                ${renderStatRow('流動比率', finData?.currentRatio ? finData.currentRatio.toFixed(1) + '%' : 'N/A')}
                ${renderStatRow('速動比率', finData?.quickRatio ? finData.quickRatio.toFixed(1) + '%' : 'N/A')}
                ${renderPercentRow('負債比率', finData?.debtRatio, false)}
                ${renderStatRow('存貨週轉率', finData?.inventoryTurnover ? finData.inventoryTurnover.toFixed(2) + ' 次' : 'N/A')}
                <div style="font-size:11px; color:#94a3b8; margin:10px 0 6px; border-bottom:1px dashed rgba(255,255,255,0.05); padding-bottom:6px;">💸 現金流量</div>
                ${renderStatRow('營業現金流', finData?.opCashFlow ? formatCurrency(finData.opCashFlow) : 'N/A')}
                ${renderStatRow('自由現金流', finData?.freeCashFlow ? formatCurrency(finData.freeCashFlow) : 'N/A')}
            </div>

            <!-- 6. 籌碼與信用交易 -->
            <div class="analysis-card">
                <div class="analysis-card-title">👥 籌碼與信用</div>
                ${renderStatRow('外資持股比', chipsData.foreign ? chipsData.foreign + '%' : 'N/A', chipsData.foreign)}
                ${renderStatRow('投信持股', chipsData.trust ? chipsData.trust + '%' : 'N/A', chipsData.trust)}
                ${renderStatRow('大戶持股 (400張)', chipsData.large ? chipsData.large + '%' : 'N/A', chipsData.large)}
                ${renderStatRow('融資餘額', marginData?.marginPurchase ? marginData.marginPurchase.toLocaleString() + ' 張' : 'N/A')}
                ${renderStatRow('融資使用率', marginData?.marginUseRate ? marginData.marginUseRate + '%' : 'N/A', marginData?.marginUseRate)}
                
                <div style="font-size:11px; color:#94a3b8; margin:10px 0 6px; border-bottom:1px dashed rgba(255,255,255,0.05); padding-bottom:6px;">🏦 法人進出 (張)</div>
                <div style="font-size:10px; color:#64748b; margin-bottom:4px;">📌 最新單日</div>
                ${renderNetBuyRow('外資單日', institutionalData?.latestDay?.foreign)}
                ${renderNetBuyRow('投信單日', institutionalData?.latestDay?.trust)}
                ${renderNetBuyRow('自營商單日', institutionalData?.latestDay?.dealer)}
                
                <div style="font-size:10px; color:#64748b; margin:8px 0 4px;">📈 近 5 日累計</div>
                ${renderNetBuyRow('外資 5日', institutionalData?.fiveDayTotal?.foreign)}
                ${renderNetBuyRow('投信 5日', institutionalData?.fiveDayTotal?.trust)}
                ${renderNetBuyRow('自營商 5日', institutionalData?.fiveDayTotal?.dealer)}
                
                <div style="font-size:10px; color:#64748b; margin:8px 0 4px;">📅 近一個月累計</div>
                ${renderNetBuyRow('外資月計', institutionalData?.monthTotal?.foreign)}
                ${renderNetBuyRow('投信月計', institutionalData?.monthTotal?.trust)}
                ${renderNetBuyRow('自營商月計', institutionalData?.monthTotal?.dealer)}
            </div>

            <!-- 7. 技術面分析 (均線 + 指標) -->
            <div class="analysis-card">
                <div class="analysis-card-title">📉 技術面分析</div>
                <div style="display:flex; justify-content:space-between; margin-bottom:12px; background:rgba(255,255,255,0.05); padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,0.1);">
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:10px; color:#94a3b8;">RSI(14)</div>
                        <div style="font-size:16px; font-weight:600; color:${rsi14 > 70 ? '#ef4444' : (rsi14 < 30 ? '#10b981' : '#fff')}">${rsi14 || 'N/A'}</div>
                    </div>
                    <div style="width:1px; background:rgba(255,255,255,0.1); margin:0 10px;"></div>
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:10px; color:#94a3b8;">KD (K/D)</div>
                        <div style="font-size:16px; font-weight:600;">${kd ? `${kd.k}/${kd.d}` : 'N/A'}</div>
                    </div>
                    <div style="width:1px; background:rgba(255,255,255,0.1); margin:0 10px;"></div>
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:10px; color:#94a3b8;">MACD OSC</div>
                        <div style="font-size:14px; font-weight:600; color:${macd?.osc > 0 ? '#ef4444' : (macd?.osc < 0 ? '#10b981' : '#fff')}">${macd ? macd.osc.toFixed(2) : 'N/A'}</div>
                    </div>
                </div>
                ${renderMARow('5日線 (週線)', ma.ma5, currentPrice)}
                ${renderMARow('10日線', ma.ma10, currentPrice)}
                ${renderMARow('20日線 (月線)', ma.ma20, currentPrice)}
                ${renderMARow('60日線 (季線)', ma.ma60, currentPrice)}
                ${renderMARow('120日線 (半年線)', ma.ma120, currentPrice)}
                ${renderMARow('240日線 (年線)', ma.ma240, currentPrice)}
                ${renderStatRow('目前布林位置', (() => {
                    if(!bb) return 'N/A';
                    const pos = ((currentPrice - bb.lower) / (bb.upper - bb.lower) * 100).toFixed(0);
                    return `${pos}% ${pos > 80 ? '⚠️' : pos < 20 ? '🟢' : ''}`;
                })())}
            </div>
        </div>

        <div class="analysis-card" style="margin-top:16px;">
            <div class="analysis-card-title">🤖 AI 綜合診斷</div>
            <div class="analysis-summary">${summaryText}</div>
        </div>
    `;
}

function renderStatRow(label, value, percentVal = null) {
    let barHtml = '';
    if (percentVal !== null && !isNaN(percentVal)) {
        barHtml = `
        <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width: ${percentVal}%; background: ${percentVal > 30 ? '#3b82f6' : '#cbd5e1'};"></div>
        </div>`;
    }
    
    return `
        <div class="analysis-stat-row" style="flex-direction: ${barHtml ? 'column' : 'row'}; align-items: ${barHtml ? 'flex-start' : 'center'}; gap: 4px;">
            <div style="display:flex; justify-content:space-between; width:100%;">
                <span class="analysis-label">${label}</span>
                <span class="analysis-val">${value}</span>
            </div>
            ${barHtml}
        </div>
    `;
}

function renderPercentRow(label, percentVal, showSign = true) {
    if (percentVal === null || percentVal === undefined || isNaN(percentVal)) {
        return `<div class="analysis-stat-row"><span class="analysis-label">${label}</span><span class="analysis-val">N/A</span></div>`;
    }
    const color = percentVal > 0 ? '#ef4444' : (percentVal < 0 ? '#10b981' : '#f8fafc'); // 台股紅漲綠跌
    const sign = (showSign && percentVal > 0) ? '+' : '';
    return `
        <div class="analysis-stat-row">
            <span class="analysis-label">${label}</span>
            <span class="analysis-val" style="color: ${color};">${sign}${percentVal.toFixed(2)}%</span>
        </div>
    `;
}

function formatCurrency(num) {
    if (num >= 1000000000000) return (num / 1000000000000).toFixed(2) + ' 兆';
    if (num >= 100000000) return (num / 100000000).toFixed(2) + ' 億';
    if (num >= 10000) return (num / 10000).toFixed(2) + ' 萬';
    return num.toLocaleString();
}

function renderNetBuyRow(label, netLots) {
    if (netLots === null || netLots === undefined || isNaN(netLots)) {
        return `<div class="analysis-stat-row"><span class="analysis-label">${label}</span><span class="analysis-val">N/A</span></div>`;
    }
    const rounded = Math.round(netLots);
    const color = rounded > 0 ? '#ef4444' : (rounded < 0 ? '#10b981' : '#94a3b8');
    const sign = rounded > 0 ? '+' : '';
    return `
        <div class="analysis-stat-row">
            <span class="analysis-label">${label}</span>
            <span class="analysis-val" style="color:${color}; font-size:13px;">${sign}${rounded.toLocaleString()} 張</span>
        </div>
    `;
}

function renderMARow(label, maValue, currentPrice) {
    if (!maValue) return `<div class="analysis-stat-row"><span class="analysis-label">${label}</span><span class="analysis-val">N/A</span></div>`;
    
    const diff = ((currentPrice - maValue) / maValue * 100).toFixed(1);
    const color = diff > 0 ? '#ef4444' : '#10b981'; // 台股紅漲綠跌
    const sign = diff > 0 ? '+' : '';
    
    return `
        <div class="analysis-stat-row">
            <span class="analysis-label">${label}</span>
            <div style="display:flex; align-items:center; gap:8px;">
                <span class="analysis-val">${maValue.toFixed(2)}</span>
                <span class="ma-tag" style="color:${color}; border: 1px solid ${color}40;">乖離 ${sign}${diff}%</span>
            </div>
        </div>
    `;
}

function renderValuationRow(label, value) {
    if (!value || isNaN(value)) return `<div class="analysis-stat-row"><span class="analysis-label">${label}</span><span class="analysis-val">N/A</span></div>`;
    
    let colorClass = 'reasonable';
    if (label.includes('便宜')) colorClass = 'cheap';
    if (label.includes('昂貴')) colorClass = 'expensive';
    
    return `
        <div class="analysis-stat-row">
            <span class="analysis-label">${label}</span>
            <span class="analysis-val ${colorClass}">${value.toFixed(2)} 元</span>
        </div>
    `;
}
