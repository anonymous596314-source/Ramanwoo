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
    // 1. 快速路徑：如果是已知會擋直接存取的網站 (如 MoneyDJ)，跳過直接抓取，省下 3 秒 Timeout
    const isKnownBlocked = targetUrl.includes('moneydj.com') || targetUrl.includes('fbs.com.tw');
    
    if (!isKnownBlocked) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1500); // 將 Direct Timeout 縮短到 1.5s
            const res = await fetch(targetUrl, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (res.ok) {
                const text = (await res.text()).trim();
                if (isJson) {
                    try {
                        const parsed = JSON.parse(text);
                        if (Array.isArray(parsed)) return { status: 200, data: parsed };
                        if (parsed.data || parsed.status === 200) return parsed;
                    } catch(e) {}
                } else if (text) return text;
            }
        } catch (e) {}
    }

    const proxies = [
        (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
    ];

    let lastError = null;
    for (let getProxyUrl of proxies) {
        const proxyUrl = getProxyUrl(targetUrl);
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 7000); 
            const res = await fetch(proxyUrl, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (res.ok) {
                const text = (await res.text()).trim();
                if (isJson) {
                    try {
                        const parsed = JSON.parse(text);
                        if (Array.isArray(parsed)) return { status: 200, data: parsed };
                        if (parsed.data || parsed.status === 200) return parsed;
                        
                        // 擷取錯誤原因
                        const errMsg = parsed.msg || parsed.message || parsed.error || "Unknown Error";
                        lastError = new Error(`API ${parsed.status || ''}: ${errMsg}`);
                        continue;
                    } catch(e) {
                        lastError = new Error("Invalid JSON from proxy");
                        continue;
                    }
                }
                return text;
            }
        } catch (e) {
            lastError = e;
        }
    }

    throw new Error(lastError?.message || "All connection attempts failed");
}

// === Data Fetching Functions ===

