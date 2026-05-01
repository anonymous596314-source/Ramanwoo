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
        
        openAnalysisModal(symbol, name);
    }
});

// Caches for APIs to avoid repeated large fetches
let twseBasicCache = null;

async function openAnalysisModal(symbol, name) {
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

        renderAnalysis(symbol, name, chartData, twseBasic, chipsData, revData, finData, marginData, institutionalData);

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

        return {
            currentPrice,
            ma: { ma5, ma10, ma20, ma60, ma120, ma240 },
            high52w, low52w, posIn52w,
            rsi14,
            bb,
            avgVol5
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

function calcBollinger(closes, period = 20, multiplier = 2) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    const mid = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, v) => sum + Math.pow(v - mid, 2), 0) / period;
    const std = Math.sqrt(variance);
    return {
        upper: parseFloat((mid + multiplier * std).toFixed(2)),
        mid: parseFloat(mid.toFixed(2)),
        lower: parseFloat((mid - multiplier * std).toFixed(2))
    };
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

// --- 5. FinMind 財報三率 + 近四季 EPS 趨勢 ---
async function fetchFinMindFinancial(symbol) {
    const rawSymbol = symbol.trim().replace(/\.TW$/i, '').replace(/\.TWO$/i, '');
    const d = new Date();
    d.setDate(d.getDate() - 600); // 抓兩年確保有四季 EPS
    const startDate = d.toISOString().split('T')[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements&data_id=${rawSymbol}&start_date=${startDate}`;
    try {
        const res = await fetch(url);
        const json = await res.json();
        if (json && json.data && json.data.length > 0) {
            // 取得所有不重複日期，排序
            const allDates = [...new Set(json.data.map(x => x.date))].sort();
            const latestDate = allDates[allDates.length - 1];
            
            const getQData = (date) => json.data.filter(x => x.date === date);
            const getVal = (qData, type) => {
                const item = qData.find(x => x.type === type);
                return item ? item.value : 0;
            };

            const latestQData = getQData(latestDate);
            const rev = getVal(latestQData, 'Revenue');

            // 近四季 EPS
            const epsTrend = allDates.slice(-4).map(date => {
                const qd = getQData(date);
                const eps = getVal(qd, 'EPS');
                const d2 = new Date(date);
                const m = d2.getMonth() + 1;
                const q = m <= 3 ? 'Q1' : m <= 6 ? 'Q2' : m <= 9 ? 'Q3' : 'Q4';
                return { label: `${d2.getFullYear()} ${q}`, eps };
            });

            if (rev > 0) {
                const d3 = new Date(latestDate);
                const year = d3.getFullYear();
                const month = d3.getMonth() + 1;
                const quarter = month <= 3 ? 'Q1' : month <= 6 ? 'Q2' : month <= 9 ? 'Q3' : 'Q4';

                return {
                    quarter: `${year} ${quarter}`,
                    grossMargin: (getVal(latestQData, 'GrossProfit') / rev) * 100,
                    opMargin:    (getVal(latestQData, 'OperatingIncome') / rev) * 100,
                    netMargin:   (getVal(latestQData, 'IncomeAfterTaxes') / rev) * 100,
                    eps:         getVal(latestQData, 'EPS'),
                    epsTrend
                };
            }
        }
    } catch(e) { console.warn("FinMind Financial failed", e); }
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
                marginPurchase: latest.MarginPurchaseTodayBalance,
                shortSale: latest.ShortSaleTodayBalance
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
            // 彙總各法人買賣超 (單位: 股 → 換算為張 /1000)
            const totals = { foreign: 0, trust: 0, dealer: 0 };
            const dailyMap = {}; // 儲存每日各法人淨買超，供最新一日顯示

            json.data.forEach(row => {
                const netShares = row.buy - row.sell;
                const netLots = netShares / 1000; // 換算張數
                if (row.name === 'Foreign_Investor') totals.foreign += netLots;
                else if (row.name === 'Investment_Trust') totals.trust += netLots;
                else if (['Dealer_self', 'Dealer_Hedging', 'Foreign_Dealer_Self'].includes(row.name)) totals.dealer += netLots;

                // 記錄最後一個交易日各法人數字
                if (!dailyMap[row.date]) dailyMap[row.date] = { foreign: 0, trust: 0, dealer: 0 };
                if (row.name === 'Foreign_Investor') dailyMap[row.date].foreign += netLots;
                else if (row.name === 'Investment_Trust') dailyMap[row.date].trust += netLots;
                else if (['Dealer_self', 'Dealer_Hedging', 'Foreign_Dealer_Self'].includes(row.name)) dailyMap[row.date].dealer += netLots;
            });

            const dates = Object.keys(dailyMap).sort();
            const latestDate = dates[dates.length - 1];
            const latest = dailyMap[latestDate];

            return {
                periodStart: dates[0],
                periodEnd: latestDate,
                monthTotal: totals,   // 近一個月累計淨買超張數
                latestDay: latest     // 最新一個交易日單日淨買超
            };
        }
    } catch(e) { console.warn("FinMind Institutional failed", e); }
    return null;
}

// === Rendering Logic ===

function renderAnalysis(symbol, name, chartData, twseBasic, chipsData, revData, finData, marginData, institutionalData) {
    const { currentPrice, ma, high52w, low52w, posIn52w, rsi14, bb, avgVol5 } = chartData;
    
    // 市値計算
    const marketCap = chipsData.sharesIssued ? (currentPrice * chipsData.sharesIssued / 100000000) : null; // 億元
    
    // --- Valuations ---
    // If fundamental data is missing, we don't calculate fake valuations
    const eps = twseBasic?.pe && currentPrice ? currentPrice / twseBasic.pe : null;
    const currentDiv = twseBasic?.yield && currentPrice ? currentPrice * (twseBasic.yield / 100) : null;
    
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
    
    if (revData?.yoy && revData.yoy > 10) {
        summaryText += `最新營收大幅年增 ${revData.yoy.toFixed(1)}%，具備強勁成長動能。`;
    }

    if (finData?.grossMargin > 30) {
        summaryText += `毛利率高達 ${finData.grossMargin.toFixed(1)}%，產品競爭力強。`;
    }
    if (rsi14 !== null) {
        if (rsi14 > 70) summaryText += `RSI(14) 高達 ${rsi14}，技術面呈現超買，短線注意回調風險。`;
        else if (rsi14 < 30) summaryText += `RSI(14) 僅 ${rsi14}，技術面超賣，可能出現反彈機會。`;
        else summaryText += `RSI(14) 為 ${rsi14}，動能中性。`;
    }

    analysisBody.innerHTML = `
        <div class="analysis-grid">
            <!-- 籌碼面 -->
            <div class="analysis-card">
                <div class="analysis-card-title">👥 籌碼與信用交易</div>
                ${renderStatRow('外資持股', chipsData.foreign ? chipsData.foreign + '%' : 'N/A', chipsData.foreign)}
                ${renderStatRow('投信持股', chipsData.trust ? chipsData.trust + '%' : 'N/A', chipsData.trust)}
                ${renderStatRow('大戶持股 (400張)', chipsData.large ? chipsData.large + '%' : 'N/A', chipsData.large)}
                ${renderStatRow('散戶比例', chipsData.retail ? chipsData.retail + '%' : 'N/A', chipsData.retail)}
                ${renderStatRow('融資餘額', marginData?.marginPurchase ? marginData.marginPurchase.toLocaleString() + ' 張' : 'N/A')}
                ${renderStatRow('融券餘額', marginData?.shortSale ? marginData.shortSale.toLocaleString() + ' 張' : 'N/A')}
            </div>

            <!-- 三大法人近一個月 -->
            <div class="analysis-card">
                <div class="analysis-card-title">🏦 三大法人進出 (近一個月)</div>
                ${ institutionalData ? `<div style="font-size:11px; color:#64748b; margin-bottom:10px;">${institutionalData.periodStart} ～ ${institutionalData.periodEnd}</div>` : '' }
                <div style="font-size:12px; color:#94a3b8; margin-bottom:6px; border-bottom:1px dashed rgba(255,255,255,0.05); padding-bottom:6px;">📅 近一個月累計</div>
                ${renderNetBuyRow('外資累計', institutionalData?.monthTotal?.foreign)}
                ${renderNetBuyRow('投信累計', institutionalData?.monthTotal?.trust)}
                ${renderNetBuyRow('自營商累計', institutionalData?.monthTotal?.dealer)}
                <div style="font-size:12px; color:#94a3b8; margin:10px 0 6px; border-bottom:1px dashed rgba(255,255,255,0.05); padding-bottom:6px;">📌 最新交易日單日</div>
                ${renderNetBuyRow('外資單日', institutionalData?.latestDay?.foreign)}
                ${renderNetBuyRow('投信單日', institutionalData?.latestDay?.trust)}
                ${renderNetBuyRow('自營商單日', institutionalData?.latestDay?.dealer)}
            </div>

            <!-- 基本面 -->
            <div class="analysis-card">
                <div class="analysis-card-title">📈 股利與估值指標</div>
                ${renderStatRow('當前殖利率', twseBasic?.yield ? twseBasic.yield + '%' : 'N/A')}
                ${renderStatRow('本益比 (P/E)', twseBasic?.pe ? twseBasic.pe + ' 倍' : 'N/A')}
                ${renderStatRow('股價淨值比 (P/B)', twseBasic?.pb ? twseBasic.pb + ' 倍' : 'N/A')}
                ${renderStatRow('除息日期', chipsData.exDivDate || '無資料')}
                ${renderStatRow('除息金額', chipsData.exDivAmt ? parseFloat(chipsData.exDivAmt).toFixed(2) + ' 元' : '無資料')}
                ${chipsData.divGrowth3y !== null && chipsData.divGrowth3y !== undefined ? renderPercentRow('近三年股利成長', chipsData.divGrowth3y) : renderStatRow('近三年股利成長', 'N/A')}
                ${renderStatRow('目前股價 vs 共識', currentPrice && twseBasic?.pe && twseBasic?.yield
                    ? (currentPrice > (chipsData.exDivAmt ? parseFloat(chipsData.exDivAmt)/0.04 : currentPrice) ? '偏高 ⚠️' : '合理 ✅') : 'N/A')}
            </div>

            <!-- 市値與規模 -->
            <div class="analysis-card">
                <div class="analysis-card-title">🏢 市值與股本規模</div>
                ${renderStatRow('市值', marketCap ? formatCurrency(marketCap * 100000000) : 'N/A')}
                ${renderStatRow('流通股數', chipsData.sharesIssued ? (chipsData.sharesIssued / 1000).toLocaleString() + ' 張' : 'N/A')}
                ${renderStatRow('5日均量', avgVol5 ? (avgVol5 / 1000).toLocaleString() + ' 張' : 'N/A')}
                ${renderStatRow('52週最高', high52w ? high52w.toFixed(2) + ' 元' : 'N/A')}
                ${renderStatRow('52週最低', low52w ? low52w.toFixed(2) + ' 元' : 'N/A')}
                ${renderStatRow('52週位置', posIn52w !== null ? posIn52w + '%' : 'N/A')}
            </div>
            
            <!-- 營收表現 -->
            <div class="analysis-card">
                <div class="analysis-card-title">📊 月營收表現</div>
                <div style="font-size:12px; color:#94a3b8; margin-bottom:8px;">最新發布月份: ${revData?.month || 'N/A'}</div>
                ${renderStatRow('單月營收', revData?.revenue ? formatCurrency(revData.revenue) : 'N/A')}
                ${renderPercentRow('月增率 (MoM)', revData?.mom)}
                ${renderPercentRow('年增率 (YoY)', revData?.yoy)}
                ${renderStatRow('近 12 月累計', revData?.cum12m ? formatCurrency(revData.cum12m) : 'N/A')}
                ${renderStatRow(`YTD 營收 (${revData?.ytdMonthCount || 0}個月)`, revData?.ytd ? formatCurrency(revData.ytd) : 'N/A')}
                ${renderStatRow('年增次數 (近 12 月)', revData ? `${revData.yoyUpMonths} / ${revData.totalMonths} 個月` : 'N/A')}
            </div>

            <!-- 財報三率 + 近四季EPS趨勢 -->
            <div class="analysis-card">
                <div class="analysis-card-title">💵 財報獲利能力</div>
                <div style="font-size:12px; color:#94a3b8; margin-bottom:8px;">最新已入庫季度: ${finData?.quarter || 'N/A'} <span style="color:#64748b;">(資料更新約有 2-4 週延遲)</span></div>
                ${renderPercentRow('毛利率', finData?.grossMargin, false)}
                ${renderPercentRow('營業利益率', finData?.opMargin, false)}
                ${renderPercentRow('稅後淨利率', finData?.netMargin, false)}
                ${renderStatRow('單季 EPS', finData?.eps ? finData.eps + ' 元' : 'N/A')}
                ${ finData?.epsTrend?.length ? `
                <div style="font-size:12px; color:#94a3b8; margin:10px 0 6px; border-top:1px dashed rgba(255,255,255,0.05); padding-top:8px;">近四季 EPS 趨勢</div>
                ${ finData.epsTrend.map(q => renderStatRow(q.label, q.eps ? q.eps + ' 元' : 'N/A')).join('') }` : '' }
            </div>
            
            <!-- 技術面 (均線 + RSI + 布林通道) -->
            <div class="analysis-card">
                <div class="analysis-card-title">📉 技術面 (均線)</div>
                ${renderMARow('5日線 (週線)', ma.ma5, currentPrice)}
                ${renderMARow('10日線', ma.ma10, currentPrice)}
                ${renderMARow('20日線 (月線)', ma.ma20, currentPrice)}
                ${renderMARow('60日線 (季線)', ma.ma60, currentPrice)}
                ${renderMARow('120日線 (半年線)', ma.ma120, currentPrice)}
                ${renderMARow('240日線 (年線)', ma.ma240, currentPrice)}
            </div>

            <!-- RSI + 布林通道 -->
            <div class="analysis-card">
                <div class="analysis-card-title">📡 動能與波動指標</div>
                ${ rsi14 !== null ? `
                <div class="analysis-stat-row" style="flex-direction:column; align-items:flex-start; gap:6px;">
                    <div style="display:flex; justify-content:space-between; width:100%;">
                        <span class="analysis-label">RSI(14)</span>
                        <span class="analysis-val" style="color:${rsi14>70?'#ef4444':rsi14<30?'#10b981':'#fbbf24'}">${rsi14} ${ rsi14>70 ? '⚠ 超買':rsi14<30?'⚡ 超賣':'▪ 中性'}</span>
                    </div>
                    <div class="progress-bar-bg" style="width:100%">
                        <div class="progress-bar-fill" style="width:${rsi14}%; background:${rsi14>70?'#ef4444':rsi14<30?'#10b981':'#3b82f6'};"></div>
                    </div>
                </div>` : renderStatRow('RSI(14)', 'N/A') }
                ${renderStatRow('布林上軌 (2σ)', bb?.upper ? bb.upper + ' 元' : 'N/A')}
                ${renderStatRow('布林中軌 (MA20)', bb?.mid ? bb.mid + ' 元' : 'N/A')}
                ${renderStatRow('布林下軌 (2σ)', bb?.lower ? bb.lower + ' 元' : 'N/A')}
                ${bb ? renderStatRow('布林寬度', ((bb.upper - bb.lower) / bb.mid * 100).toFixed(1) + '% (波動寬窄)') : ''}
                ${bb && currentPrice ? renderStatRow('目前位置', (() => {
                    const pos = ((currentPrice - bb.lower) / (bb.upper - bb.lower) * 100).toFixed(0);
                    const label = pos > 80 ? '靠近上軌 ⚠️' : pos < 20 ? '靠近下軌 🟢' : '帶內中段';
                    return `${pos}% ${label}`;
                })()) : ''}
            </div>

            <!-- 估值 -->
            <div class="analysis-card">
                <div class="analysis-card-title">💰 合理價格評估</div>
                <div style="font-size:12px; color:#94a3b8; margin-bottom:8px;">基於歷年股利推算 (5% / 4% / 3%)</div>
                ${renderValuationRow('便宜價 (5%殖利率)', divCheap)}
                ${renderValuationRow('合理價 (4%殖利率)', divReasonable)}
                ${renderValuationRow('昂貴價 (3%殖利率)', divExpensive)}
                
                <div style="font-size:12px; color:#94a3b8; margin:12px 0 8px;">基於本益比推算 (12倍 / 15倍 / 20倍)</div>
                ${renderValuationRow('便宜價 (12倍PE)', peCheap)}
                ${renderValuationRow('合理價 (15倍PE)', peReasonable)}
                ${renderValuationRow('昂貴價 (20倍PE)', peExpensive)}
            </div>
        </div>

        <div class="analysis-card">
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
