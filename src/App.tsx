import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarChart2,
  Bot,
  ChevronDown,
  Code2,
  KeyRound,
  Menu,
  Pause,
  Play,
  Radio,
  TrendingUp,
  X,
} from 'lucide-react';
import { LiveCredentialsView } from './components/LiveCredentialsView';
import { MarketsView, SignalsView } from './components/MarketsAndSignalsView';
import { RiskCircuitBreakerView } from './components/RiskCircuitBreakerView';
import { RustCodebaseView } from './components/RustCodebaseView';
import { StrategyConfigView } from './components/StrategyConfigView';
import { TradingDeskView } from './components/TradingDeskView';
import { DEFAULT_BOT_CONFIG, SimulationRuntime } from './engine/simulator';
import type {
  BinanceAuthMethod,
  BotConfig,
  Candle,
  EngineSnapshot,
  ExecutionAccountMode,
  LiveCredentialStatus,
  ManualOrderInput,
  Timeframe,
  TransportMode,
} from './engine/types';

type ActiveSection = 'trade' | 'markets' | 'bot' | 'signal' | 'rust';
type BotSubTab = 'strategy' | 'risk' | 'credentials';

const NAV_ITEMS: Array<{
  id: ActiveSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'trade', label: 'Trade', icon: TrendingUp },
  { id: 'markets', label: 'Markets', icon: BarChart2 },
  { id: 'bot', label: 'Bot', icon: Bot },
  { id: 'signal', label: 'Signal', icon: Radio },
  { id: 'rust', label: 'Rust', icon: Code2 },
];

const INITIAL_LIVE_STATUS: LiveCredentialStatus = {
  configured: false,
  environment: 'Testnet',
  authMethod: 'HMAC-SHA256',
  apiKeyMasked: null,
  recvWindowMs: 5000,
  maxOrderNotionalUsdt: 250,
  requirePreflightTestOrder: true,
  armedForLiveOrders: false,
  verificationStatus: 'unverified',
  verificationMessage: null,
  lastVerifiedAt: null,
  canTrade: false,
  permissions: [],
  latencyMs: null,
  syncedBalances: [],
};

