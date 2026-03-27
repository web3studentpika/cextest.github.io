const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { ethers } = require('ethers');
const http = require('http');

const app = express();
const server = http.createServer(app);
const PORT = 8080;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// ── 链配置 ──
const CONTRACT = '0x10063340374db851e2628D06F4732d5FF814eB34';
const AXON_RPC = 'https://mainnet-rpc.axonchain.ai/';
const BSC_RPC  = 'https://bsc-dataseed1.binance.org/';
const ARB_RPC  = 'https://arb1.arbitrum.io/rpc';

const CHAIN_NAMES = { 56: 'BSC', 42161: 'Arbitrum' };
const STATUS_MAP = ['Active','Completed','CancelPending','Cancelled','Dispute'];
const STATUS_LABELS = { Active:'活跃', Completed:'已完成', CancelPending:'取消待确认', Cancelled:'已取消', Dispute:'争议中' };

const TOKEN_ADDRS = {
  56:    { USDT:'0x55d398326f99059fF775485246999027B3197955', USDC:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
  42161: { USDT:'0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', USDC:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831' }
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 value) returns (bool)'
];

const axonProvider = new ethers.JsonRpcProvider(AXON_RPC);
const bscProvider  = new ethers.JsonRpcProvider(BSC_RPC);
const arbProvider  = new ethers.JsonRpcProvider(ARB_RPC);

function providerFor(chainId) {
  if (chainId === 56) return bscProvider;
  if (chainId === 42161) return arbProvider;
  return axonProvider;
}

// ── 合约读取 ──
const ordersFnSig = new ethers.Interface(['function orders(uint256)','function nextOrderId() view returns (uint256)']);

async function getNextOrderId() {
  const data = ordersFnSig.encodeFunctionData('nextOrderId');
  const raw = await axonProvider.call({ to: CONTRACT, data });
  return Number(BigInt(raw));
}

function parseOrderRaw(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const slot = i => h.slice(i * 64, (i + 1) * 64);
  const addr = i => '0x' + slot(i).slice(24);
  const uint = i => BigInt('0x' + slot(i));

  const seller = addr(0);
  const buyer = addr(1);
  const amountAxonWei = uint(2);
  const amountAxon = Number(ethers.formatEther(amountAxonWei));
  const priceE6 = Number(uint(3));
  const priceUsd = priceE6 / 1_000_000;
  const paymentChainId = Number(uint(4));

  const tokenOffsetBytes = Number(uint(5));
  const tokenOffsetSlot = Number.isFinite(tokenOffsetBytes) ? Math.floor(tokenOffsetBytes / 32) : 0;
  let paymentToken = 'USDT';
  if (tokenOffsetSlot >= 0 && slot(tokenOffsetSlot)) {
    const strLen = Number(uint(tokenOffsetSlot));
    const strData = slot(tokenOffsetSlot + 1) || '';
    if (strLen > 0 && strData) {
      paymentToken = Buffer.from(strData, 'hex').toString('utf8').replace(/\0/g, '').trim() || 'USDT';
    }
  }

  const sellerPaymentAddr = addr(6);
  const statusNumRaw = Number(uint(7));
  const createdAt = Number(uint(8));
  const cancelRequestedAt = Number(uint(9));

  let status = 'Unknown';
  if (statusNumRaw === 0) status = 'Active';
  else if (statusNumRaw === 1) status = 'Completed';
  else if (statusNumRaw === 2) status = 'Cancelled';
  else if (statusNumRaw === 3) status = 'Dispute';
  else if (statusNumRaw === 4) status = 'CancelPending';

  const totalPayment = amountAxon * priceUsd;

  return {
    seller,
    buyer,
    amountAxon,
    priceUsd,
    priceE6,
    amount_axon: amountAxon,
    price_usd: priceUsd,
    total_payment: parseFloat(totalPayment.toFixed(2)),
    totalPayment: parseFloat(totalPayment.toFixed(2)),
    paymentChainId,
    payment_chain_id: paymentChainId,
    paymentChainName: CHAIN_NAMES[paymentChainId] || `Chain ${paymentChainId}`,
    payment_chain_name: CHAIN_NAMES[paymentChainId] || `Chain ${paymentChainId}`,
    paymentToken,
    payment_token: paymentToken,
    sellerPaymentAddr,
    seller_payment_addr: sellerPaymentAddr,
    paymentTxHash: null,
    payment_tx_hash: null,
    status,
    statusNum: statusNumRaw,
    statusLabel: STATUS_LABELS[status] || status,
    status_label: STATUS_LABELS[status] || status,
    createdAt,
    cancelRequestedAt,
    createdAtISO: createdAt ? new Date(createdAt * 1000).toISOString() : null,
    locked_at: null,
    payment_sent_at: null,
    lockedAtISO: null,
  };
}

async function fetchOrder(id) {
  const data = ordersFnSig.encodeFunctionData('orders', [id]);
  const raw = await axonProvider.call({ to: CONTRACT, data });
  const order = parseOrderRaw(raw);
  order.id = id;
  return order;
}

async function fetchAllOrders() {
  const count = await getNextOrderId();
  const promises = [];
  for (let i = 0; i < count; i++) {
    promises.push(fetchOrder(i).catch(e => ({ id: i, error: e.message })));
  }
  return (await Promise.all(promises)).filter(o => !o.error);
}

// ── 余额查询（真实链上） ──
async function fetchBalances(address) {
  const results = {};

  try {
    const bal = await axonProvider.getBalance(address);
    results.axon = ethers.formatEther(bal);
  } catch { results.axon = '0.0000'; }

  for (const [chainId, tokens] of Object.entries(TOKEN_ADDRS)) {
    const prov = providerFor(Number(chainId));
    for (const [symbol, tokenAddr] of Object.entries(tokens)) {
      const key = `${chainId === '56' ? 'bsc' : 'arb'}-${symbol.toLowerCase()}`;
      try {
        const contract = new ethers.Contract(tokenAddr, ERC20_ABI, prov);
        const [bal, dec] = await Promise.all([contract.balanceOf(address), contract.decimals()]);
        results[key] = ethers.formatUnits(bal, dec);
      } catch { results[key] = '0.00'; }
    }
  }

  return results;
}

function providerForPaymentChain(chainId) {
  if (Number(chainId) === 56) return bscProvider;
  if (Number(chainId) === 42161) return arbProvider;
  throw new Error(`不支持的付款链: ${chainId}`);
}

function tokenAddressFor(chainId, token) {
  const addr = TOKEN_ADDRS[Number(chainId)]?.[String(token).toUpperCase()];
  if (!addr) throw new Error(`未找到代币地址: chain=${chainId} token=${token}`);
  return addr;
}

async function waitForOrderCompleted(orderId, timeoutMs = 90000, intervalMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const order = await fetchOrder(orderId);
    if (order.status === 'Completed') return { success: true, order };
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { success: false, error: '订单在预期时间内未完成' };
}

async function executeBuyFull(orderId, buyerAddress) {
  const walletData = wallets.get((buyerAddress || '').toLowerCase());
  if (!walletData) throw new Error('请先导入钱包');

  const order = await fetchOrder(orderId);
  if (order.status !== 'Active') throw new Error(`当前订单不可购买，状态为 ${order.status}`);

  const info = await getPaymentInfo(orderId);
  if (!info.success) throw new Error(info.error || '获取付款信息失败');

  const chainId = Number(info.chainId || order.payment_chain_id);
  const token = String(info.token || order.payment_token).toUpperCase();
  const tokenAddr = tokenAddressFor(chainId, token);
  const provider = providerForPaymentChain(chainId);
  const wallet = new ethers.Wallet(walletData.privateKey, provider);
  const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
  const decimals = await tokenContract.decimals();
  const amountStr = String(info.amount || order.total_payment);
  const amount = ethers.parseUnits(amountStr, decimals);
  const balance = await tokenContract.balanceOf(wallet.address);
  if (balance < amount) {
    return {
      success: false,
      stage: 'balance-check',
      error: `余额不足：需要 ${amountStr} ${token}`,
      requiredAmount: amountStr,
      token,
      chainId,
      paymentAddress: info.paymentAddress
    };
  }

  const tx = await tokenContract.transfer(info.paymentAddress, amount);
  await tx.wait();

  const completed = await waitForOrderCompleted(orderId);
  return {
    success: completed.success,
    stage: completed.success ? 'completed' : 'payment-sent',
    paymentAddress: info.paymentAddress,
    amount: amountStr,
    token,
    chainId,
    paymentTx: tx.hash,
    payment_tx: tx.hash,
    order: completed.order || null,
    error: completed.success ? null : completed.error
  };
}

// ── 钱包存储 ──
const wallets = new Map();
const KEEPER_URL = process.env.KEEPER_URL || 'https://axonotc.com';
const KEEPER_API_KEY = process.env.KEEPER_API_KEY || process.env.LOCK_API_KEY || '';
const BOT_STATE = {
  enabled: false,
  running: false,
  intervalMs: 10000,
  lastRunAt: null,
  lastMatchedOrderId: null,
  lastAction: null,
  lastError: null,
  strategy: {
    maxPriceUsd: '',
    minAmountAxon: '',
    paymentChainId: '',
    paymentToken: '',
    onlyPurchasable: true,
    autoExecute: false,
    buyerAddress: ''
  },
  history: []
};

function addBotHistory(entry) {
  BOT_STATE.history.unshift({ at: new Date().toISOString(), ...entry });
  BOT_STATE.history = BOT_STATE.history.slice(0, 50);
}

async function keeperGetJson(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.KEEPER_HTTP_TIMEOUT || 15) * 1000);
  try {
    const resp = await fetch(`${KEEPER_URL}${path}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...(KEEPER_API_KEY ? { Authorization: `Bearer ${KEEPER_API_KEY}` } : {})
      },
      signal: controller.signal
    });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { ok: resp.ok, status: resp.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

async function getKeeperHealth() {
  try {
    const res = await keeperGetJson('/health');
    if (res.ok) return { success: true, ...res.data };
    return { success: false, error: res.data?.error || `HTTP ${res.status}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getPaymentInfo(orderId) {
  let lastError = 'Keeper payment-info endpoint not found';
  for (const path of [`/order/${orderId}/buy`, `/order/${orderId}`]) {
    try {
      const res = await keeperGetJson(path);
      const data = res.data || {};
      if (res.ok && data) {
        const payment = data.payment || {};
        return {
          success: true,
          sourcePath: path,
          paymentAddress: payment.address || data.payment_address || data.paymentAddress || '',
          amount: payment.amount || data.amount || data.total_payment || data.totalPayment || '',
          token: payment.token || data.payment_token || data.paymentToken || data.token || '',
          chainId: payment.chain_id || payment.chainId || data.payment_chain_id || data.paymentChainId || data.chainId || '',
          chainName: payment.chain_name || payment.chainName || data.payment_chain_name || data.paymentChainName || '',
          raw: data
        };
      }
      lastError = data?.error || data?.message || `HTTP ${res.status}`;
    } catch (e) {
      lastError = e.message;
    }
  }
  return { success: false, error: lastError };
}

function orderMatchesStrategy(order, strategy) {
  if (!order) return false;
  if (strategy.onlyPurchasable && order.status !== 'Active') return false;
  if (strategy.maxPriceUsd !== '' && Number(order.price_usd) > Number(strategy.maxPriceUsd)) return false;
  if (strategy.minAmountAxon !== '' && Number(order.amount_axon) < Number(strategy.minAmountAxon)) return false;
  if (strategy.paymentChainId !== '' && String(order.payment_chain_id) !== String(strategy.paymentChainId)) return false;
  if (strategy.paymentToken !== '' && String(order.payment_token).toUpperCase() !== String(strategy.paymentToken).toUpperCase()) return false;
  return true;
}

let botTimer = null;

async function runBotCycle() {
  BOT_STATE.running = true;
  BOT_STATE.lastRunAt = new Date().toISOString();
  try {
    const orders = await fetchAllOrders();
    const matched = orders
      .filter(o => orderMatchesStrategy(o, BOT_STATE.strategy))
      .sort((a, b) => Number(a.price_usd) - Number(b.price_usd))[0];

    if (!matched) {
      BOT_STATE.lastAction = 'no-match';
      return;
    }

    BOT_STATE.lastMatchedOrderId = matched.id;

    const paymentInfo = await getPaymentInfo(matched.id, BOT_STATE.strategy.buyerAddress || '');
    if (!paymentInfo.success) {
      BOT_STATE.lastError = paymentInfo.error || '获取付款信息失败';
      BOT_STATE.lastAction = 'payment-info-failed';
      addBotHistory({ type: 'error', orderId: matched.id, message: BOT_STATE.lastError });
      return;
    }

    BOT_STATE.lastError = null;
    if (BOT_STATE.strategy.autoExecute) {
      const execResult = await executeBuyFull(matched.id, BOT_STATE.strategy.buyerAddress || '');
      BOT_STATE.lastAction = execResult.success ? 'buy_full-completed' : (execResult.stage || 'buy_full-failed');
      BOT_STATE.lastError = execResult.success ? null : (execResult.error || null);
      addBotHistory({
        type: execResult.success ? 'buy_full-completed' : 'buy_full-failed',
        orderId: matched.id,
        paymentAddress: execResult.paymentAddress || paymentInfo.paymentAddress,
        amount: execResult.amount || paymentInfo.amount || matched.total_payment,
        token: execResult.token || paymentInfo.token || matched.payment_token,
        message: execResult.success ? `机器人已自动购买订单 #${matched.id}` : `自动购买失败：${execResult.error || '未知错误'}`
      });
      return;
    }

    BOT_STATE.lastAction = 'get_payment_info-matched';
    addBotHistory({
      type: 'get_payment_info-matched',
      orderId: matched.id,
      paymentAddress: paymentInfo.paymentAddress,
      amount: paymentInfo.amount || matched.total_payment,
      token: paymentInfo.token || matched.payment_token,
      message: '已命中策略并获取付款信息'
    });
  } catch (e) {
    BOT_STATE.lastError = e.message;
    BOT_STATE.lastAction = 'cycle-error';
    addBotHistory({ type: 'error', message: e.message });
  } finally {
    BOT_STATE.running = false;
  }
}

function restartBotTimer() {
  if (botTimer) clearInterval(botTimer);
  botTimer = null;
  if (!BOT_STATE.enabled) return;
  botTimer = setInterval(() => {
    runBotCycle().catch(() => {});
  }, Math.max(3000, Number(BOT_STATE.intervalMs) || 10000));
}

// ── API 路由 ──
app.get('/api/info', (req, res) => {
  res.json({
    success: true,
    version: 'V7',
    model: 'no-lock',
    contractAddress: CONTRACT,
    chainId: 8210,
    chains: CHAIN_NAMES,
    feeRate: 0.003,
    cancelCooldown: 900,
    buyerFlow: 'buy_full',
    keeperUrl: process.env.KEEPER_URL || 'https://axonotc.com'
  });
});

app.get('/api/keeper/health', async (req, res) => {
  const health = await getKeeperHealth();
  res.json(health);
});

app.get('/api/keeper/orders', async (req, res) => {
  try {
    const result = await keeperGetJson('/orders');
    if (!result.ok) {
      return res.json({ success: false, error: result.data?.error || `HTTP ${result.status}` });
    }
    res.json({ success: true, orders: result.data?.orders || result.data || [] });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    let orders = await fetchAllOrders();

    const { status, purchasable, address, role, chainId, token } = req.query;

    if (status) {
      orders = orders.filter(o => String(o.status).toLowerCase() === String(status).toLowerCase());
    }

    if (purchasable === '1' || purchasable === 'true') {
      orders = orders.filter(o => o.status === 'Active' && (!o.buyer || /^0x0{40}$/i.test(o.buyer)));
    }

    if (chainId) {
      orders = orders.filter(o => String(o.payment_chain_id) === String(chainId));
    }

    if (token) {
      orders = orders.filter(o => String(o.payment_token).toUpperCase() === String(token).toUpperCase());
    }

    if (address) {
      const a = String(address).toLowerCase();
      if (role === 'seller') {
        orders = orders.filter(o => String(o.seller).toLowerCase() === a);
      } else if (role === 'buyer') {
        orders = orders.filter(o => String(o.buyer || '').toLowerCase() === a);
      } else {
        orders = orders.filter(o => String(o.seller).toLowerCase() === a || String(o.buyer || '').toLowerCase() === a);
      }
    }

    orders.sort((a, b) => {
      if (a.status === 'Active' && b.status !== 'Active') return -1;
      if (a.status !== 'Active' && b.status === 'Active') return 1;
      return a.price_usd - b.price_usd;
    });

    res.json({ success: true, orders, total: orders.length });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/orders/summary', async (req, res) => {
  try {
    const orders = await fetchAllOrders();
    const completed = orders.filter(o => o.status === 'Completed');
    const now = Date.now();
    const volume24h = completed
      .filter(o => o.createdAtISO && (now - new Date(o.createdAtISO).getTime()) <= 24 * 60 * 60 * 1000)
      .reduce((sum, o) => sum + Number(o.total_payment || 0), 0);
    const recentTrades = completed
      .slice()
      .sort((a, b) => new Date(b.createdAtISO || 0).getTime() - new Date(a.createdAtISO || 0).getTime());
    res.json({ success: true, volume24h, recentTrades, totalCompleted: completed.length });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/orders/refresh', async (req, res) => {
  try {
    const orders = await fetchAllOrders();
    res.json({ success: true, orders, total: orders.length, refreshedAt: new Date().toISOString() });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/orders/:id/payment-info', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const info = await getPaymentInfo(orderId);
    if (!info.success) {
      return res.json({ success: false, method: 'get_payment_info', error: info.error || '获取付款信息失败' });
    }
    res.json({
      success: true,
      method: 'get_payment_info',
      orderId,
      paymentAddress: info.paymentAddress,
      payment_address: info.paymentAddress,
      amount: info.amount,
      token: info.token,
      payment_token: info.token,
      chainId: info.chainId,
      payment_chain_id: info.chainId,
      chainName: info.chainName,
      payment_chain_name: info.chainName,
      sourcePath: info.sourcePath,
      raw: info.raw
    });
  } catch (error) {
    res.json({ success: false, method: 'get_payment_info', error: error.message });
  }
});

app.post('/api/orders/:id/buy-full', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { buyerAddress } = req.body || {};
    const result = await executeBuyFull(orderId, buyerAddress);
    res.json(result);
  } catch (error) {
    res.json({ success: false, stage: 'buy-full', error: error.message });
  }
});

app.get('/api/bot', (req, res) => {
  res.json({ success: true, bot: BOT_STATE });
});

app.post('/api/bot/config', (req, res) => {
  const body = req.body || {};
  BOT_STATE.intervalMs = Math.max(3000, Number(body.intervalMs) || BOT_STATE.intervalMs || 10000);
  BOT_STATE.strategy = {
    ...BOT_STATE.strategy,
    ...body.strategy,
    onlyPurchasable: body?.strategy?.onlyPurchasable !== false,
    autoExecute: body?.strategy?.autoExecute === true
  };
  BOT_STATE.lastAction = 'config-updated';
  addBotHistory({ type: 'config', message: '机器人配置已更新' });
  restartBotTimer();
  res.json({ success: true, bot: BOT_STATE });
});

app.post('/api/bot/start', async (req, res) => {
  BOT_STATE.enabled = true;
  BOT_STATE.lastAction = 'started';
  restartBotTimer();
  await runBotCycle();
  res.json({ success: true, bot: BOT_STATE });
});

app.post('/api/bot/stop', (req, res) => {
  BOT_STATE.enabled = false;
  BOT_STATE.running = false;
  BOT_STATE.lastAction = 'stopped';
  restartBotTimer();
  res.json({ success: true, bot: BOT_STATE });
});

app.post('/api/bot/run-once', async (req, res) => {
  await runBotCycle();
  res.json({ success: true, bot: BOT_STATE });
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await fetchOrder(parseInt(req.params.id));
    res.json({ success: true, order });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/wallet/import', async (req, res) => {
  try {
    const { privateKey } = req.body;
    const wallet = new ethers.Wallet(privateKey);
    const address = wallet.address;

    // 真实链上余额
    const balances = await fetchBalances(address);

    wallets.set(address.toLowerCase(), {
      address,
      privateKey: wallet.privateKey,
      createdAt: new Date().toISOString()
    });

    res.json({ success: true, address, balances });
  } catch (error) {
    res.json({ success: false, error: '私钥格式无效: ' + error.message });
  }
});

app.get('/api/wallet/:address/balances', async (req, res) => {
  try {
    const address = req.params.address;
    const balances = await fetchBalances(address);
    res.json({ success: true, balances });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ── 合约写操作（需要私钥签名） ──
// 创建卖单
app.post('/api/orders/create', async (req, res) => {
  try {
    const { amountAxon, priceUsd, paymentChainId, paymentToken, sellerAddress, sellerPaymentAddr } = req.body;
    const walletData = wallets.get((sellerAddress || '').toLowerCase());
    if (!walletData) return res.json({ success: false, error: '请先导入钱包' });

    const wallet = new ethers.Wallet(walletData.privateKey, axonProvider);
    const amountWei = ethers.parseEther(String(amountAxon));
    const priceE6 = Math.round(parseFloat(priceUsd) * 1000000);
    const receiveAddr = (sellerPaymentAddr || sellerAddress || wallet.address || '').trim();

    const iface = new ethers.Interface([
      'function createOrder(uint256 priceUsdE6, uint256 paymentChainId, string paymentToken, address sellerPaymentAddr)'
    ]);
    const data = iface.encodeFunctionData('createOrder', [priceE6, paymentChainId, paymentToken, receiveAddr]);

    const tx = await wallet.sendTransaction({
      to: CONTRACT,
      data,
      value: amountWei
    });

    await tx.wait();
    res.json({ success: true, txHash: tx.hash, message: `卖单创建成功，交易哈希: ${tx.hash}` });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 锁定订单（通过 Keeper API）
app.post('/api/orders/:id/lock', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { buyerAddress } = req.body;
    if (!buyerAddress) return res.json({ success: false, error: '请先连接钱包' });

    // 根据文档，锁单需要通过 Keeper API
    // Keeper 默认地址: http://127.0.0.1:8545
    // 这里先尝试调用 Keeper
    const keeperUrl = process.env.KEEPER_URL || 'http://127.0.0.1:8545';
    const lockApiKey = process.env.LOCK_API_KEY || '';

    try {
      const response = await fetch(`${keeperUrl}/lock`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${lockApiKey}`
        },
        body: JSON.stringify({ orderId, buyerAddress })
      });
      const result = await response.json();
      res.json({ success: true, message: `订单 #${orderId} 已锁定`, lockResult: result });
    } catch (keeperError) {
      // Keeper 不可用时，提示用户
      res.json({
        success: false,
        error: `Keeper 服务不可用 (${keeperUrl})。锁单需要 Keeper 垫付 Axon gas。请确保 Keeper 服务正在运行，或设置 KEEPER_URL 环境变量。`
      });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 提交付款凭证
app.post('/api/orders/:id/pay', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { buyerAddress, txHash } = req.body;
    if (!txHash) return res.json({ success: false, error: '请提供交易哈希' });

    const walletData = wallets.get(buyerAddress.toLowerCase());
    if (!walletData) return res.json({ success: false, error: '请先导入钱包' });

    const wallet = new ethers.Wallet(walletData.privateKey, axonProvider);
    const iface = new ethers.Interface([
      'function submitPaymentProof(uint256 orderId, bytes32 txHash)'
    ]);
    const txHashBytes = ethers.zeroPadValue(txHash, 32);
    const data = iface.encodeFunctionData('submitPaymentProof', [orderId, txHashBytes]);

    const tx = await wallet.sendTransaction({ to: CONTRACT, data });
    await tx.wait();

    res.json({ success: true, message: '付款凭证已提交，等待 Keeper 确认放款', txHash: tx.hash });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 买方自助索赔
app.post('/api/orders/:id/claim', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { buyerAddress } = req.body;
    const walletData = wallets.get(buyerAddress.toLowerCase());
    if (!walletData) return res.json({ success: false, error: '请先导入钱包' });

    const wallet = new ethers.Wallet(walletData.privateKey, axonProvider);
    const iface = new ethers.Interface(['function buyerSelfClaim(uint256 orderId)']);
    const data = iface.encodeFunctionData('buyerSelfClaim', [orderId]);

    const tx = await wallet.sendTransaction({ to: CONTRACT, data });
    await tx.wait();

    res.json({ success: true, message: '自助索赔成功', txHash: tx.hash });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 申请取消
app.post('/api/orders/:id/request-cancel', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { sellerAddress } = req.body;
    const walletData = wallets.get((sellerAddress || '').toLowerCase());
    if (!walletData) return res.json({ success: false, error: '请先导入钱包' });

    const wallet = new ethers.Wallet(walletData.privateKey, axonProvider);
    const iface = new ethers.Interface(['function requestCancelOrder(uint256 orderId)']);
    const data = iface.encodeFunctionData('requestCancelOrder', [orderId]);

    const tx = await wallet.sendTransaction({ to: CONTRACT, data });
    await tx.wait();

    res.json({ success: true, message: '取消请求已提交，15分钟冷却期后生效', txHash: tx.hash });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 确认取消
app.post('/api/orders/:id/finalize-cancel', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { sellerAddress } = req.body;
    const walletData = wallets.get((sellerAddress || '').toLowerCase());
    if (!walletData) return res.json({ success: false, error: '请先导入钱包' });

    const wallet = new ethers.Wallet(walletData.privateKey, axonProvider);
    const iface = new ethers.Interface(['function finalizeCancelOrder(uint256 orderId)']);
    const data = iface.encodeFunctionData('finalizeCancelOrder', [orderId]);

    const tx = await wallet.sendTransaction({ to: CONTRACT, data });
    await tx.wait();

    res.json({ success: true, message: '订单已取消，AXON 已退回', txHash: tx.hash });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 中止取消
app.post('/api/orders/:id/abort-cancel', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { sellerAddress } = req.body;
    const walletData = wallets.get((sellerAddress || '').toLowerCase());
    if (!walletData) return res.json({ success: false, error: '请先导入钱包' });

    const wallet = new ethers.Wallet(walletData.privateKey, axonProvider);
    const iface = new ethers.Interface(['function abortCancel(uint256 orderId)']);
    const data = iface.encodeFunctionData('abortCancel', [orderId]);

    const tx = await wallet.sendTransaction({ to: CONTRACT, data });
    await tx.wait();

    res.json({ success: true, message: '已恢复订单为活跃状态', txHash: tx.hash });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 发起争议
app.post('/api/orders/:id/dispute', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { address } = req.body;
    const walletData = wallets.get((address || '').toLowerCase());
    if (!walletData) return res.json({ success: false, error: '请先导入钱包' });

    const wallet = new ethers.Wallet(walletData.privateKey, axonProvider);
    const iface = new ethers.Interface(['function raiseDispute(uint256 orderId)']);
    const data = iface.encodeFunctionData('raiseDispute', [orderId]);

    const tx = await wallet.sendTransaction({ to: CONTRACT, data });
    await tx.wait();

    res.json({ success: true, message: '争议已发起，等待管理员仲裁', txHash: tx.hash });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`AXON OTC 交易平台已启动: http://localhost:${PORT}`);
  console.log(`合约: ${CONTRACT} | Axon RPC: ${AXON_RPC}`);
  console.log(`数据来源: 真实链上数据`);
});