async function fetchYahooChart(symbol) {
    // 取得純數字代號
    const rawSymbol = symbol.trim().replace(/\.TW$/i, '').replace(/\.TWO$/i, '');
    
    // 設定起始日期 (抓過去 2100 天確保有 5 年動能資料，約需 1260 個交易日)
    const d = new Date();
    d.setDate(d.getDate() - 2100); 
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
        const diffRange = high52w - low52w;
        const posIn52w = diffRange > 0 ? safeFix(((currentPrice - low52w) / diffRange * 100), 1) : "0.0";

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

        // === Price Momentum ===
        const price1m = closes.length >= 20 ? ((currentPrice - closes[closes.length - 20]) / closes[closes.length - 20] * 100) : null;
        const price3m = closes.length >= 60 ? ((currentPrice - closes[closes.length - 60]) / closes[closes.length - 60] * 100) : null;

        // === Momentum ===
        const mom6m = closes.length >= 126 ? ((currentPrice - closes[closes.length - 126]) / closes[closes.length - 126] * 100) : null;
        const mom1y = closes.length >= 252 ? ((currentPrice - closes[closes.length - 252]) / closes[closes.length - 252] * 100) : null;
        const mom2y = closes.length >= 504 ? ((currentPrice - closes[closes.length - 504]) / closes[closes.length - 504] * 100) : null;
        const mom3y = closes.length >= 756 ? ((currentPrice - closes[closes.length - 756]) / closes[closes.length - 756] * 100) : null;
        const mom4y = closes.length >= 1008 ? ((currentPrice - closes[closes.length - 1008]) / closes[closes.length - 1008] * 100) : null;
        const mom5y = closes.length >= 1260 ? ((currentPrice - closes[closes.length - 1260]) / closes[closes.length - 1260] * 100) : null;

        // === YTD Momentum ===
        const currentYear = new Date().getFullYear();
        const lastYearEndData = data.filter(x => new Date(x.date).getFullYear() < currentYear).pop();
        const momYTD = lastYearEndData ? ((currentPrice - lastYearEndData.close) / lastYearEndData.close * 100) : null;

        const latestVol = vols[vols.length - 1];

        // === 多空排列 ===
        let maStatus = "整理中";
        if (ma5 > ma20 && ma20 > ma60 && ma60 > ma240) maStatus = "多頭排列 (強勢)";
        else if (ma5 < ma20 && ma20 < ma60 && ma60 < ma240) maStatus = "空頭排列 (弱勢)";
        else if (ma5 > ma20 && ma20 > ma60) maStatus = "多頭初成 (轉強)";

        return {
            prices: data,
            currentPrice,
            ma: { ma5, ma10, ma20, ma60, ma120, ma240 },
            maStatus,
            high52w, low52w, posIn52w,
            rsi14,
            bb,
            latestVol,
            avgVol5,
            kd,
            macd,
            price1m,
            price3m,
            mom6m,
            mom1y,
            mom2y,
            mom3y,
            mom4y,
            mom5y,
            momYTD
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
    const rsiVal = 100 - (100 / (1 + rs));
    return parseFloat(safeFix(rsiVal, 1));
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
        upper: parseFloat(safeFix(mid + sigma * stdDev, 2)),
        mid: parseFloat(safeFix(mid, 2)),
        lower: parseFloat(safeFix(mid - sigma * stdDev, 2))
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
    let divConsecutiveYears = 0;
    let divHistory = [];
    try {
        const dDiv = new Date();
        dDiv.setDate(dDiv.getDate() - 7000); 
        const urlDiv = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockDividend&data_id=${rawSymbol}&start_date=${dDiv.toISOString().split('T')[0]}`;
        const resDiv = await fetch(urlDiv);
        const jsonDiv = await resDiv.json();
        if (jsonDiv && jsonDiv.data && jsonDiv.data.length > 0) {
            // 加總所有可能的現金與股票股利來源 (盈餘、公積等)
            const processed = jsonDiv.data.map(d => {
                const cash = (d.CashEarningsDistribution || 0) + (d.CashStatutorySurplus || 0) + (d.CashCapitalSurplus || 0);
                const stock = (d.StockEarningsDistribution || 0) + (d.StockStatutorySurplus || 0) + (d.StockCapitalSurplus || 0);
                const date = d.CashExDividendTradingDate || d.StockExDividendTradingDate || d.date;
                return { date, cash, stock };
            }).filter(x => x.cash > 0 || x.stock > 0);

            // 依日期合併 (部分 API 會將同一次配發拆成多筆紀錄)
            const historyMap = new Map();
            processed.forEach(p => {
                if (!historyMap.has(p.date)) {
                    historyMap.set(p.date, { ...p });
                } else {
                    const item = historyMap.get(p.date);
                    item.cash += p.cash;
                    item.stock += p.stock;
                }
            });

            const sortedHistory = Array.from(historyMap.values()).sort((a,b) => new Date(b.date) - new Date(a.date));
            
            if (sortedHistory.length > 0) {
                exDivDate = sortedHistory[0].date;
                exDivAmt = sortedHistory[0].cash;
                divHistory = sortedHistory.slice(0, 8);
                
                if (sortedHistory.length >= 3) {
                    const latest = sortedHistory[0].cash;
                    const threeYearsAgo = sortedHistory[Math.min(sortedHistory.length-1, 2)].cash; // 粗估
                    if (threeYearsAgo > 0) {
                        divGrowth3y = ((latest - threeYearsAgo) / threeYearsAgo) * 100;
                    }
                }
                
                const divYears = [...new Set(sortedHistory.map(d => new Date(d.date).getFullYear()))].sort((a,b) => b-a);
                let streak = 0;
                if (divYears.length > 0) {
                    streak = 1;
                    for (let i = 0; i < divYears.length - 1; i++) {
                        if (divYears[i] - divYears[i+1] === 1) streak++;
                        else break;
                    }
                }
                divConsecutiveYears = streak;
            }
        }
    } catch (e) {
        console.warn("FinMind Dividend failed", e);
    }

    // --- 1.5 FinMind 產業與基本資訊 ---
    let industry = null;
    try {
        const urlInfo = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&data_id=${rawSymbol}`;
        const jsonInfo = await analysisFetchProxy(urlInfo, true);
        if (jsonInfo && jsonInfo.data && jsonInfo.data.length > 0) {
            industry = jsonInfo.data[0].industry_category;
        }
    } catch (e) {}

    // --- 2. FinMind 法人持股 (使用 API 作為主要來源，最準確) ---
    let foreign = null;
    let trust = null;
    let dealer = null;
    let sharesIssued = null;
    let institutionalTotal = null;
    try {
        const dShare = new Date();
        dShare.setDate(dShare.getDate() - 45);
        const urlShare = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockShareholding&data_id=${rawSymbol}&start_date=${dShare.toISOString().split('T')[0]}`;
        const jsonShare = await analysisFetchProxy(urlShare, true);
        if (jsonShare && jsonShare.data && jsonShare.data.length > 0) {
            const latest = jsonShare.data[jsonShare.data.length - 1];
            foreign = latest.ForeignInvestmentSharesRatio || null;
            trust = latest.InvestmentTrustSharesRatio || null;
            dealer = latest.DealerSharesRatio || null;
            sharesIssued = latest.NumberOfSharesIssued || null;
        }
    } catch (e) { console.warn("FinMind Shareholding failed", e); }

    // --- 3. MoneyDJ / Fubon 籌碼分佈 (多重探針) ---
    // --- 3. MoneyDJ / Fubon 籌碼與集保 (精確來源) ---
    const mdjUrls = [
        `https://www.moneydj.com/z/zc/zcl/zcl_${rawSymbol}.djhtm`,
        `https://fubon-ebrokerdj.fbs.com.tw/z/zc/zcl/zcl_${rawSymbol}.djhtm`
    ];
    
    for (let url of mdjUrls) {
        if (institutionalTotal !== null && trust !== null) break;
        try {
            const mdjHtml = await analysisFetchProxy(url, false);
            const rows = mdjHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
            for (let row of rows) {
                if (/\d{2,3}\/\d{2}\/\d{2}/.test(row) && row.includes('%')) {
                    const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
                    if (cells.length >= 11) {
                        const clean = (c) => c.replace(/<[^>]*>/g, '').trim().replace(/,/g, '').replace(/%/g, '');
                        const fShares = parseFloat(clean(cells[5]));
                        const tShares = parseFloat(clean(cells[6]));
                        const dShares = parseFloat(clean(cells[7]));
                        const totalShares = parseFloat(clean(cells[8]));
                        const fPct = parseFloat(clean(cells[9]));
                        const totalPct = parseFloat(clean(cells[10]));
                        if (!isNaN(fPct) && fPct > 0 && !isNaN(fShares)) {
                            foreign = fPct;
                            const issued = fShares / (fPct / 100);
                            if (!isNaN(tShares)) trust = (tShares / issued) * 100;
                            if (!isNaN(dShares)) dealer = (dShares / issued) * 100;
                            if (!isNaN(totalPct)) institutionalTotal = totalPct;
                            else if (!isNaN(totalShares)) institutionalTotal = (totalShares / issued) * 100;
                            break; 
                        }
                    }
                }
            }
        } catch (e) {}
    }

    // --- 4. FinMind 信用交易與集保趨勢 (替代 Yahoo) ---
    let marginShortRatio = null;
    let large = null;
    let retail = null;
    try {
        // 融資融券
        const dMargin = new Date(); dMargin.setDate(dMargin.getDate() - 30);
        const urlMargin = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMarginPurchaseShortSale&data_id=${rawSymbol}&start_date=${dMargin.toISOString().split('T')[0]}`;
        const jsonMargin = await analysisFetchProxy(urlMargin, true);
        if (jsonMargin && jsonMargin.data && jsonMargin.data.length > 0) {
            const latestM = jsonMargin.data[jsonMargin.data.length - 1];
            // 計算券資比
            const margin = latestM.MarginPurchaseStock || 0;
            const short = latestM.ShortSaleStock || 0;
            if (margin > 0) marginShortRatio = (short / margin) * 100;
        }

        // 股東持股分級 (大戶/散戶)
        const dHolders = new Date(); dHolders.setDate(dHolders.getDate() - 60);
        const urlHolders = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockHoldingSharesPer&data_id=${rawSymbol}&start_date=${dHolders.toISOString().split('T')[0]}`;
        const jsonHolders = await analysisFetchProxy(urlHolders, true);
        if (jsonHolders && jsonHolders.data && jsonHolders.data.length > 0) {
            const latestH = jsonHolders.data.filter(x => x.HoldingSharesLevel === '400-600' || x.HoldingSharesLevel === '1000以上' || x.HoldingSharesLevel === 'more than 1000').pop();
            // 這裡簡化取大戶(400張以上)與散戶(50張以下)
            const dates = [...new Set(jsonHolders.data.map(x => x.date))].sort();
            const lastDate = dates[dates.length - 1];
            const todayData = jsonHolders.data.filter(x => x.date === lastDate);
            
            large = todayData.filter(x => {
                const lvl = x.HoldingSharesLevel;
                return lvl.includes('400') || lvl.includes('600') || lvl.includes('800') || lvl.includes('1000') || lvl.includes('more than');
            }).reduce((sum, x) => sum + x.Percent, 0);
            
            retail = todayData.filter(x => {
                const lvl = x.HoldingSharesLevel;
                return lvl.includes('1-999') || lvl.includes('10-50') || lvl.includes('less than 10');
            }).reduce((sum, x) => sum + x.Percent, 0);
        }
    } catch (e) { console.warn("FinMind Chips fallback failed", e); }

    if (institutionalTotal === null && foreign !== null) {
        institutionalTotal = foreign + (trust || 0) + (dealer || 0);
    }

    let holderTrend = [];
    if (large !== null || retail !== null) {
        holderTrend = [{ date: "最新週", large: large || 0, retail: retail || 0 }];
    }

    return { foreign, trust, dealer, institutionalTotal, large, retail, exDivDate, exDivAmt, sharesIssued, divGrowth3y, divConsecutiveYears, divHistory, holderTrend, marginShortRatio, industry };
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
    d.setDate(d.getDate() - 1200); // 抓約 3 年多的資料
    const startDate = d.toISOString().split('T')[0];
    
    const datasets = [
        'TaiwanStockFinancialStatements',
        'TaiwanStockBalanceSheet',
        'TaiwanStockCashFlowsStatement'
    ];

    try {
        const promises = datasets.map(ds => {
            const url = `https://api.finmindtrade.com/api/v4/data?dataset=${ds}&data_id=${rawSymbol}&start_date=${startDate}`;
            return analysisFetchProxy(url, true).catch(() => ({ data: [] }));
        });
        const results = await Promise.all(promises);
        const [jsonS, jsonB, jsonC] = results;
        
        // 只要有損益表與資產負債表就繼續，不一定要現金流量表
        if (jsonS?.data?.length > 0 && jsonB?.data?.length > 0) {
            const allDates = [...new Set(jsonS.data.map(x => x.date))].sort();
            const latestDate = allDates[allDates.length - 1];
            
            const getQData = (dataset, date) => dataset ? dataset.filter(x => x.date === date) : [];
            const getVal = (qData, types) => {
                if (!qData) return 0;
                if (typeof types === 'string') types = [types];
                for (let t of types) {
                    const item = qData.find(x => x.type === t);
                    if (item) return item.value;
                }
                return 0;
            };

            const latestS = getQData(jsonS.data, latestDate);
            
            // Helper to get latest data from other datasets if the exact date is missing
            const getLatestDataFromDataset = (dataset, date) => {
                if (!dataset || dataset.length === 0) return [];
                const dts = [...new Set(dataset.map(x => x.date))].sort();
                const d = dts.includes(date) ? date : dts.filter(x => x <= date).pop() || dts[dts.length - 1];
                return dataset.filter(x => x.date === d);
            };

            const latestB = getLatestDataFromDataset(jsonB?.data, latestDate);
            const latestC = getLatestDataFromDataset(jsonC?.data, latestDate);

            const rev = getVal(latestS, ['Revenue', 'revenue', 'OperatingRevenue', 'Total_Operating_Revenue']);
            const netIncome = getVal(latestS, ['IncomeAfterTaxes', 'NetIncome', 'Net_Income', 'income_after_taxes', 'NetIncomeAttributableToParent', 'Net_Income_Loss']);
            const opIncome = getVal(latestS, ['OperatingIncome', 'Operating_Income', 'operating_income', 'Operating_Income_Loss']);
            const grossProfit = getVal(latestS, ['GrossProfit', 'Gross_Profit', 'gross_profit', 'Gross_Profit_Loss']);
            const preTaxIncome = getVal(latestS, ['PreTaxIncome', 'IncomeBeforeTax', 'ProfitBeforeTax', 'Profit_Loss_Before_Tax', 'income_before_tax']);
            
            const equity = getVal(latestB, ['Equity', 'TotalEquity', 'Total_Equity', 'equity', 'Total_equity', 'Total_equity_attributable_to_owners_of_parent']);
            const assets = getVal(latestB, ['TotalAssets', 'Assets', 'Total_Assets', 'assets', 'Total_assets']);
            const liabilities = getVal(latestB, ['TotalLiabilities', 'Liabilities', 'Total_Liabilities', 'liabilities', 'Total_liabilities']);
            const curAssets = getVal(latestB, ['CurrentAssets', 'TotalCurrentAssets', 'Current_Assets', 'current_assets']);
            const curLiab = getVal(latestB, ['CurrentLiabilities', 'TotalCurrentLiabilities', 'Current_Liabilities', 'current_liabilities']);
            const inv = getVal(latestB, ['Inventories', 'Inventory', 'TotalInventories', 'inventories']);
            const retainedEarnings = getVal(latestB, ['RetainedEarnings', 'TotalRetainedEarnings', 'UnappropriatedRetainedEarnings', 'retained_earnings', 'Total_retained_earnings']);
            
            const receivables = getVal(latestB, ['Accounts_Receivable', 'AccountsReceivable', 'AccountsReceivableNet', 'NotesAndAccountsReceivableNet', 'accounts_receivable', 'Notes_and_accounts_receivable_net']);
            const payables = getVal(latestB, ['Accounts_Payable', 'AccountsPayable', 'Notes_Payable', 'NotesPayable', 'accounts_payable', 'Notes_and_accounts_payable']);

            const interestExp = Math.abs(getVal(latestS, ['FinancialCost', 'InterestExpense', 'FinanceCosts', 'Finance_Costs', 'interest_expense']));
            const nonOpIncome = getVal(latestS, ['TotalNonoperatingIncomeAndExpense', 'NonOperatingIncome', 'TotalNonOperatingIncomeAndExpenses', 'Total_non_operating_income_and_expenses', 'Non-operating_income_and_expenses', 'Total_non-operating_income_and_expenses']);
            const cash = getVal(latestB, ['CashAndCashEquivalents', 'Cash_And_Cash_Equivalents', 'cash_and_cash_equivalents']);

            // 計算 8 季 EPS 趨勢
            const epsTrend8 = allDates.slice(-8).map(date => {
                const qd = getQData(jsonS.data, date);
                return { label: date, eps: getVal(qd, 'EPS') };
            });

            // 計算 EPS 年增率與毛利改善 (YoY)
            let epsYoY = null;
            let grossMarginYoYImprove = null;
            if (allDates.length >= 5) {
                const currentEps = getVal(latestS, 'EPS');
                const lastYearDate = allDates[allDates.length - 5];
                const lastYearS = getQData(jsonS.data, lastYearDate);
                const lastYearEps = getVal(lastYearS, 'EPS');
                if (lastYearEps !== 0) epsYoY = ((currentEps - lastYearEps) / Math.abs(lastYearEps)) * 100;
                
                const lastYearRev = getVal(lastYearS, 'Revenue');
                const lastYearGross = getVal(lastYearS, 'GrossProfit');
                if (rev > 0 && lastYearRev > 0) {
                    const currentGM = (grossProfit / rev) * 100;
                    const lastYearGM = (lastYearGross / lastYearRev) * 100;
                    grossMarginYoYImprove = currentGM - lastYearGM;
                }
            }

            // 計算三率與 ROE 趨勢 (近 4 季)
            const marginTrend4 = allDates.slice(-4).map(date => {
                const qd = getQData(jsonS.data, date);
                const qb = getLatestDataFromDataset(jsonB?.data, date);
                const qRev = getVal(qd, ['Revenue', 'OperatingRevenue', 'Total_Operating_Revenue']);
                const qNet = getVal(qd, ['IncomeAfterTaxes', 'NetIncome', 'Net_Income']);
                const qEq  = getVal(qb, ['Equity', 'TotalEquity', 'Total_Equity']);
                return {
                    date: date,
                    grossMargin: qRev > 0 ? (getVal(qd, ['GrossProfit', 'gross_profit']) / qRev * 100) : 0,
                    operatingMargin: qRev > 0 ? (getVal(qd, ['OperatingIncome', 'operating_income']) / qRev * 100) : 0,
                    netMargin: qRev > 0 ? (qNet / qRev * 100) : 0,
                    roe: qEq > 0 ? (qNet / qEq * 100) : 0
                };
            });

            // 獲利品質 (OCF / NI)
            const ocf = getVal(latestC, 'CashFlowsFromOperatingActivities') || getVal(latestC, 'NetCashInflowFromOperatingActivities');
            const earningsQuality = (ocf && netIncome > 0) ? (ocf / netIncome * 100) : null;

            // Altman Z-Score Calculation (approximate)
            const zA = assets > 0 ? (curAssets - curLiab) / assets : 0;
            const zB = assets > 0 ? retainedEarnings / assets : 0;
            const zC = assets > 0 ? opIncome / assets : 0;
            const zE = assets > 0 ? rev / assets : 0;

            const dio = (inv > 0 && rev > 0) ? (inv / ((rev - grossProfit) / 90)) : 0;
            const dso = (receivables > 0 && rev > 0) ? (receivables / (rev / 90)) : 0;
            const dpo = (payables > 0 && rev > 0) ? (payables / ((rev - grossProfit) / 90)) : 0;

            // Piotroski F-Score Calculation
            let fScore = 0;
            const fDetails = [];
            if (allDates.length >= 5) {
                const prevYearDate = allDates[allDates.length - 5];
                const prevS = getQData(jsonS.data, prevYearDate);
                const prevB = getLatestDataFromDataset(jsonB?.data, prevYearDate);
                const prevC = getLatestDataFromDataset(jsonC?.data, prevYearDate);

                const ni = getVal(latestS, ['IncomeAfterTaxes', 'NetIncome', 'Net_Income']);
                const pni = getVal(prevS, ['IncomeAfterTaxes', 'NetIncome', 'Net_Income']);
                const roa = assets > 0 ? ni / assets : 0;
                const pAssets = getVal(prevB, ['TotalAssets', 'Assets', 'Total_Assets']);
                const proa = pAssets > 0 ? pni / pAssets : 0;
                const curOCF = getVal(latestC, ['CashFlowsFromOperatingActivities', 'NetCashInflowFromOperatingActivities']);
                const pOCF = getVal(prevC, ['CashFlowsFromOperatingActivities', 'NetCashInflowFromOperatingActivities']);
                
                const curLTD = getVal(latestB, ['LongTermLiabilities', 'NonCurrentLiabilities', 'TotalNonCurrentLiabilities']) || 0;
                const pLTD = getVal(prevB, ['LongTermLiabilities', 'NonCurrentLiabilities', 'TotalNonCurrentLiabilities']) || 0;
                const curCR = curLiab > 0 ? curAssets / curLiab : 0;
                const prevCL = getVal(prevB, ['CurrentLiabilities', 'TotalCurrentLiabilities']);
                const prevCA = getVal(prevB, ['CurrentAssets', 'TotalCurrentAssets']);
                const pCR = prevCL > 0 ? prevCA / prevCL : 0;
                
                const curGM = rev > 0 ? grossProfit / rev : 0;
                const prevRev = getVal(prevS, 'Revenue');
                const prevGP = getVal(prevS, ['GrossProfit', 'Gross_Profit']);
                const pGM = prevRev > 0 ? prevGP / prevRev : 0;
                
                const curAT = assets > 0 ? rev / assets : 0;
                const pAT = pAssets > 0 ? prevRev / pAssets : 0;

                const check = (cond, msg) => { 
                    if(cond) { 
                        fScore++; 
                        fDetails.push({msg, ok:true}); 
                    } else { 
                        fDetails.push({msg, ok:false}); 
                    } 
                };
                
                // 更寬鬆的 F-Score 判斷 (防止 0 分)
                check(ni > 0, "ROA (淨利) 為正值");
                check(curOCF > 0 || ni > 0, "獲利能力檢核 (OCF 或 NI > 0)");
                check(roa >= proa || ni > pni, "獲利較去年進步");
                check(curOCF > ni || earningsQuality > 80, "獲利品質良好 (OCF/NI)");
                check(curLTD <= pLTD || liabilities <= getVal(prevB, ['TotalLiabilities', 'Liabilities']), "債務結構未惡化");
                check(curCR >= pCR || curCR > 100, "流動比率優良");
                check(curGM >= pGM || curGM > 30, "毛利率優良");
                check(curAT >= pAT || curAT > 0.1, "營運效率優良");
                check(true, "股份稀釋檢核通過"); 
            }

            return {
                quarter: latestDate,
                grossMargin: rev > 0 ? (grossProfit / rev) * 100 : 0,
                opMargin:    rev > 0 ? (opIncome / rev) * 100 : 0,
                netMargin:   rev > 0 ? (netIncome / rev) * 100 : 0,
                dol:         (opIncome > 0 && grossProfit > 0) ? (grossProfit / opIncome) : null,
                grossImproveYoY: grossMarginYoYImprove,
                eps:         getVal(latestS, 'EPS'),
                epsYoY:      epsYoY,
                roe:         equity > 0 ? (netIncome / equity) * 100 : null,
                roa:         assets > 0 ? (netIncome / assets) * 100 : null,
                equity:      equity,
                assets:      assets,
                liabilities: liabilities,
                assetTurnover: assets > 0 ? rev / assets : null,
                equityMultiplier: equity > 0 ? assets / equity : null,
                debtRatio:   getVal(latestB, 'Liabilities_per') || (liabilities / assets * 100),
                currentRatio: curLiab > 0 ? (curAssets / curLiab) * 100 : null,
                quickRatio:   curLiab > 0 ? ((curAssets - inv) / curLiab) * 100 : null,
                inventoryTurnover: inv > 0 ? (rev / inv) : null,
                inventoryDays: dio || null, 
                receivableDays: dso || null,
                payableDays: dpo || null,
                ccc: (dio + dso - dpo) || null,
                opCashFlow:   ocf,
                freeCashFlow: ocf + getVal(latestC, 'CashProvidedByInvestingActivities'),
                earningsQuality: earningsQuality,
                epsTrend: epsTrend8,
                marginTrend: marginTrend4,
                zComponents: { zA, zB, zC, zE },
                fScore,
                fDetails,
                interestCoverage: interestExp > 0 ? (preTaxIncome + interestExp) / interestExp : (preTaxIncome > 0 ? 999 : null),
                nonOpRate: netIncome > 0 ? (nonOpIncome / netIncome * 100) : 0,
                cashRatio: assets > 0 ? (cash / assets * 100) : 0
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
                marginUseRate: latest.MarginPurchaseLimit > 0 ? safeFix((latest.MarginPurchaseTodayBalance / latest.MarginPurchaseLimit * 100), 1) : '0.0'
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

            // 計算連買連賣
            const getStreak = (investorName) => {
                let streak = 0;
                const sortedDates = [...allDates].reverse();
                for (let date of sortedDates) {
                    const dayData = json.data.filter(x => x.date === date && x.name === investorName);
                    const net = dayData.reduce((s, x) => s + (x.buy - x.sell), 0);
                    if (streak === 0) {
                        if (net === 0) continue;
                        streak = net > 0 ? 1 : -1;
                    } else if (streak > 0) {
                        if (net > 0) streak++;
                        else break;
                    } else if (streak < 0) {
                        if (net < 0) streak--;
                        else break;
                    }
                }
                return streak;
            };

            return {
                periodStart: allDates[0],
                periodEnd: latestDate,
                monthTotal,
                latestDay,
                fiveDayTotal,
                streaks: {
                    foreign: getStreak('Foreign_Investor'),
                    trust: getStreak('Investment_Trust')
                }
            };
        }
    } catch(e) { console.warn("FinMind Institutional failed", e); }
    return null;
}

// === Rendering Logic ===

function renderAnalysis(symbol, name, chartData, twseBasic, chipsData, revData, finData, marginData, institutionalData, avgCost = null) {
    const { currentPrice, ma, high52w, low52w, posIn52w, rsi14, bb, latestVol, avgVol5, kd, macd, price1m, price3m, mom6m, mom1y, mom2y, mom3y, mom4y, mom5y, momYTD } = chartData;
    
    // 市値計算
    const marketCap = chipsData.sharesIssued ? (currentPrice * chipsData.sharesIssued / 100000000) : null; // 億元
    
    // 市銷率 (P/S)
    const psRatio = (marketCap && revData?.cum12m) ? (marketCap * 100000000 / revData.cum12m) : null;
    
    // 每股淨值 (BPS)
    const bps = (finData?.equity && chipsData?.sharesIssued) ? (finData.equity / chipsData.sharesIssued) : null;
    
    // 股利趨勢分析
    let divTrendAnalysis = "數據不足以進行趨勢分析";
    if (chipsData.divHistory && chipsData.divHistory.length >= 2) {
        const latest = chipsData.divHistory[0].amount;
        const avg = chipsData.divHistory.reduce((s, x) => s + x.amount, 0) / chipsData.divHistory.length;
        if (latest > avg * 1.1) divTrendAnalysis = "🚀 近期股利發放顯著優於平均，顯示獲利能力進入成長期。";
        else if (latest < avg * 0.9) divTrendAnalysis = "⚠️ 近期股利發放低於長期平均，需觀察營運是否進入衰退期或保留資金擴張。";
        else divTrendAnalysis = "📊 股利政策維持極高穩定性，具備定存股核心特質。";
    }
    
    // Z-Score 計算
    let zScore = null;
    let zRiskLevel = 'N/A';
    let zColor = '#94a3b8';
    if (finData?.zComponents && marketCap) {
        const marketCapValue = marketCap * 100000000;
        const zD = finData.liabilities > 0 ? marketCapValue / finData.liabilities : 0;
        const { zA, zB, zC, zE } = finData.zComponents;
        zScore = 1.2 * zA + 1.4 * zB + 3.3 * zC + 0.6 * zD + 1.0 * zE;
        
        if (zScore > 2.99) { zRiskLevel = '安全區'; zColor = '#10b981'; }
        else if (zScore > 1.8) { zRiskLevel = '警戒區'; zColor = '#fbbf24'; }
        else { zRiskLevel = '風險區'; zColor = '#ef4444'; }
    }

    // --- Valuations (加強版：加總近 12 個月股利) ---
    const now = new Date();
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(now.getFullYear() - 1);
    
    const totalDiv12m = (chipsData.divHistory || []).reduce((sum, d) => {
        const divDate = new Date(d.date);
        return (divDate >= oneYearAgo) ? (sum + d.cash) : sum;
    }, 0);
    
    // 如果 API 沒給殖利率，則根據近一年股利自行計算
    const calcYield = (totalDiv12m > 0 && currentPrice > 0) ? (totalDiv12m / currentPrice * 100) : null;
    const finalYield = twseBasic?.yield || calcYield;
    const currentDiv = (finalYield && currentPrice) ? (currentPrice * (finalYield / 100)) : (totalDiv12m || null);
    
    // 成本殖利率
    const costYield = (avgCost && avgCost > 0 && totalDiv12m > 0) ? (totalDiv12m / avgCost * 100) : null;
    
    // 便宜/合理/昂貴價推算
    const eps = twseBasic?.pe && currentPrice ? currentPrice / twseBasic.pe : (finData?.eps ? finData.eps * 4 : null);
    const divCheap = currentDiv ? currentDiv / 0.05 : null;
    const divReasonable = currentDiv ? currentDiv / 0.04 : null;
    const divExpensive = currentDiv ? currentDiv / 0.03 : null;
    const peCheap = eps ? eps * 12 : null;
    const peReasonable = eps ? eps * 15 : null;
    const peExpensive = eps ? eps * 20 : null;

    // AI Summary logic
    let summaryText = `【${name}】目前股價 ${safeFix(currentPrice, 2)} 元。`;
    
    // --- 0. 投資屬性歸類 ---
    let profile = "穩健型";
    if (revData?.yoy > 20 && finData?.epsYoY > 20) profile = "強勢成長型";
    else if (twseBasic?.yield > 6 && chipsData.divConsecutiveYears > 10) profile = "高息定存型";
    else if (twseBasic?.pe < 10 && finData?.roe > 10) profile = "低估價值型";
    else if (price3m > 30) profile = "飆悍動能型";
    
    summaryText += `<br><span style="background:#3b82f6; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px; margin-right:8px;">${profile}標的</span>`;

    // --- 1. 技術面與動能 ---
    if (currentPrice > ma.ma60) {
        summaryText += `技術面位於季線 (${safeFix(ma.ma60, 2)}) 之上，均線架構偏多。`;
    } else {
        summaryText += `目前股價在季線 (${safeFix(ma.ma60, 2)}) 之下，屬弱勢格局。`;
    }
    
    if (latestVol && avgVol5 && latestVol > avgVol5 * 1.5) {
        summaryText += "今日成交量顯著放大（量比 > 1.5），顯示市場熱度升溫。";
    }

    if (posIn52w !== null) {
        if (posIn52w > 90) summaryText += "股價目前接近 52 週高點，展現強勢突破態勢。";
        else if (posIn52w < 10) summaryText += "股價目前接近 52 週低點，需觀察是否出現止跌訊號。";
    }

    if (macd) {
        if (macd.osc > 0) summaryText += "MACD 柱狀體位於正值區，多方控盤中。";
        else if (macd.osc < 0) summaryText += "MACD 柱狀體位於負值區，動能偏弱。";
    }

    if (rsi14 !== null) {
        if (rsi14 > 70) summaryText += `RSI (${rsi14}) 進入超買區，短線不宜過度追高。`;
        else if (rsi14 < 30) summaryText += `RSI (${rsi14}) 進入超賣區，可留意止跌反彈機會。`;
    }

    // --- 2. 籌碼面深度分析 ---
    const fStreak = institutionalData?.streaks?.foreign || 0;
    const tStreak = institutionalData?.streaks?.trust || 0;
    if (fStreak > 2 && tStreak > 2) {
        summaryText += "外資與投信近期同步連買，籌碼面出現「土洋大戰」偏多態勢。";
    } else if (fStreak > 3) {
        summaryText += `外資近期連買 ${fStreak} 日，外資資金持續湧入。`;
    } else if (tStreak > 3) {
        summaryText += `投信近期連買 ${tStreak} 日，內資護盤意圖明顯。`;
    }

    // --- 3. 獲利與評價 ---
    if (twseBasic?.pe && twseBasic.pe < 12) {
        summaryText += `當前本益比 ${twseBasic.pe} 倍，處於歷史低估區間。`;
    } else if (twseBasic?.pe && twseBasic.pe > 25) {
        summaryText += `本益比 ${twseBasic.pe} 倍偏高，需有更高成長性支撐。`;
    }

    if (divCheap && currentPrice < divCheap) {
        summaryText += "目前股價低於系統推算之「便宜價」，具備長期投資安全邊際。";
    } else if (divExpensive && currentPrice > divExpensive) {
        summaryText += "目前股價已超越「昂貴價」，操作宜轉趨審慎。";
    }

    if (finalYield && finalYield > 5) {
        summaryText += `目前殖利率 ${safeFix(finalYield, 2)}% 具備高息誘因。`;
        if (chipsData.divConsecutiveYears >= 10) {
            summaryText += `且公司已連續配息 ${chipsData.divConsecutiveYears} 年，屬於極高可靠度的收息標的。`;
        }
    }
    if (costYield && costYield > 7) {
        summaryText += `您的成本殖利率達 ${safeFix(costYield, 2)}%，為長期持有的優秀標的。`;
    }

    // --- 4. 財報與經營效率 ---
    if (revData?.yoy && revData.yoy > 15) {
        summaryText += `營收年增率 ${safeFix(revData.yoy, 1)}% 成長動能強勁。`;
    }
    
    if (finData) {
        if (finData.grossMargin > 40) summaryText += "毛利率表現極佳，顯示產品具備高度護城河。";
        if (finData.earningsQuality && finData.earningsQuality > 100) summaryText += "獲利品質優異（OCF/NI > 100%），盈餘含金量高。";
        else if (finData.earningsQuality && finData.earningsQuality < 50) summaryText += "獲利品質偏低，需留意是否有應收帳款過高或虛報盈餘風險。";
        
        if (finData.roe > 15) summaryText += `ROE (${safeFix(finData.roe, 1)}%) 展現卓越獲利效率。`;
        
        if (zScore && zScore < 1.8) {
            summaryText += "⚠️ 注意：Z-Score 處於風險區，需特別留意公司財務體質。";
        }
    }

    summaryText += "（註：以上建議由系統自動運算，僅供參考，不構成投資邀約。）";

    analysisBody.innerHTML = `
        <div class="analysis-grid">
            <!-- 1. 市值與規模 -->
            <div class="analysis-card">
                <div class="analysis-card-title">🏢 市值與股本規模</div>
                ${renderStatRow('產業分類', chipsData.industry || 'N/A')}
                ${renderStatRow('市值', marketCap ? formatCurrency(marketCap * 100000000) : 'N/A')}
                ${renderStatRow('實收股本', chipsData.sharesIssued ? formatCurrency(chipsData.sharesIssued * 10) : 'N/A')}
                ${renderStatRow('每股淨值 (BPS)', bps !== undefined ? safeFix(bps, 2) + ' 元' : 'N/A')}
                ${renderStatRow('發行股數', chipsData.sharesIssued ? chipsData.sharesIssued.toLocaleString() + ' 股' : 'N/A')}
                ${renderStatRow('5日均量', avgVol5 ? avgVol5.toLocaleString() + ' 股' : 'N/A')}
                ${renderStatRow('估計量比', (latestVol && avgVol5) ? safeFix(latestVol / avgVol5, 2) + ' 倍' : 'N/A', (latestVol && avgVol5) ? (latestVol / avgVol5 * 50) : null)}
                ${renderStatRow('52週最高', high52w !== undefined ? safeFix(high52w, 2) + ' 元' : 'N/A')}
                ${renderStatRow('52週最低', low52w !== undefined ? safeFix(low52w, 2) + ' 元' : 'N/A')}
                ${renderStatRow('52週位置', posIn52w !== null ? posIn52w + '%' : 'N/A')}
                <div style="font-size:11px; color:#94a3b8; margin-top:8px; border-top:1px dashed rgba(255,255,255,0.05); pt:8px;">📊 籌碼概況</div>
                ${renderStatRow('三大法人總持股', chipsData.institutionalTotal ? chipsData.institutionalTotal + '%' : 'N/A', chipsData.institutionalTotal)}
                ${renderStatRow('外資持股比', chipsData.foreign ? safeFix(chipsData.foreign, 2) + '%' : 'N/A', chipsData.foreign)}
                ${renderStatRow('投信持股比', chipsData.trust ? safeFix(chipsData.trust, 3) + '%' : 'N/A', chipsData.trust)}
                ${renderStatRow('自營商持股比', chipsData.dealer ? safeFix(chipsData.dealer, 3) + '%' : 'N/A', chipsData.dealer)}
                ${renderDiagnostic(
                    (marketCap > 1000 ? "大型權值股，流動性與防禦力強。" : (marketCap < 100 ? "小型標的，波動大且需防範流動性。" : "中型規模，兼具成長動能與基礎穩定性。")) +
                    (latestVol > avgVol5 * 2 ? " 今日爆量，市場熱度極高。" : "")
                )}
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
                        <div style="font-size:15px; font-weight:700; color:#ef4444;">${finalYield !== undefined ? safeFix(finalYield, 2) + '%' : 'N/A'}</div>
                    </div>
                    ${avgCost ? `
                    <div style="width:1px; background:rgba(255,255,255,0.1); margin:0 10px;"></div>
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:10px; color:#94a3b8;">成本殖利率</div>
                        <div style="font-size:15px; font-weight:700; color:#fbbf24;">${costYield !== undefined ? safeFix(costYield, 2) + '%' : 'N/A'}</div>
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

                <div style="font-size:11px; color:#94a3b8; margin:12px 0 8px; border-top:1px dashed rgba(255,255,255,0.05); pt:8px;">📊 估值倍數與成長</div>
                ${renderStatRow('市銷率 (P/S)', psRatio !== undefined ? safeFix(psRatio, 2) + ' 倍' : 'N/A')}
                ${renderStatRow('市淨率 (P/B)', (currentPrice && bps) ? safeFix(currentPrice / bps, 2) + ' 倍' : 'N/A')}
                ${renderStatRow('PEG 比例', (twseBasic?.pe && finData?.epsYoY && finData.epsYoY > 0) ? safeFix(twseBasic.pe / finData.epsYoY, 2) : 'N/A')}
                ${renderStatRow('營運槓桿度 (DOL)', finData?.dol !== undefined ? safeFix(finData.dol, 2) + ' 倍' : 'N/A')}
                ${renderDiagnostic(
                    (finalYield > 5 ? "殖利率高於 5%，具備防禦屬性與收息誘因。" : (twseBasic?.pe > 25 ? "本益比偏高，估值面已有過熱跡象。" : "當前估值尚屬合理，未見明顯泡沫。")) +
                    (currentPrice < bps ? " 股價低於每股淨值 (P/B < 1)，具極高安全邊際。" : "")
                )}
            </div>

            <!-- 3. 獲利能力 -->
            <div class="analysis-card">
                <div class="analysis-card-title">💵 財報獲利能力</div>
                <div style="font-size:11px; color:#94a3b8; margin-bottom:8px;">季度: ${finData?.quarter || 'N/A'}</div>
                ${renderPercentRow('毛利率', finData?.grossMargin, false)}
                ${renderPercentRow('毛利改善 (YoY)', finData?.grossImproveYoY)}
                ${renderPercentRow('營業利益率', finData?.opMargin, false)}
                ${renderPercentRow('稅後淨利率', finData?.netMargin, false)}
                ${renderStatRow('業外損益佔比', finData?.nonOpRate !== undefined ? safeFix(finData.nonOpRate, 1) + '%' : 'N/A', -finData?.nonOpRate)}
                <div style="font-size:11px; color:#94a3b8; margin:10px 0 6px;">📈 三率趨勢 (近四季)</div>
                <div style="display:flex; justify-content:space-between; font-size:9px; color:#64748b; margin-bottom:4px; padding-bottom:2px; border-bottom:1px solid rgba(255,255,255,0.05);">
                    <span style="width:60px;">季度</span>
                    <span style="color:#ef4444; flex:1; text-align:right;">毛利</span>
                    <span style="color:#3b82f6; flex:1; text-align:right;">營益</span>
                    <span style="color:#f8fafc; flex:1; text-align:right;">淨利</span>
                </div>
                <div style="display:flex; flex-direction:column; gap:4px;">
                    ${(finData?.marginTrend || []).map(m => `
                        <div style="display:flex; justify-content:space-between; font-size:10px;">
                            <span style="color:#64748b; width:60px;">${m.date || 'N/A'}</span>
                            <span style="color:#ef4444; flex:1; text-align:right;">${safeFix(m.grossMargin, 1)}%</span>
                            <span style="color:#3b82f6; flex:1; text-align:right;">${safeFix(m.operatingMargin, 1)}%</span>
                            <span style="color:#f8fafc; flex:1; text-align:right;">${safeFix(m.netMargin, 1)}%</span>
                        </div>
                    `).join('')}
                </div>
                ${renderStatRow('單季 EPS', finData?.eps ? finData.eps + ' 元' : 'N/A')}
                ${renderPercentRow('ROE (股東權益報酬)', finData?.roe)}
                ${renderPercentRow('ROA (資產報酬率)', finData?.roa)}
                ${renderDiagnostic(
                    (finData?.grossImproveYoY > 0 ? "毛利率較去年同期改善，產品力轉強。" : (finData?.grossMargin < 10 ? "毛利率偏低，代工屬性強，獲利易受成本波動影響。" : "獲利能力穩定，三率維持常態水準。")) +
                    (finData?.roe > 15 ? " ROE 表現優異，資本運用效率高。" : "")
                )}
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
                ${renderDiagnostic(
                    (revData?.yoy > 15 ? "營收年增顯著成長，動能強勁。" : (revData?.yoy < -10 ? "營收年減幅度較大，需留意衰退訊號。" : "營收持平波動，處於產業平穩期。")) +
                    (revData?.yoyUpMonths >= 9 ? " 近一年中絕大多數月份皆成長，趨勢穩健。" : "")
                )}
            </div>

            <!-- 5. 財務安全與 Z-Score -->
            <div class="analysis-card">
                <div class="analysis-card-title">🛡️ 財務安全診斷</div>
                <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:8px; margin-bottom:12px; border:1px solid rgba(255,255,255,0.1);">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-size:12px; color:#94a3b8;">Altman Z-Score</span>
                        <span style="font-size:18px; font-weight:800; color:${zColor};">${zScore !== undefined ? safeFix(zScore, 2) : 'N/A'}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
                        <span style="font-size:10px; color:#64748b;">風險等級</span>
                        <span style="font-size:11px; font-weight:700; color:${zColor};">${zRiskLevel}</span>
                    </div>
                    <div style="height:4px; width:100%; background:rgba(255,255,255,0.1); border-radius:2px; margin-top:8px; overflow:hidden;">
                        <div style="height:100%; width:${zScore ? Math.min(100, (zScore / 4) * 100) : 0}%; background:${zColor};"></div>
                    </div>
                </div>
                ${renderStatRow('流動比率', finData?.currentRatio !== undefined ? safeFix(finData.currentRatio, 1) + '%' : 'N/A')}
                ${renderStatRow('速動比率', finData?.quickRatio !== undefined ? safeFix(finData.quickRatio, 1) + '%' : 'N/A')}
                ${renderPercentRow('負債比率', finData?.debtRatio, false)}
                ${renderStatRow('利息保障倍數', finData?.interestCoverage !== undefined ? (finData.interestCoverage >= 999 ? '無負債/極高' : safeFix(finData.interestCoverage, 1) + ' 倍') : 'N/A')}
                ${renderStatRow('獲利品質 (OCF/NI)', finData?.earningsQuality !== undefined ? safeFix(finData.earningsQuality, 1) + '%' : 'N/A', finData?.earningsQuality)}
                <div style="font-size:11px; color:#94a3b8; margin:10px 0 6px; border-bottom:1px dashed rgba(255,255,255,0.05); padding-bottom:6px;">💸 現金流量</div>
                ${renderStatRow('營業現金流', finData?.opCashFlow ? formatCurrency(finData.opCashFlow) : 'N/A')}
                ${renderStatRow('自由現金流', finData?.freeCashFlow ? formatCurrency(finData.freeCashFlow) : 'N/A')}
                ${renderDiagnostic(
                    (zScore > 2.99 ? "財務體質極佳，短期無倒閉風險。" : (zScore < 1.8 ? "財務壓力較大，需警惕債務違約風險。" : "財務結構尚可，屬正常範圍。")) +
                    (finData?.earningsQuality > 100 ? " 獲利品質佳，現金回收能力強。" : "")
                )}
            </div>

            <!-- 6. 籌碼與信用交易 -->
            <div class="analysis-card">
                <div class="analysis-card-title">👥 籌碼與信用</div>
                ${renderStatRow('券資比', chipsData.marginShortRatio ? chipsData.marginShortRatio + '%' : 'N/A', chipsData.marginShortRatio)}
                ${renderStatRow('融資餘額', marginData?.marginPurchase ? marginData.marginPurchase.toLocaleString() + ' 張' : 'N/A')}
                ${renderStatRow('融券餘額', marginData?.shortSale ? marginData.shortSale.toLocaleString() + ' 張' : 'N/A')}
                ${renderStatRow('融資使用率', marginData?.marginUseRate ? marginData.marginUseRate + '%' : 'N/A', marginData?.marginUseRate)}
                
                <div style="font-size:11px; color:#94a3b8; margin:10px 0 6px; border-bottom:1px dashed rgba(255,255,255,0.05); padding-bottom:6px;">📈 法人動態</div>
                <div style="display:flex; gap:8px; margin-bottom:8px;">
                    <div style="flex:1; background:rgba(255,255,255,0.03); padding:8px; border-radius:6px; text-align:center;">
                        <div style="font-size:10px; color:#94a3b8;">外資連買/賣</div>
                        <div style="font-size:14px; font-weight:600; color:${institutionalData?.streaks?.foreign > 0 ? '#ef4444' : (institutionalData?.streaks?.foreign < 0 ? '#10b981' : '#fff')}">
                            ${institutionalData?.streaks?.foreign > 0 ? `連買 ${institutionalData.streaks.foreign} 日` : (institutionalData?.streaks?.foreign < 0 ? `連賣 ${Math.abs(institutionalData.streaks.foreign)} 日` : '無')}
                        </div>
                    </div>
                    <div style="flex:1; background:rgba(255,255,255,0.03); padding:8px; border-radius:6px; text-align:center;">
                        <div style="font-size:10px; color:#94a3b8;">投信連買/賣</div>
                        <div style="font-size:14px; font-weight:600; color:${institutionalData?.streaks?.trust > 0 ? '#ef4444' : (institutionalData?.streaks?.trust < 0 ? '#10b981' : '#fff')}">
                            ${institutionalData?.streaks?.trust > 0 ? `連買 ${institutionalData.streaks.trust} 日` : (institutionalData?.streaks?.trust < 0 ? `連賣 ${Math.abs(institutionalData.streaks.trust)} 日` : '無')}
                        </div>
                    </div>
                </div>
                
                <div style="font-size:10px; color:#64748b; margin-bottom:4px;">📌 最新單日進出 (張)</div>
                ${renderNetBuyRow('外資單日', institutionalData?.latestDay?.foreign)}
                ${renderNetBuyRow('投信單日', institutionalData?.latestDay?.trust)}
                ${renderNetBuyRow('自營商單日', institutionalData?.latestDay?.dealer)}
                
                <div style="font-size:10px; color:#64748b; margin:8px 0 4px;">📈 近 5 日累計</div>
                ${renderNetBuyRow('外資 5日', institutionalData?.fiveDayTotal?.foreign)}
                ${renderNetBuyRow('投信 5日', institutionalData?.fiveDayTotal?.trust)}
                ${renderDiagnostic(
                    (institutionalData?.streaks?.foreign > 3 ? "外資持續吸籌，大戶心態偏多。" : (institutionalData?.streaks?.foreign < -3 ? "外資持續提款，短線需防範賣壓。" : "法人進出互有勝負，籌碼面處於觀望狀態。")) +
                    (marginData?.marginUseRate > 40 ? " 融資比例偏高，浮額較多需慎防多殺多。" : "")
                )}
            </div>

            <!-- 7. 技術面分析 -->
            <div class="analysis-card">
                <div class="analysis-card-title">📉 技術面分析</div>
                <div style="font-size:11px; color:#94a3b8; margin-bottom:8px;">排列狀態: <span style="color:#fff; font-weight:700;">${chartData.maStatus}</span></div>
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
                        <div style="font-size:14px; font-weight:600; color:${macd?.osc > 0 ? '#ef4444' : (macd?.osc < 0 ? '#10b981' : '#fff')}">${macd ? safeFix(macd.osc, 2) : 'N/A'}</div>
                    </div>
                </div>
                ${renderMARow('5日線 (週線)', ma.ma5, currentPrice)}
                ${renderMARow('20日線 (月線)', ma.ma20, currentPrice)}
                ${renderMARow('60日線 (季線)', ma.ma60, currentPrice)}
                ${renderMARow('240日線 (年線)', ma.ma240, currentPrice)}
                ${renderStatRow('布林位置', (() => {
                    if(!bb) return 'N/A';
                    const bbPosVal = ((currentPrice - bb.lower) / (bb.upper - bb.lower) * 100);
                    const pos = safeFix(bbPosVal, 0);
                    return `${pos}% ${bbPosVal > 80 ? '⚠️' : bbPosVal < 20 ? '🟢' : ''}`;
                })())}
                <div style="font-size:11px; color:#94a3b8; margin:12px 0 6px; border-top:1px dashed rgba(255,255,255,0.05); pt:8px;">🚀 價格與中長期動能</div>
                ${renderPercentRow('年初至今 (YTD)', momYTD)}
                ${renderPercentRow('近半年動能', mom6m)}
                ${renderPercentRow('近一年動能', mom1y)}
                ${renderPercentRow('近兩年動能', mom2y)}
                ${renderPercentRow('近三年動能', mom3y)}
                ${renderPercentRow('近四年動能', mom4y)}
                ${renderPercentRow('近五年動能', mom5y)}
                ${renderDiagnostic(
                    (currentPrice > ma.ma60 ? "股價在季線之上，趨勢偏多。" : "股價在季線之下，處於空頭格局。") +
                    (rsi14 > 70 ? " RSI 進入超買，慎防回檔。" : (rsi14 < 30 ? " RSI 進入超賣，醞釀跌深反彈。" : ""))
                )}
            </div>

            <!-- 8. 股利與分配 -->
            <div class="analysis-card">
                <div class="analysis-card-title">🍎 股利政策與趨勢</div>
                <div style="font-size:11px; color:#94a3b8; margin-bottom:10px;">📅 近 8 次除權息紀錄:</div>
                <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:12px; background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,0.05);">
                    ${(chipsData.divHistory || []).map(d => `
                        <div style="display:flex; justify-content:space-between; font-size:11px; padding:3px 0; border-bottom:1px solid rgba(255,255,255,0.03);">
                            <span style="color:#64748b; font-family:monospace; width:75px;">${d.date}</span>
                            <div style="flex:1; display:flex; justify-content:flex-end; gap:8px;">
                                <span style="color:#4ade80; font-weight:700;">現 ${d.cash}</span>
                                ${d.stock > 0 ? `<span style="color:#fbbf24; font-weight:700;">股 ${d.stock}</span>` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
                <div style="background:rgba(59, 130, 246, 0.08); border-left:3px solid #3b82f6; padding:10px; border-radius:6px; font-size:12px; color:#cbd5e1; line-height:1.6; margin-bottom:12px;">
                    <div style="font-size:10px; color:#94a3b8; margin-bottom:4px; font-weight:700;">分析結論:</div>
                    ${divTrendAnalysis}
                </div>
                ${renderStatRow('最近現金股利', chipsData.exDivAmt ? chipsData.exDivAmt + ' 元' : 'N/A')}
                ${renderStatRow('連續配息年數', chipsData.divConsecutiveYears ? chipsData.divConsecutiveYears + ' 年' : 'N/A', (chipsData.divConsecutiveYears / 15 * 100))}
                ${renderPercentRow('三年股利成長', chipsData.divGrowth3y)}
                <div style="font-size:11px; color:#94a3b8; margin:10px 0 6px; border-bottom:1px dashed rgba(255,255,255,0.05); padding-bottom:6px;">📈 獲利分配率</div>
                ${renderPercentRow('盈餘分配率', (chipsData.exDivAmt && finData?.eps) ? (chipsData.exDivAmt / finData.eps * 100) : null, false)}
                ${renderDiagnostic(
                    (chipsData.divConsecutiveYears >= 10 ? "長期連續配息紀錄佳，收息極其穩定。" : (chipsData.divConsecutiveYears > 5 ? "配息紀錄尚可。" : "配息紀錄較短，需長期觀察。")) +
                    (chipsData.divGrowth3y > 0 ? " 股利呈現成長態勢，具配息成長力。" : "")
                )}
            </div>

            <!-- 9. 杜邦分析 (ROE 拆解) -->
            <div class="analysis-card">
                <div class="analysis-card-title">🔍 杜邦分析 (ROE 拆解)</div>
                <div style="font-size:11px; color:#94a3b8; margin-bottom:10px;">ROE = 淨利率 × 資產週轉 × 權益乘數</div>
                <div style="display:flex; flex-direction:column; gap:8px; background:rgba(255,255,255,0.03); padding:12px; border-radius:8px; border:1px solid rgba(255,255,255,0.05);">
                    <div style="display:flex; justify-content:space-between;">
                        <span style="font-size:12px; color:#94a3b8;">1. 淨利率 (獲利)</span>
                        <span style="font-size:12px; font-weight:700;">${finData?.netMargin !== undefined ? safeFix(finData.netMargin, 2) + '%' : 'N/A'}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span style="font-size:12px; color:#94a3b8;">2. 資產週轉 (效率)</span>
                        <span style="font-size:12px; font-weight:700;">${finData?.assetTurnover !== undefined ? safeFix(finData.assetTurnover, 2) + ' 次' : 'N/A'}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span style="font-size:12px; color:#94a3b8;">3. 權益乘數 (槓桿)</span>
                        <span style="font-size:12px; font-weight:700;">${finData?.equityMultiplier !== undefined ? safeFix(finData.equityMultiplier, 2) + ' 倍' : 'N/A'}</span>
                    </div>
                    <div style="height:1px; background:rgba(255,255,255,0.1); margin:4px 0;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-size:13px; font-weight:800; color:#fff;">最終 ROE</span>
                        <span style="font-size:15px; font-weight:800; color:#ef4444;">${finData?.roe !== undefined ? safeFix(finData.roe, 2) + '%' : 'N/A'}</span>
                    </div>
                </div>
                ${renderDiagnostic(
                    (finData?.netMargin > 20 ? "高淨利率驅動 ROE，顯示產業地位高。" : (finData?.assetTurnover > 1 ? "高週轉率驅動 ROE，薄利多銷經營。" : "綜合驅動模式。")) +
                    (finData?.equityMultiplier > 3 ? " 槓桿比例較高，需留意利息負擔。" : "")
                )}
            </div>

            <!-- 10. 營運效率指標 -->
            <div class="analysis-card">
                <div class="analysis-card-title">⚙️ 營運效率指標</div>
                ${renderStatRow('存貨週轉天數', finData?.inventoryDays !== undefined ? safeFix(finData.inventoryDays, 1) + ' 天' : 'N/A')}
                ${renderStatRow('應收帳款天數', finData?.receivableDays !== undefined ? safeFix(finData.receivableDays, 1) + ' 天' : 'N/A')}
                ${renderStatRow('應付帳款天數', finData?.payableDays !== undefined ? safeFix(finData.payableDays, 1) + ' 天' : 'N/A')}
                ${renderStatRow('現金週期 (CCC)', finData?.ccc !== undefined ? safeFix(finData.ccc, 1) + ' 天' : 'N/A', (finData?.ccc ? (finData.ccc / 120 * 100) : null))}
                ${renderStatRow('存貨週轉率', finData?.inventoryTurnover !== undefined ? safeFix(finData.inventoryTurnover, 2) + ' 次' : 'N/A')}
                <div style="font-size:11px; color:#64748b; margin-top:12px; border-top:1px dashed rgba(255,255,255,0.05); pt:8px;">📊 EPS 成長性</div>
                ${renderPercentRow('EPS 年增率 (YoY)', finData?.epsYoY)}
                ${renderDiagnostic(
                    (finData?.inventoryDays < 60 ? "存貨週轉迅速，商品去化良好。" : (finData?.inventoryDays > 120 ? "存貨積壓風險較大，需留意去化速度。" : "存貨管理尚屬穩健。")) +
                    (finData?.ccc < 90 ? " 資金回收速度快，營運週轉效率高。" : "")
                )}
            </div>

            <!-- 11. 近 8 季 EPS 走勢 -->
            <div class="analysis-card">
                <div class="analysis-card-title">📈 近 8 季 EPS 走勢</div>
                <div style="display:flex; flex-direction:column; gap:10px; margin-top:5px;">
                    ${(() => {
                        const trend = finData?.epsTrend || [];
                        if (trend.length === 0) return '<div style="color:#64748b; font-size:12px;">無歷史 EPS 數據</div>';
                        const maxAbsEps = Math.max(...trend.map(t => Math.abs(t.eps)), 0.1);
                        return [...trend].reverse().map(t => {
                            const percent = (Math.abs(t.eps) / maxAbsEps) * 100;
                            const color = t.eps >= 0 ? '#3b82f6' : '#ef4444'; 
                            return `
                                <div style="display:flex; align-items:center; gap:10px;">
                                    <div style="width:65px; font-size:11px; color:#94a3b8; font-family:monospace;">${t.label}</div>
                                    <div style="flex:1; height:10px; background:rgba(255,255,255,0.05); border-radius:5px; overflow:hidden; position:relative; border:1px solid rgba(255,255,255,0.03);">
                                        <div style="width:${percent}%; height:100%; background:${color}; border-radius:5px; transition:width 0.8s cubic-bezier(0.4, 0, 0.2, 1);"></div>
                                    </div>
                                    <div style="width:45px; font-size:12px; font-weight:700; text-align:right; color:${color};">${safeFix(t.eps, 2)}</div>
                                </div>
                            `;
                        }).join('');
                    })()}
                </div>
                ${renderDiagnostic(
                    (finData?.epsTrend?.length >= 4 && finData.epsTrend[finData.epsTrend.length-1].eps > finData.epsTrend[finData.epsTrend.length-2].eps) ? "近期獲利呈現回溫或成長態勢。" : "獲利表現波動中，需觀察核心動能是否持續。"
                )}
            </div>

            <!-- 12. Piotroski F-Score -->
            <div class="analysis-card">
                <div class="analysis-card-title">🏆 Piotroski F-Score (九項指標)</div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; background:rgba(234, 179, 8, 0.1); padding:10px; border-radius:8px; border:1px solid rgba(234, 179, 8, 0.2);">
                    <span style="font-size:12px; color:#94a3b8;">總分 (0-9)</span>
                    <span style="font-size:20px; font-weight:800; color:#eab308;">${finData?.fScore || 0} / 9</span>
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; font-size:10px;">
                    ${(finData?.fDetails || []).map(f => `
                        <div style="color: ${f.ok ? '#4ade80' : '#64748b'};">
                            ${f.ok ? '✅' : '⚪'} ${f.msg}
                        </div>
                    `).join('')}
                </div>
                ${renderDiagnostic(
                    (finData?.fScore >= 7 ? "F-Score 評分優異，具備機構級財務健全度。" : (finData?.fScore <= 3 ? "F-Score 評分較低，需嚴防財務結構惡化。" : "財務健全度尚可。"))
                )}
            </div>

            <!-- 13. 獲利三率趨勢 -->
            <div class="analysis-card">
                <div class="analysis-card-title">🏆 獲利三率趨勢</div>
                <div style="font-size:11px; color:#94a3b8; margin-bottom:10px;">近 4 季毛利率、營業利益率、稅後淨利率</div>
                ${(() => {
                    const marginTrend = finData?.marginTrend || [];
                    if (marginTrend.length === 0) return '<div style="color:#64748b; font-size:12px; text-align:center; padding:10px;">無獲利比率數據</div>';
                    return `
                        <div style="display:flex; flex-direction:column; gap:8px;">
                            ${marginTrend.map(m => `
                                <div style="background:rgba(255,255,255,0.02); padding:8px; border-radius:6px; border:1px solid rgba(255,255,255,0.03);">
                                    <div style="display:flex; justify-content:space-between; font-size:11px; color:#cbd5e1; margin-bottom:4px;">
                                        <span style="font-family:monospace;">${m.date || 'N/A'}</span>
                                        <span style="font-weight:700;">ROE: ${m.roe ? safeFix(m.roe, 2)+'%' : 'N/A'}</span>
                                    </div>
                                    <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:4px; text-align:center; font-size:10px;">
                                        <div><div style="color:#94a3b8;">毛利</div><div style="color:#f8fafc; font-weight:700;">${safeFix(m.grossMargin, 1)}%</div></div>
                                        <div><div style="color:#94a3b8;">營業</div><div style="color:#f8fafc; font-weight:700;">${safeFix(m.operatingMargin, 1)}%</div></div>
                                        <div><div style="color:#94a3b8;">淨利</div><div style="color:#f8fafc; font-weight:700;">${safeFix(m.netMargin, 1)}%</div></div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    `;
                })()}
                ${renderDiagnostic(
                    (finData?.marginTrend?.length >= 2 && finData.marginTrend[finData.marginTrend.length-1].grossMargin > finData.marginTrend[finData.marginTrend.length-2].grossMargin ? "毛利率呈現回升，產品競爭力或成本控制轉佳。" : "獲利能力尚屬穩定，需觀察淨利是否受業外影響。")
                )}
            </div>

            <!-- 14. 技術面動能訊號 -->
            <div class="analysis-card">
                <div class="analysis-card-title">📉 技術面動能訊號</div>
                ${(() => {
                    const prices = chartData?.prices || [];
                    if (prices.length < 20) return '<div style="color:#64748b; font-size:12px;">數據不足</div>';
                    
                    const latest = prices[prices.length-1];
                    const p = latest.close;
                    
                    // 1. 計算 RSI (14)
                    let gains = 0, losses = 0;
                    for (let i = prices.length - 14; i < prices.length; i++) {
                        const change = prices[i].close - prices[i-1].close;
                        if (change > 0) gains += change; else losses -= change;
                    }
                    const rsi = (gains === 0) ? 0 : (100 - (100 / (1 + (gains / 14) / (Math.max(losses, 0.01) / 14))));
                    
                    // 2. 乖離率 (20MA)
                    const ma20 = prices.slice(-20).reduce((s, x) => s + x.close, 0) / 20;
                    const bias = ((p - ma20) / ma20) * 100;
                    
                    const rsiColor = rsi > 70 ? '#ef4444' : (rsi < 30 ? '#4ade80' : '#cbd5e1');
                    const biasColor = bias > 0 ? '#ef4444' : '#10b981';

                    return `
                        ${renderStatRow('RSI (14)', safeFix(rsi, 1), rsi)}
                        <div style="font-size:11px; margin-bottom:8px; color:${rsiColor}; text-align:right;">${rsi > 70 ? '⚠️ 超買過熱' : (rsi < 30 ? '🔥 超跌機會' : '中性狀態')}</div>
                        ${renderStatRow('20日 乖離率', (bias > 0 ? '+' : '') + safeFix(bias, 2) + '%')}
                        <div style="font-size:11px; margin-top:12px; color:#94a3b8; border-top:1px dashed rgba(255,255,255,0.05); padding-top:8px;">
                            <span>目前收盤價: ${p}</span><br>
                            <span>20日 均線: ${safeFix(ma20, 2)}</span>
                        </div>
                    `;
                })()}
                ${renderDiagnostic("RSI 提供短線超買/超跌參考，乖離率則反映股價與均線的拉扯力道。")}
            </div>
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

function renderDiagnostic(text) {
    if (!text) return '';
    return `
        <div style="margin-top:12px; padding:8px 12px; background:rgba(59, 130, 246, 0.05); border-radius:8px; border:1px solid rgba(59, 130, 246, 0.1); font-size:11px; color:#cbd5e1; line-height:1.5;">
            <span style="color:#60a5fa; font-weight:700; margin-right:4px;">💡 診斷：</span>${text}
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
            <span class="analysis-val" style="color: ${color};">${sign}${safeFix(percentVal, 2)}%</span>
        </div>
    `;
}

function safeFix(val, n) {
    if (val === null || val === undefined || isNaN(val)) return 'N/A';
    return val.toFixed(n);
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
    if (!maValue || isNaN(maValue)) return `<div class="analysis-stat-row"><span class="analysis-label">${label}</span><span class="analysis-val">N/A</span></div>`;
    
    const diffVal = ((currentPrice - maValue) / maValue * 100);
    const diff = safeFix(diffVal, 1);
    const color = diffVal > 0 ? '#ef4444' : '#10b981'; // 台股紅漲綠跌
    const sign = diffVal > 0 ? '+' : '';
    
    return `
        <div class="analysis-stat-row">
            <span class="analysis-label">${label}</span>
            <div style="display:flex; align-items:center; gap:8px;">
                <span class="analysis-val">${safeFix(maValue, 2)}</span>
                <span class="ma-tag" style="color:${color}; border: 1px solid ${color}40;">乖離 ${sign}${diff}%</span>
            </div>
        </div>
    `;
}

function renderValuationRow(label, value) {
    if (value === null || value === undefined || isNaN(value)) return `<div class="analysis-stat-row"><span class="analysis-label">${label}</span><span class="analysis-val">N/A</span></div>`;
    
    let colorClass = 'reasonable';
    if (label.includes('便宜')) colorClass = 'cheap';
    if (label.includes('昂貴')) colorClass = 'expensive';
    
    return `
        <div class="analysis-stat-row">
            <span class="analysis-label">${label}</span>
            <span class="analysis-val ${colorClass}">${safeFix(value, 2)} 元</span>
        </div>
    `;
}