export default function App() {
  // Strictly isolated runtime instances: Paper Sandbox vs Live Execution
  const paperRuntimeRef = useRef<SimulationRuntime | null>(null);
  const liveRuntimeRef = useRef<SimulationRuntime | null>(null);
  if (!paperRuntimeRef.current) {
    paperRuntimeRef.current = new SimulationRuntime(DEFAULT_BOT_CONFIG, Date.now(), {
      accountMode: 'Paper',
      seedDemoData: true,
      environment: 'Testnet',
    });
  }
  if (!liveRuntimeRef.current) {
    liveRuntimeRef.current = new SimulationRuntime(DEFAULT_BOT_CONFIG, Date.now(), {
      accountMode: 'Live',
      seedDemoData: false,
      initialEquityOverride: 0,
      environment: 'Testnet',
    });
  }

  const [accountMode, setAccountMode] = useState<ExecutionAccountMode>('Paper');
  const [config, setConfig] = useState<BotConfig>(() => structuredClone(DEFAULT_BOT_CONFIG));
  const [paperSnapshot, setPaperSnapshot] = useState<EngineSnapshot>(() =>
    structuredClone(paperRuntimeRef.current!.snapshot)
  );
  const [liveSnapshot, setLiveSnapshot] = useState<EngineSnapshot>(() =>
    structuredClone(liveRuntimeRef.current!.snapshot)
  );
  const [liveStatus, setLiveStatus] = useState<LiveCredentialStatus>(INITIAL_LIVE_STATUS);

  const [section, setSection] = useState<ActiveSection>('trade');
  const [botSubTab, setBotSubTab] = useState<BotSubTab>('strategy');
  const [selectedSymbol, setSelectedSymbol] = useState<string>('BTCUSDT');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const activeRuntimeRef = accountMode === 'Live' ? liveRuntimeRef : paperRuntimeRef;
  const snapshot = accountMode === 'Live' ? liveSnapshot : paperSnapshot;
  const liveStatusRef = useRef<LiveCredentialStatus>(liveStatus);
  liveStatusRef.current = liveStatus;
  const inflightLiveIntentsRef = useRef(false);

  const syncSnapshots = useCallback(() => {
    if (paperRuntimeRef.current) {
      setPaperSnapshot(structuredClone(paperRuntimeRef.current.snapshot));
    }
    if (liveRuntimeRef.current) {
      setLiveSnapshot(structuredClone(liveRuntimeRef.current.snapshot));
    }
  }, []);

  const drainLiveIntents = useCallback(async () => {
    const rt = liveRuntimeRef.current;
    if (!rt || inflightLiveIntentsRef.current) return;
    const intents = rt.consumeLiveIntents();
    if (intents.length === 0) return;

    const status = liveStatusRef.current;
    if (!status.configured || !status.armedForLiveOrders) {
      return;
    }

    inflightLiveIntentsRef.current = true;
    try {
      for (const intent of intents) {
        if (intent.kind === 'EXIT') {
          if (intent.binanceSide !== 'SELL') {
            continue;
          }
          const resp = await fetch('/api/live/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: intent.symbol,
              side: 'SELL',
              type: 'MARKET',
              quantity: intent.quantity,
              preflightOnly: false,
            }),
          });
          const data = (await resp.json()) as {
            ok?: boolean;
            avgPrice?: number;
            latencyMs?: number;
            error?: string;
          };
          if (resp.ok && data.ok) {
            const pair = rt.snapshot.pairs.find((p) => p.symbol === intent.symbol);
            const exitPx = data.avgPrice && data.avgPrice > 0 ? data.avgPrice : pair?.lastPrice ?? 0;
            const pos = pair?.openPosition;
            const ratio =
              pos && intent.quantity && pos.remainingQuantity > 0
                ? Math.min(1, intent.quantity / pos.remainingQuantity)
                : 1;
            rt.recordExternalLiveExit(
              intent.symbol,
              ratio,
              exitPx,
              intent.reason as
                | 'StopLoss'
                | 'BreakEvenStop'
                | 'TrailingStop'
                | 'TakeProfit1'
                | 'TakeProfit2'
                | 'CircuitBreakerFlatten'
                | 'ManualClose',
              `[AUTO LIVE EXIT] ${intent.symbol} ${intent.reason} @ $${exitPx.toFixed(2)} (${data.latencyMs ?? 0}ms)`
            );
          } else {
            rt.snapshot.autoStats.lastActionSummary = `Live EXIT failed: ${data.error ?? 'Rejected'}`;
          }
        } else {
          // Automated ENTRY
          if (intent.binanceSide === 'SELL') {
            // Binance Spot API cannot open unhedged Short positions via spot SELL without inventory
            rt.snapshot.autoStats.lastActionSummary = `Skipped Spot Short ${intent.symbol} (set Spot Long Only)`;
            continue;
          }
          const binanceType =
            intent.orderMethod === 'LIMIT_MAKER'
              ? 'LIMIT_MAKER'
              : intent.orderMethod === 'LIMIT'
                ? 'LIMIT'
                : 'MARKET';
          const resp = await fetch('/api/live/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: intent.symbol,
              side: intent.binanceSide,
              type: binanceType,
              quoteOrderQty: intent.usdtAmount,
              price: intent.limitPrice,
              timeInForce: intent.timeInForce,
              preflightOnly: false,
            }),
          });
          const data = (await resp.json()) as {
            ok?: boolean;
            orderId?: string;
            orderStatus?: string;
            avgPrice?: number;
            latencyMs?: number;
            error?: string;
          };
          if (resp.ok && data.ok && intent.input) {
            if (data.orderStatus === 'NEW' && intent.limitPrice) {
              rt.recordExternalLivePendingOrder(
                intent.input,
                intent.limitPrice,
                data.orderId,
                `[AUTO LIVE] Resting ${binanceType} ${intent.symbol} @ $${intent.limitPrice.toFixed(2)} (${data.latencyMs ?? 0}ms)`
              );
            } else {
              rt.recordExternalLiveOrder(
                intent.input,
                `[AUTO LIVE] Filled ${binanceType} ${intent.symbol} $${intent.usdtAmount.toFixed(2)} (${data.latencyMs ?? 0}ms)`
              );
            }
          } else {
            rt.snapshot.autoStats.lastActionSummary = `Live AUTO ${intent.symbol} rejected: ${data.error ?? 'Error'}`;
          }
        }
      }
      syncSnapshots();
    } catch {
      // Ignore transient network errors cleanly
    } finally {
      inflightLiveIntentsRef.current = false;
    }
  }, [syncSnapshots]);

  const applyLiveStatusToRuntime = useCallback(
    (status: LiveCredentialStatus) => {
      setLiveStatus(status);
      if (liveRuntimeRef.current) {
        liveRuntimeRef.current.setEnvironment(status.environment);
        const usdtBal = status.syncedBalances.find((b) => b.asset === 'USDT');
        if (usdtBal) {
          liveRuntimeRef.current.syncLiveAccountBalance(usdtBal.free, usdtBal.locked);
        } else if (!status.configured) {
          liveRuntimeRef.current.syncLiveAccountBalance(0, 0);
        }
        syncSnapshots();
      }
    },
    [syncSnapshots]
  );

  // Hydrate server-side Live Credentials Vault status (secrets never leave server)
  useEffect(() => {
    let active = true;
    fetch('/api/live/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: LiveCredentialStatus | null) => {
        if (active && data) {
          applyLiveStatusToRuntime(data);
        }
      })
      .catch(() => {
        // Express proxy fallback ignored in static test environments
      });
    return () => {
      active = false;
    };
  }, [applyLiveStatusToRuntime]);

  // Isolated Paper Simulation auto-tick loop
  useEffect(() => {
    if (
      accountMode !== 'Paper' ||
      !paperSnapshot.running ||
      paperSnapshot.transport.feedSource !== 'Simulated'
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      if (paperRuntimeRef.current) {
        paperRuntimeRef.current.stepBar(Date.now());
        syncSnapshots();
      }
    }, 3200);
    return () => window.clearInterval(timer);
  }, [accountMode, paperSnapshot.running, paperSnapshot.transport.feedSource, syncSnapshots]);

  // Live Binance Public WebSocket stream + REST fallback when active runtime selects BinanceLive
  useEffect(() => {
    if (snapshot.transport.feedSource !== 'BinanceLive') {
      return;
    }
    const rt = activeRuntimeRef.current;
    if (!rt) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let restTimer: number | null = null;
    const isTestnet = snapshot.transport.environment === 'Testnet';
    const wsBase = isTestnet
      ? 'wss://stream.testnet.binance.vision/stream'
      : 'wss://stream.binance.com:9443/stream';
    const restBase = isTestnet
      ? 'https://testnet.binance.vision/api/v3'
      : 'https://api.binance.com/api/v3';

    const streams = config.trading.pairs
      .map((p) => `${p.toLowerCase()}@kline_${config.trading.timeframe}`)
      .join('/');
    const wsUrl = `${wsBase}?streams=${streams}`;

    const pollRestFallback = async () => {
      for (const symbol of config.trading.pairs) {
        if (cancelled) return;
        try {
          const resp = await fetch(
            `${restBase}/klines?symbol=${symbol}&interval=${config.trading.timeframe}&limit=2`
          );
          if (!resp.ok) continue;
          const rows = (await resp.json()) as Array<Array<string | number>>;
          const row = rows[rows.length - 1];
          if (!row) continue;
          const candle: Candle = {
            openTimeMs: Number(row[0]),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[5]),
            isClosed: true,
          };
          rt.stepBar(Date.now(), { symbol, candle });
          syncSnapshots();
          if (rt.snapshot.accountMode === 'Live') {
            void drainLiveIntents();
          }
        } catch {
          // Network blocked in restricted sandbox -> retain current state gracefully
        }
      }
    };

    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        if (!cancelled) {
          rt.setTransportMode('WsPrimary', 'Connected to live Binance WebSocket stream');
          syncSnapshots();
        }
      };
      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(event.data as string);
          const k = msg?.data?.k;
          const sym = msg?.data?.s;
          if (k && sym) {
            const candle: Candle = {
              openTimeMs: Number(k.t),
              open: Number(k.o),
              high: Number(k.h),
              low: Number(k.l),
              close: Number(k.c),
              volume: Number(k.v),
              isClosed: Boolean(k.x),
            };
            rt.stepBar(Date.now(), { symbol: sym, candle });
            syncSnapshots();
            if (rt.snapshot.accountMode === 'Live') {
              void drainLiveIntents();
            }
          }
        } catch {
          // Ignore malformed frame
        }
      };
      ws.onerror = () => {
        if (!cancelled) {
          rt.setTransportMode('RestFallback', 'Binance WS unavailable — switching to REST fallback');
          syncSnapshots();
          if (restTimer === null) {
            restTimer = window.setInterval(pollRestFallback, 3000);
          }
        }
      };
      ws.onclose = () => {
        if (!cancelled) {
          rt.setTransportMode('RestFallback', 'Binance WS closed — polling REST fallback');
          syncSnapshots();
          if (restTimer === null) {
            restTimer = window.setInterval(pollRestFallback, 3000);
          }
        }
      };
    } catch {
      rt.setTransportMode('RestFallback', 'WebSocket init failed — polling REST fallback');
      syncSnapshots();
      restTimer = window.setInterval(pollRestFallback, 3000);
    }

    return () => {
      cancelled = true;
      if (ws) ws.close();
      if (restTimer !== null) window.clearInterval(restTimer);
    };
  }, [
    accountMode,
    activeRuntimeRef,
    snapshot.transport.feedSource,
    snapshot.transport.environment,
    config.trading.pairs,
    config.trading.timeframe,
    syncSnapshots,
    drainLiveIntents,
  ]);

  const handleUpdateConfig = (next: BotConfig) => {
    setConfig(next);
    paperRuntimeRef.current?.updateConfig(next);
    liveRuntimeRef.current?.updateConfig(next);
    syncSnapshots();
  };

  const handleToggleAutomation = () => {
    const next: BotConfig = {
      ...config,
      automation: {
        ...config.automation,
        enabled: !config.automation.enabled,
      },
    };
    handleUpdateConfig(next);
  };

  const handleRunAutoScan = () => {
    const rt = activeRuntimeRef.current;
    if (!rt) return;
    rt.runAutoScanNow(Date.now());
    syncSnapshots();
    if (accountMode === 'Live') {
      void drainLiveIntents();
    }
  };

  const handleChangeTimeframe = (tf: Timeframe) => {
    const nextConfig: BotConfig = {
      ...config,
      trading: { ...config.trading, timeframe: tf },
    };
    setConfig(nextConfig);
    paperRuntimeRef.current?.setTimeframe(tf);
    liveRuntimeRef.current?.setTimeframe(tf);
    paperRuntimeRef.current?.updateConfig(nextConfig);
    liveRuntimeRef.current?.updateConfig(nextConfig);
    syncSnapshots();
  };

  const handleToggleRunning = () => {
    const rt = activeRuntimeRef.current;
    if (!rt) return;
    if (accountMode === 'Live' && !snapshot.running && (!liveStatus.configured || !liveStatus.armedForLiveOrders)) {
      setSection('bot');
      setBotSubTab('credentials');
      return;
    }
    rt.setRunning(!snapshot.running);
    syncSnapshots();
  };

  const handleStepBar = () => {
    activeRuntimeRef.current?.stepBar(Date.now());
    syncSnapshots();
    if (accountMode === 'Live') {
      void drainLiveIntents();
    }
  };

  const handleToggleFeedSource = (source: 'Simulated' | 'BinanceLive') => {
    const rt = activeRuntimeRef.current;
    if (!rt) return;
    if (accountMode === 'Live' && source === 'Simulated') {
      // Live runtime never executes synthetic simulated ticks; keep BinanceLive feed
      return;
    }
    rt.snapshot.transport.feedSource = source;
    if (source === 'Simulated') {
      rt.setTransportMode('WsPrimary', 'Switched to deterministic local simulation');
    }
    syncSnapshots();
  };

  const handleSimulateTransport = (mode: TransportMode) => {
    activeRuntimeRef.current?.setTransportMode(mode);
    syncSnapshots();
  };

  const handleEnvironmentToggle = () => {
    const nextEnv =
      snapshot.transport.environment === 'Testnet' ? 'Production' : 'Testnet';
    activeRuntimeRef.current?.setEnvironment(nextEnv);
    syncSnapshots();
  };

  const handleSubmitOrder = async (
    input: ManualOrderInput
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const rt = activeRuntimeRef.current;
    if (!rt) return { ok: false, reason: 'Engine uninitialized' };

    if (accountMode === 'Live') {
      if (!liveStatus.configured) {
        return {
          ok: false,
          reason: 'Live credentials not configured. Open Bot -> Live Credentials first.',
        };
      }
      if (!liveStatus.armedForLiveOrders) {
        return {
          ok: false,
          reason: 'Live execution is disarmed. Arm Live Order Execution in Live Credentials first.',
        };
      }
      const binanceType =
        input.orderType === 'LIMIT MAKER'
          ? 'LIMIT_MAKER'
          : input.orderType === 'LIMIT'
            ? 'LIMIT'
            : 'MARKET';
      try {
        const resp = await fetch('/api/live/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: input.symbol,
            side: input.side === 'Long' ? 'BUY' : 'SELL',
            type: binanceType,
            quoteOrderQty: input.usdtAmount,
            price: input.limitPrice,
            timeInForce: input.timeInForce ?? 'GTC',
            preflightOnly: false,
          }),
        });
        const data = (await resp.json()) as {
          ok?: boolean;
          error?: string;
          latencyMs?: number;
          orderId?: string;
          orderStatus?: string;
        };
        if (!resp.ok || !data.ok) {
          return { ok: false, reason: data.error ?? 'Binance live order rejected' };
        }
        if (data.orderStatus === 'NEW' && input.limitPrice) {
          rt.recordExternalLivePendingOrder(
            input,
            input.limitPrice,
            data.orderId,
            `Live ${liveStatus.environment} resting ${binanceType} ${input.symbol} @ $${input.limitPrice.toFixed(2)} (${data.latencyMs ?? 0}ms)`
          );
        } else {
          rt.recordExternalLiveOrder(
            input,
            `Live ${liveStatus.environment} ${binanceType} ${input.side} ${input.symbol} $${input.usdtAmount.toFixed(2)} (${data.latencyMs ?? 0}ms)`
          );
        }
        syncSnapshots();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'Failed to reach /api/live/order proxy',
        };
      }
    }

    const res = rt.submitManualOrder(input, Date.now());
    syncSnapshots();
    if (res.ok) {
      return { ok: true };
    }
    return res;
  };

  const handleClosePosition = async (symbol: string) => {
    const rt = activeRuntimeRef.current;
    if (!rt) return;

    if (accountMode === 'Live') {
      const pair = rt.snapshot.pairs.find((p) => p.symbol === symbol);
      const pos = pair?.openPosition;
      if (pos && liveStatus.configured && liveStatus.armedForLiveOrders && pos.side === 'Long') {
        try {
          const resp = await fetch('/api/live/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol,
              side: 'SELL',
              type: 'MARKET',
              quantity: pos.remainingQuantity,
              preflightOnly: false,
            }),
          });
          const data = (await resp.json()) as { ok?: boolean; avgPrice?: number; latencyMs?: number };
          if (resp.ok && data.ok) {
            const exitPx = data.avgPrice && data.avgPrice > 0 ? data.avgPrice : pair.lastPrice;
            rt.recordExternalLiveExit(
              symbol,
              1,
              exitPx,
              'ManualClose',
              `Live SELL exit ${symbol} @ $${exitPx.toFixed(2)} (${data.latencyMs ?? 0}ms)`
            );
            syncSnapshots();
            return;
          }
        } catch {
          // Fall through to local sync if Binance unreachable
        }
      }
    }

    rt.closePositionBySymbol(symbol, Date.now());
    syncSnapshots();
  };

  const handleFlattenAll = async () => {
    const rt = activeRuntimeRef.current;
    if (!rt) return;

    if (accountMode === 'Live' && liveStatus.configured && liveStatus.armedForLiveOrders) {
      const openPairs = rt.snapshot.pairs.filter((p) => p.openPosition?.side === 'Long');
      for (const p of openPairs) {
        try {
          await fetch('/api/live/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: p.symbol,
              side: 'SELL',
              type: 'MARKET',
              quantity: p.openPosition!.remainingQuantity,
              preflightOnly: false,
            }),
          });
        } catch {
          // Continue flattening remaining pairs
        }
      }
    }

    rt.flattenAllPositions();
    syncSnapshots();
  };

  const handleCancelPendingOrder = async (orderId: string) => {
    const rt = activeRuntimeRef.current;
    if (!rt) return;
    const ord = rt.snapshot.pendingOrders.find((o) => o.id === orderId);
    if (
      accountMode === 'Live' &&
      ord?.exchangeOrderId &&
      liveStatus.configured &&
      liveStatus.armedForLiveOrders
    ) {
      try {
        await fetch('/api/live/order', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: ord.symbol,
            orderId: ord.exchangeOrderId,
          }),
        });
      } catch {
        // Proceed with local removal after attempt
      }
    }
    rt.cancelPendingOrder(orderId);
    syncSnapshots();
  };

  const handleTripCB = () => {
    activeRuntimeRef.current?.tripCircuitBreaker('Manual operator circuit breaker activation');
    syncSnapshots();
  };

  const handleResetCB = () => {
    activeRuntimeRef.current?.resetCircuitBreaker();
    syncSnapshots();
  };

  const handleSimulateLoss = (symbol: string, lossUsdt: number) => {
    activeRuntimeRef.current?.simulateLossStress(symbol, lossUsdt);
    syncSnapshots();
  };

  const handleSelectPairAndTrade = (symbol: string) => {
    setSelectedSymbol(symbol);
    setSection('trade');
  };

  const handleOpenLiveCredentials = () => {
    setSection('bot');
    setBotSubTab('credentials');
  };

  const handleOpenStrategyConfig = () => {
    setSection('bot');
    setBotSubTab('strategy');
  };

  // Server-Side Live Credential Vault Actions
  const handleSaveCredentials = async (payload: {
    environment: 'Testnet' | 'Production';
    authMethod: BinanceAuthMethod;
    apiKey: string;
    apiSecret: string;
    recvWindowMs: number;
    maxOrderNotionalUsdt: number;
    requirePreflightTestOrder: boolean;
  }): Promise<{ ok: boolean; message: string }> => {
    try {
      const resp = await fetch('/api/live/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        status?: LiveCredentialStatus;
      };
      if (data.status) applyLiveStatusToRuntime(data.status);
      if (!resp.ok || !data.ok) {
        return { ok: false, message: data.error ?? 'Failed to save credentials' };
      }
      return {
        ok: true,
        message: `Credentials stored in server vault (${payload.environment} · ${payload.authMethod}).`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Unable to reach /api/live/config',
      };
    }
  };

  const handleVerifyConnection = async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const resp = await fetch('/api/live/verify', { method: 'POST' });
      const data = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        status?: LiveCredentialStatus;
      };
      if (data.status) applyLiveStatusToRuntime(data.status);
      if (!data.ok) {
        return {
          ok: false,
          message:
            data.status?.verificationMessage ?? data.error ?? 'Binance signature verification failed',
        };
      }
      return {
        ok: true,
        message: data.status?.verificationMessage ?? 'Verified Binance Spot API credentials',
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Verification request failed',
      };
    }
  };

  const handleRunPreflightOrder = async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const resp = await fetch('/api/live/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selectedSymbol,
          side: 'BUY',
          type: 'MARKET',
          quoteOrderQty: 25,
          preflightOnly: true,
        }),
      });
      const data = (await resp.json()) as { ok?: boolean; message?: string; error?: string };
      if (!resp.ok || !data.ok) {
        return { ok: false, message: data.error ?? 'Signed test order failed' };
      }
      return { ok: true, message: data.message ?? 'Signed preflight test order succeeded' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Preflight request failed',
      };
    }
  };

  const handleToggleArmLive = async (
    arm: boolean,
    confirmProduction: boolean
  ): Promise<{ ok: boolean; message: string }> => {
    try {
      const resp = await fetch('/api/live/arm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ armed: arm, confirmProduction }),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        status?: LiveCredentialStatus;
      };
      if (data.status) applyLiveStatusToRuntime(data.status);
      if (!resp.ok || !data.ok) {
        return { ok: false, message: data.error ?? 'Unable to toggle live arming' };
      }
      return {
        ok: true,
        message: arm
          ? `Live order execution ARMED (${data.status?.environment ?? liveStatus.environment})`
          : 'Live order execution DISARMED',
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Arm request failed',
      };
    }
  };

  const handleRevokeCredentials = async (): Promise<void> => {
    try {
      const resp = await fetch('/api/live/config', { method: 'DELETE' });
      const data = (await resp.json()) as { status?: LiveCredentialStatus };
      if (data.status) applyLiveStatusToRuntime(data.status);
    } catch {
      applyLiveStatusToRuntime(INITIAL_LIVE_STATUS);
    }
  };

  return (
    <div className="min-h-screen bg-[#0D1015] text-slate-100 flex flex-col">
      {/* Top Bar with Strict Paper vs Live Isolation Switcher */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] bg-[#10141B] px-3 sm:px-5">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            aria-label="Open navigation menu"
            onClick={() => setMobileMenuOpen(true)}
            className="rounded-md p-2 text-slate-300 hover:bg-white/[0.06] lg:hidden"
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </button>

          <div className="flex items-center gap-2 shrink-0">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#7DF2AD]/15 border border-[#7DF2AD]/30">
              <TrendingUp className="h-4 w-4 text-[#7DF2AD]" aria-hidden="true" />
            </div>
            <span className="font-display text-sm font-bold tracking-tight text-slate-50 sm:text-base whitespace-nowrap">
              ApexRust
            </span>
          </div>

          {/* Paper vs Live Isolation Switcher */}
          <div
            className="flex items-center rounded-lg border border-white/[0.08] bg-[#141820] p-0.5 shrink-0"
            role="group"
            aria-label="Execution account isolation mode"
          >
            <button
              type="button"
              onClick={() => setAccountMode('Paper')}
              className={`rounded-md px-2.5 py-1 text-[11px] font-bold tracking-wide transition whitespace-nowrap ${
                accountMode === 'Paper'
                  ? 'bg-[#7DF2AD] text-[#0B0F17]'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              PAPER
            </button>
            <button
              type="button"
              onClick={() => setAccountMode('Live')}
              className={`rounded-md px-2.5 py-1 text-[11px] font-bold tracking-wide transition whitespace-nowrap ${
                accountMode === 'Live'
                  ? 'bg-amber-400 text-[#0B0F17]'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              LIVE
            </button>
          </div>

          <button
            type="button"
            onClick={handleEnvironmentToggle}
            aria-label="Toggle Binance environment"
            className="hidden items-center gap-2 rounded-lg border border-white/[0.08] bg-[#141820] px-2.5 py-1.5 text-xs font-medium text-amber-300 transition hover:border-amber-400/40 sm:flex whitespace-nowrap"
          >
            <span className="inline-block h-2 w-2 rounded-full bg-amber-400" aria-hidden="true" />
            <span className="font-semibold tracking-wide">BINANCE</span>
            <span className="text-slate-400">· {snapshot.transport.environment}</span>
            <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
          </button>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={handleOpenLiveCredentials}
            className={`hidden items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition md:flex whitespace-nowrap ${
              liveStatus.configured
                ? liveStatus.armedForLiveOrders
                  ? 'border-amber-400/40 bg-amber-950/30 text-amber-200'
                  : 'border-emerald-500/30 bg-emerald-950/25 text-emerald-300'
                : 'border-white/[0.08] bg-[#141820] text-slate-300 hover:border-amber-400/40'
            }`}
          >
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {liveStatus.configured
                ? liveStatus.armedForLiveOrders
                  ? `Live Armed (${liveStatus.apiKeyMasked})`
                  : `Keys Vault (${liveStatus.apiKeyMasked})`
                : 'Live Credentials'}
            </span>
          </button>

          <span className="hidden items-center gap-1.5 font-mono text-xs text-slate-400 xl:inline-flex whitespace-nowrap">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                snapshot.transport.mode === 'WsPrimary' ? 'bg-[#7DF2AD]' : 'bg-amber-400'
              }`}
              aria-hidden="true"
            />
            {snapshot.transport.mode} · {config.trading.pairs.length} Pairs
          </span>

          <button
            type="button"
            onClick={handleToggleRunning}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition whitespace-nowrap shrink-0 ${
              snapshot.running
                ? 'border border-white/[0.08] bg-[#141820] text-slate-100 hover:bg-[#1C222D]'
                : accountMode === 'Live'
                  ? 'bg-amber-400 text-[#0B0F17] hover:bg-amber-300'
                  : 'bg-[#7DF2AD] text-[#0B0F17] hover:bg-[#95F7BD]'
            }`}
          >
            {snapshot.running ? (
              <>
                <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Pause Engine</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Resume Engine</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setMobileMenuOpen(false)}
            className="fixed inset-0 bg-black/65"
          />
          <aside className="relative z-10 flex w-60 flex-col border-r border-white/[0.06] bg-[#10141B]">
            <div className="flex h-14 items-center justify-between border-b border-white/[0.06] px-4">
              <span className="font-display text-base font-bold text-slate-50">ApexRust</span>
              <button
                type="button"
                aria-label="Close sidebar"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-slate-100"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 p-3" aria-label="Mobile workspace navigation">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = section === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSection(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition ${
                      active
                        ? 'bg-[#7DF2AD]/15 text-[#7DF2AD]'
                        : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-100'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{item.label}</span>
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => {
                  handleOpenLiveCredentials();
                  setMobileMenuOpen(false);
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-amber-300 hover:bg-white/[0.05]"
              >
                <KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Live Credentials</span>
              </button>
            </nav>
          </aside>
        </div>
      )}

      {/* Main Body: Left 76px Icon Rail + Workspace Canvas */}
      <div className="flex min-h-0 flex-1">
        <aside
          className="hidden w-[76px] shrink-0 flex-col border-r border-white/[0.06] bg-[#10141B] py-2 lg:flex"
          aria-label="Primary workspace navigation"
        >
          <nav className="flex flex-1 flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`relative flex flex-col items-center justify-center gap-1.5 py-3.5 text-[11px] font-medium transition whitespace-nowrap ${
                    active
                      ? 'bg-gradient-to-b from-[#173A2C]/90 to-[#11241D]/90 text-[#7DF2AD]'
                      : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
                  }`}
                >
                  {active && (
                    <span
                      className="absolute inset-y-0 left-0 w-0.5 bg-[#7DF2AD]"
                      aria-hidden="true"
                    />
                  )}
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 p-3.5 sm:p-5">
          {section === 'trade' && (
            <TradingDeskView
              snapshot={snapshot}
              config={config}
              liveStatus={liveStatus}
              selectedSymbol={selectedSymbol}
              onSelectSymbol={setSelectedSymbol}
              onChangeTimeframe={handleChangeTimeframe}
              onStepBar={handleStepBar}
              onToggleFeedSource={handleToggleFeedSource}
              onSimulateTransport={handleSimulateTransport}
              onSubmitOrder={handleSubmitOrder}
              onClosePosition={handleClosePosition}
              onFlattenAll={handleFlattenAll}
              onCancelPendingOrder={handleCancelPendingOrder}
              onToggleAutomation={handleToggleAutomation}
              onRunAutoScan={handleRunAutoScan}
              onOpenStrategyConfig={handleOpenStrategyConfig}
              onResetCircuitBreaker={handleResetCB}
              onOpenLiveCredentials={handleOpenLiveCredentials}
            />
          )}

          {section === 'markets' && (
            <MarketsView
              snapshot={snapshot}
              config={config}
              selectedSymbol={selectedSymbol}
              onSelectPairAndTrade={handleSelectPairAndTrade}
              onSimulateTransport={handleSimulateTransport}
              onToggleFeedSource={handleToggleFeedSource}
            />
          )}

          {section === 'bot' && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-3">
                <div
                  className="flex max-w-full items-center overflow-x-auto rounded-lg border border-white/[0.08] bg-[#141820] p-1"
                  role="tablist"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={botSubTab === 'strategy'}
                    onClick={() => setBotSubTab('strategy')}
                    className={`rounded-md px-4 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                      botSubTab === 'strategy'
                        ? 'bg-[#7DF2AD] text-[#0B0F17]'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    Strategy & ATR Exits
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={botSubTab === 'risk'}
                    onClick={() => setBotSubTab('risk')}
                    className={`rounded-md px-4 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                      botSubTab === 'risk'
                        ? 'bg-[#7DF2AD] text-[#0B0F17]'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    Risk & Circuit Breakers
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={botSubTab === 'credentials'}
                    onClick={() => setBotSubTab('credentials')}
                    className={`rounded-md px-4 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                      botSubTab === 'credentials'
                        ? 'bg-amber-400 text-[#0B0F17]'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    Live Credentials
                  </button>
                </div>

                <span className="font-mono text-xs text-slate-400">
                  Account:{' '}
                  <span className={accountMode === 'Live' ? 'text-amber-300' : 'text-[#7DF2AD]'}>
                    {accountMode}
                  </span>{' '}
                  · Risk:{' '}
                  <span
                    className={
                      snapshot.risk.state === 'Active'
                        ? 'text-[#7DF2AD]'
                        : snapshot.risk.state === 'Cooldown'
                          ? 'text-amber-400'
                          : 'text-rose-400'
                    }
                  >
                    {snapshot.risk.state}
                  </span>
                </span>
              </div>

              {botSubTab === 'strategy' && (
                <StrategyConfigView
                  config={config}
                  snapshot={snapshot}
                  onUpdateConfig={handleUpdateConfig}
                  onToggleAutomation={handleToggleAutomation}
                  onRunAutoScan={handleRunAutoScan}
                />
              )}

              {botSubTab === 'risk' && (
                <RiskCircuitBreakerView
                  snapshot={snapshot}
                  config={config}
                  onUpdateConfig={handleUpdateConfig}
                  onSimulateLoss={handleSimulateLoss}
                  onTripCircuitBreaker={handleTripCB}
                  onResetCircuitBreaker={handleResetCB}
                />
              )}

              {botSubTab === 'credentials' && (
                <LiveCredentialsView
                  liveStatus={liveStatus}
                  accountMode={accountMode}
                  onSaveCredentials={handleSaveCredentials}
                  onVerifyConnection={handleVerifyConnection}
                  onRunPreflightOrder={handleRunPreflightOrder}
                  onToggleArmLive={handleToggleArmLive}
                  onRevokeCredentials={handleRevokeCredentials}
                  onSwitchAccountMode={setAccountMode}
                />
              )}
            </div>
          )}

          {section === 'signal' && (
            <SignalsView
              snapshot={snapshot}
              config={config}
              onSelectPairAndTrade={handleSelectPairAndTrade}
            />
          )}

          {section === 'rust' && <RustCodebaseView />}
        </main>
      </div>
    </div>
  );
}
