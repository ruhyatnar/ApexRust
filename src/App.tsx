import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart2,
  Bot,
  ChevronDown,
  ClipboardList,
  Cloud,
  Code2,
  KeyRound,
  Laptop,
  Menu,
  Pause,
  Play,
  Radio,
  TrendingUp,
  X,
} from 'lucide-react';
import { FeatureTogglesView } from './components/FeatureTogglesView';
import { GitBackupView } from './components/GitBackupView';
import { LiveCredentialsView } from './components/LiveCredentialsView';
import { MarketsView, SignalsView } from './components/MarketsAndSignalsView';
import { OrderHistoryView } from './components/OrderHistoryView';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { RemoteEngineView, type ServerConnectionHealth } from './components/RemoteEngineView';
import { RiskCircuitBreakerView } from './components/RiskCircuitBreakerView';
import { RustCodebaseView } from './components/RustCodebaseView';
import { StrategyConfigView } from './components/StrategyConfigView';
import { TradingDeskView } from './components/TradingDeskView';
import {
  type ConnectionProfile,
  apiFetch,
  buildWebSocketUrlWithTicket,
  loadConnectionProfile,
  setActiveConnectionProfile,
  setLocalAccessToken,
} from './engine/apiClient';
import {
  mapRustEngineSnapshot,
  mergeRemoteVpsSnapshot,
  type RemoteVpsEngineSnapshot,
} from './engine/engineSnapshotAdapter';
import {
  clearPersistedBotConfig,
  loadPersistedBotConfig,
  loadPersistedWorkspaceUiState,
  savePersistedBotConfig,
  savePersistedWorkspaceUiState,
  type PersistedWorkspaceUiState,
} from './engine/configStorage';
import { fmtPx } from './engine/formatters';
import {
  collectNewLiveFillNotifications,
  dispatchDesktopLiveFillNotifications,
  type LiveExecutionNotificationPayload,
} from './engine/liveFillNotifications';
import { SimulationRuntime } from './engine/simulator';
import type {
  BinanceAuthMethod,
  BinanceExecutionRecord,
  BotConfig,
  Candle,
  EngineSnapshot,
  ExchangeVenue,
  ExecutionAccountMode,
  ExitReason,
  LiveCredentialStatus,
  ManualOrderInput,
  MarginType,
  OrderExecutionLog,
  PairSelectionMode,
  ScreenerSnapshotPayload,
  Timeframe,
  TransportMode,
  TrendingCategory,
  VolatilitySpikeAlert,
} from './engine/types';

type ActiveSection = 'trade' | 'markets' | 'orders' | 'bot' | 'signal' | 'rust';
type BotSubTab = 'strategy' | 'features' | 'risk' | 'credentials' | 'git' | 'vps';

const NAV_ITEMS: Array<{
  id: ActiveSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'trade', label: 'Trade', icon: TrendingUp },
  { id: 'markets', label: 'Markets', icon: BarChart2 },
  { id: 'orders', label: 'Orders', icon: ClipboardList },
  { id: 'bot', label: 'Bot', icon: Bot },
  { id: 'signal', label: 'Signal', icon: Radio },
  { id: 'rust', label: 'Rust', icon: Code2 },
];

const INITIAL_LIVE_STATUS: LiveCredentialStatus = {
  configured: false,
  environment: 'Testnet',
  venue: 'Spot',
  leverage: 3,
  marginType: 'ISOLATED',
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
  // Hydrate persisted bot configuration and workspace UI state once before initializing runtimes
  const initialConfigRef = useRef<BotConfig | null>(null);
  if (!initialConfigRef.current) {
    initialConfigRef.current = loadPersistedBotConfig();
  }
  const initialUiRef = useRef<PersistedWorkspaceUiState | null>(null);
  if (!initialUiRef.current) {
    initialUiRef.current = loadPersistedWorkspaceUiState();
  }
  const initialConfig = initialConfigRef.current;
  const initialUi = initialUiRef.current;
  const initialEnv = initialUi.environment ?? 'Testnet';

  // Strictly isolated runtime instances: Paper Sandbox vs Live Execution
  const paperRuntimeRef = useRef<SimulationRuntime | null>(null);
  const liveRuntimeRef = useRef<SimulationRuntime | null>(null);
  if (!paperRuntimeRef.current) {
    paperRuntimeRef.current = new SimulationRuntime(initialConfig, Date.now(), {
      accountMode: 'Paper',
      seedDemoData: true,
      environment: initialEnv,
    });
    if (initialUi.paperFeedSource === 'BinanceLive') {
      paperRuntimeRef.current.snapshot.transport.feedSource = 'BinanceLive';
    }
    if (initialUi.paperRunning === false) {
      // Restore the operator's Paper pause silently (no "paused by operator" log on boot).
      // Live deliberately always boots paused: browser state is not restored after a reload.
      paperRuntimeRef.current.snapshot.running = false;
    }
  }
  if (!liveRuntimeRef.current) {
    liveRuntimeRef.current = new SimulationRuntime(initialConfig, Date.now(), {
      accountMode: 'Live',
      seedDemoData: false,
      initialEquityOverride: 0,
      environment: initialEnv,
    });
  }

  const [accountMode, setAccountMode] = useState<ExecutionAccountMode>(initialUi.accountMode);
  const [config, setConfig] = useState<BotConfig>(() => structuredClone(initialConfig));
  const [paperSnapshot, setPaperSnapshot] = useState<EngineSnapshot>(() =>
    structuredClone(paperRuntimeRef.current!.snapshot)
  );
  const [liveSnapshot, setLiveSnapshot] = useState<EngineSnapshot>(() =>
    structuredClone(liveRuntimeRef.current!.snapshot)
  );
  const [liveStatus, setLiveStatus] = useState<LiveCredentialStatus>(INITIAL_LIVE_STATUS);
  // Distinguishes "never started in this session" from "paused by the operator" in the header CTA
  const [liveStartedThisSession, setLiveStartedThisSession] = useState(false);

  const [section, setSection] = useState<ActiveSection>(initialUi.section);
  const [botSubTab, setBotSubTab] = useState<BotSubTab>(initialUi.botSubTab);
  const [selectedSymbol, setSelectedSymbol] = useState<string>(initialUi.selectedSymbol);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [orderLogRefreshKey, setOrderLogRefreshKey] = useState(0);
  const [volatilityToast, setVolatilityToast] = useState<VolatilitySpikeAlert | null>(null);
  const [liveFillToast, setLiveFillToast] = useState<LiveExecutionNotificationPayload | null>(null);
  const [notifPermission, setNotifPermission] = useState<string>(() =>
    typeof window !== 'undefined' && 'Notification' in window
      ? window.Notification.permission
      : 'unsupported'
  );
  const [liveTicker, setLiveTicker] = useState<{
    symbol: string;
    bid: number;
    ask: number;
    last: number;
  } | null>(null);

  const activeRuntimeRef = accountMode === 'Live' ? liveRuntimeRef : paperRuntimeRef;
  const snapshot = accountMode === 'Live' ? liveSnapshot : paperSnapshot;
  const liveStatusRef = useRef<LiveCredentialStatus>(liveStatus);
  liveStatusRef.current = liveStatus;
  const inflightLiveIntentsRef = useRef(false);
  const hydratedServerVaultRef = useRef(false);
  const syncedExecIdsRef = useRef<Set<string> | null>(null);
  if (!syncedExecIdsRef.current) {
    syncedExecIdsRef.current = new Set([
      ...paperRuntimeRef.current!.snapshot.executionHistory.map((r) => `Paper:${r.id}`),
      ...liveRuntimeRef.current!.snapshot.executionHistory.map((r) => `Live:${r.id}`),
    ]);
  }
  const inflightExecIdsRef = useRef<Set<string>>(new Set());
  const notifiedLiveFillIdsRef = useRef<Set<string> | null>(null);
  if (!notifiedLiveFillIdsRef.current) {
    notifiedLiveFillIdsRef.current = new Set(
      liveRuntimeRef.current!.snapshot.executionHistory.map((r) => r.id)
    );
  }

  const dispatchBrowserVolatilityNotifications = useCallback((alerts: VolatilitySpikeAlert[]) => {
    if (alerts.length === 0) return;
    const latest = alerts[alerts.length - 1];
    setVolatilityToast(latest);

    if (
      typeof window !== 'undefined' &&
      'Notification' in window &&
      window.Notification.permission === 'granted'
    ) {
      for (const alert of alerts) {
        try {
          new window.Notification(`⚡ ATR Volatility Spike: ${alert.symbol}`, {
            body: alert.message,
            tag: alert.id,
          });
        } catch {
          // Ignore Notification constructor errors in restricted environments
        }
      }
    }
  }, []);

  const dispatchBrowserLiveFillNotifications = useCallback(
    (notifications: LiveExecutionNotificationPayload[]) => {
      if (notifications.length === 0) return;
      setLiveFillToast(notifications[notifications.length - 1]);
      dispatchDesktopLiveFillNotifications(notifications);
    },
    []
  );

  const syncSnapshots = useCallback(() => {
    const newAlerts: VolatilitySpikeAlert[] = [];
    const newLiveFills: LiveExecutionNotificationPayload[] = [];
    if (paperRuntimeRef.current) {
      newAlerts.push(...paperRuntimeRef.current.consumePendingVolatilityAlerts());
      setPaperSnapshot(structuredClone(paperRuntimeRef.current.snapshot));
    }
    if (liveRuntimeRef.current) {
      newAlerts.push(...liveRuntimeRef.current.consumePendingVolatilityAlerts());
      if (notifiedLiveFillIdsRef.current) {
        newLiveFills.push(
          ...collectNewLiveFillNotifications(
            liveRuntimeRef.current.snapshot.executionHistory,
            notifiedLiveFillIdsRef.current
          )
        );
      }
      setLiveSnapshot(structuredClone(liveRuntimeRef.current.snapshot));
    }
    if (newAlerts.length > 0) {
      dispatchBrowserVolatilityNotifications(newAlerts);
    }
    if (newLiveFills.length > 0) {
      dispatchBrowserLiveFillNotifications(newLiveFills);
    }
  }, [dispatchBrowserVolatilityNotifications, dispatchBrowserLiveFillNotifications]);

  const activeVenue = config.trading.venue;
  const activeVenueRef = useRef<ExchangeVenue>(activeVenue);
  activeVenueRef.current = activeVenue;
  const activeLeverageRef = useRef<number>(config.trading.leverage);
  activeLeverageRef.current = config.trading.leverage;
  const configRef = useRef<BotConfig>(config);
  configRef.current = config;
  const selectedSymbolRef = useRef<string>(selectedSymbol);
  selectedSymbolRef.current = selectedSymbol;
  const [screenerSnapshot, setScreenerSnapshot] = useState<ScreenerSnapshotPayload | null>(null);
  const [screenerCategory, setScreenerCategory] = useState<TrendingCategory>(
    () => initialConfig.trading.trendingCategory ?? 'hot_volume'
  );
  const screenerSnapshotRef = useRef<ScreenerSnapshotPayload | null>(null);
  screenerSnapshotRef.current = screenerSnapshot;
  const gitBackupTimerRef = useRef<number | null>(null);
  const watchlistSyncTimerRef = useRef<number | null>(null);
  const pendingLiveDrainRef = useRef<boolean>(false);
  const binanceWsRef = useRef<WebSocket | null>(null);
  const subscribedBinanceStreamsRef = useRef<Set<string>>(new Set());
  const bookTickerUpdatedAtRef = useRef<Record<string, number>>({});
  const lastBookUiSyncRef = useRef<number>(0);
  const warmedKeysRef = useRef<Set<string>>(new Set());
  const warmingInProgressRef = useRef<boolean>(false);
  const lastAutoRotateMsRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (gitBackupTimerRef.current !== null) {
        window.clearTimeout(gitBackupTimerRef.current);
      }
      if (watchlistSyncTimerRef.current !== null) {
        window.clearTimeout(watchlistSyncTimerRef.current);
      }
    };
  }, []);

  const drainLiveIntents = useCallback(async () => {
    const rt = liveRuntimeRef.current;
    if (!rt) return;
    if (inflightLiveIntentsRef.current) {
      pendingLiveDrainRef.current = true;
      return;
    }
    const intents = rt.consumeLiveIntents();
    if (intents.length === 0) return;

    if (connectionHealthRef.current?.engineAuthority === 'daemon') {
      rt.reportLiveAutoRejected(
        '☁️ 24/7 Auto-Trading runs on your Remote VPS Daemon — browser Live auto intents skipped to prevent duplicate orders.'
      );
      syncSnapshots();
      return;
    }

    const status = liveStatusRef.current;
    if (!status.configured || !status.armedForLiveOrders) {
      rt.reportLiveAutoRejected(
        `Live auto intent skipped (${intents.length}): server credentials not configured or disarmed.`
      );
      syncSnapshots();
      return;
    }

    const venue = activeVenueRef.current;
    const leverage = activeLeverageRef.current;
    const cfg = configRef.current;

    const dispatchLiveEntryOrder = async (entry: {
      symbol: string;
      binanceSide: 'BUY' | 'SELL';
      orderMethod: 'MARKET' | 'LIMIT' | 'LIMIT_MAKER' | 'OCO';
      usdtAmount: number;
      limitPrice?: number;
      timeInForce: 'GTC' | 'IOC' | 'FOK';
      input?: ManualOrderInput;
    }) => {
      if (venue === 'Spot' && entry.binanceSide === 'SELL') {
        rt.reportLiveAutoRejected(
          `Skipped Spot Short ${entry.symbol} (switch to USD-M Futures or Spot Long)`
        );
        return;
      }
      const binanceType =
        entry.orderMethod === 'OCO'
          ? 'OCO'
          : entry.orderMethod === 'LIMIT_MAKER'
            ? 'LIMIT_MAKER'
            : entry.orderMethod === 'LIMIT'
              ? 'LIMIT'
              : 'MARKET';
      const pair = rt.snapshot.pairs.find((p) => p.symbol === entry.symbol);
      const refPx =
        entry.limitPrice && entry.limitPrice > 0 ? entry.limitPrice : pair?.lastPrice ?? 0;
      const isLong = entry.binanceSide === 'BUY';
      const autoTargets = entry.input?.targets ?? [];
      const bracketTarget =
        venue === 'Futures' && autoTargets.length > 1
          ? autoTargets[autoTargets.length - 1]
          : autoTargets[0];
      const tpPct = bracketTarget?.pctOffset ?? 2.5;
      const atrVal = pair?.indicators.atr ?? refPx * 0.01;
      const slDist =
        entry.input?.stopLossMode === 'ATR' && cfg.features.atrDynamicExits
          ? atrVal * cfg.exits.atrSlMultiplier
          : refPx * ((entry.input?.stopLossPct ?? 1.5) / 100);
      const tpAllowed = Boolean(cfg.features.takeProfitLadder);
      const tpPx =
        binanceType === 'OCO' && refPx > 0 && tpAllowed
          ? refPx * (1 + (isLong ? 1 : -1) * (tpPct / 100))
          : undefined;
      const slPx =
        binanceType === 'OCO' && refPx > 0
          ? isLong
            ? refPx - slDist
            : refPx + slDist
          : undefined;

      const resp = await apiFetch('/api/live/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: entry.symbol,
          venue,
          leverage,
          side: entry.binanceSide,
          type: binanceType,
          quoteOrderQty: entry.usdtAmount,
          price: entry.limitPrice,
          timeInForce: entry.timeInForce,
          takeProfitPrice: tpPx,
          stopLossPrice: slPx,
          workingType: entry.input?.workingType ?? 'MARK_PRICE',
          preflightOnly: false,
        }),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        orderId?: string;
        orderStatus?: string;
        executedQty?: number;
        avgPrice?: number;
        commission?: number;
        baseCommission?: number;
        commissionAsset?: string;
        ocoOrderListId?: number;
        algoOrderIds?: string[];
        ocoWarning?: string;
        ocoNote?: string;
        latencyMs?: number;
        error?: string;
      };
      if (resp.ok && data.ok && entry.input) {
        const statusUpper = String(data.orderStatus ?? '').toUpperCase();
        const execQtyNum = Number(data.executedQty ?? 0) || 0;
        const isTerminalUnfilled =
          (statusUpper === 'EXPIRED' ||
            statusUpper === 'EXPIRED_IN_MATCH' ||
            statusUpper === 'CANCELED' ||
            statusUpper === 'REJECTED') &&
          execQtyNum <= 0;
        if (isTerminalUnfilled) {
          rt.reportLiveAutoRejected(
            `Live AUTO ${entry.symbol} ${binanceType} ended ${statusUpper} with 0 fill (${data.latencyMs ?? 0}ms)`
          );
        } else if (statusUpper === 'NEW' && entry.limitPrice) {
          const summary = `[AUTO LIVE ${venue}] Resting ${binanceType} ${entry.symbol} @ $${fmtPx(entry.limitPrice)} (${data.latencyMs ?? 0}ms)`;
          rt.recordExternalLivePendingOrder(
            entry.input,
            entry.limitPrice,
            data.orderId,
            summary,
            Date.now(),
            'auto'
          );
          rt.confirmLiveAutoDispatch(summary);
        } else {
          const summary = `[AUTO LIVE ${venue}] Filled ${binanceType} ${entry.symbol} $${entry.usdtAmount.toFixed(2)}${data.ocoNote ? ` · ${data.ocoNote}` : ''} (${data.latencyMs ?? 0}ms)`;
          rt.recordExternalLiveOrder(entry.input, summary, Date.now(), {
            executedQty: data.executedQty,
            avgPrice: data.avgPrice,
            commission: data.commission,
            baseCommission: data.baseCommission,
            commissionAsset: data.commissionAsset,
            orderId: data.orderId,
            ocoOrderListId: data.ocoOrderListId,
            algoOrderIds: data.algoOrderIds,
          });
          rt.confirmLiveAutoDispatch(summary);
        }
      } else {
        rt.reportLiveAutoRejected(`Live AUTO ${entry.symbol} rejected: ${data.error ?? 'Error'}`);
      }
    };

    inflightLiveIntentsRef.current = true;
    try {
      for (const intent of intents) {
        if (intent.kind === 'CANCEL_PENDING') {
          const pending = intent.pendingOrderId
            ? rt.snapshot.pendingOrders.find((p) => p.id === intent.pendingOrderId)
            : undefined;
          if (!intent.exchangeOrderId) {
            if (pending) {
              rt.confirmLivePendingCanceled(pending.id, intent.reason, Date.now());
            }
            continue;
          }
          const cancelResp = await apiFetch('/api/live/cancel-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: intent.symbol,
              venue,
              orderId: intent.exchangeOrderId,
              side: intent.binanceSide,
              reason: intent.reason,
            }),
          });
          const cancelData = (await cancelResp.json()) as {
            ok?: boolean;
            alreadyFilled?: boolean;
            executedQty?: number;
            avgPrice?: number;
            error?: string;
          };
          if (cancelResp.ok && cancelData.ok && cancelData.alreadyFilled) {
            if (pending) {
              rt.promoteExternalLivePendingOrder(
                pending.id,
                cancelData.avgPrice,
                cancelData.executedQty,
                Date.now()
              );
            }
          } else if (cancelResp.ok && cancelData.ok) {
            if (pending) {
              rt.confirmLivePendingCanceled(pending.id, intent.reason, Date.now());
            }
          } else {
            rt.reportLiveAutoRejected(
              `Live cancel failed (${intent.symbol}): ${cancelData.error ?? `HTTP ${cancelResp.status}`}`
            );
          }
        } else if (intent.kind === 'EXIT') {
          if (venue === 'Spot' && intent.binanceSide !== 'SELL') {
            continue;
          }
          const pairBeforeExit = rt.snapshot.pairs.find((p) => p.symbol === intent.symbol);
          const posBeforeExit = pairBeforeExit?.openPosition;
          // On Futures partial TP1, keep the protective SL algo bracket intact for the remaining runner.
          const isFuturesPartialTp1 = venue === 'Futures' && intent.reason === 'TakeProfit1';
          if (
            !isFuturesPartialTp1 &&
            posBeforeExit &&
            (posBeforeExit.exchangeListId != null ||
              (posBeforeExit.exchangeAlgoIds && posBeforeExit.exchangeAlgoIds.length > 0))
          ) {
            try {
              await apiFetch('/api/live/cancel-open-brackets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  symbol: intent.symbol,
                  venue,
                  orderListId: posBeforeExit.exchangeListId,
                  algoOrderIds: posBeforeExit.exchangeAlgoIds,
                }),
              });
            } catch {
              // Best-effort bracket cleanup before market exit
            }
          }

          const resp = await apiFetch('/api/live/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: intent.symbol,
              venue,
              leverage,
              side: intent.binanceSide,
              type: 'MARKET',
              quantity: intent.quantity,
              reduceOnly: true,
              preflightOnly: false,
            }),
          });
          const data = (await resp.json()) as {
            ok?: boolean;
            orderId?: string;
            executedQty?: number;
            avgPrice?: number;
            latencyMs?: number;
            error?: string;
          };
          if (resp.ok && data.ok) {
            const pair = rt.snapshot.pairs.find((p) => p.symbol === intent.symbol);
            const exitPx = data.avgPrice && data.avgPrice > 0 ? data.avgPrice : pair?.lastPrice ?? 0;
            const pos = pair?.openPosition;
            const actualExecQty =
              data.executedQty && data.executedQty > 0 ? data.executedQty : intent.quantity;
            const ratio =
              pos && actualExecQty && pos.remainingQuantity > 0
                ? Math.min(1, actualExecQty / pos.remainingQuantity)
                : 1;
            rt.recordExternalLiveExit(
              intent.symbol,
              ratio,
              exitPx,
              intent.reason as ExitReason,
              `[AUTO LIVE EXIT ${venue}] ${intent.symbol} ${intent.reason} @ $${exitPx.toFixed(exitPx >= 100 ? 2 : 4)} (${data.latencyMs ?? 0}ms)`,
              Date.now(),
              data.orderId,
              data.executedQty
            );
            if (
              intent.flipAfterExit &&
              venue === 'Futures' &&
              cfg.automation.autoFlipOnReversal &&
              cfg.features.automatedTrading
            ) {
              const flipInput = intent.flipAfterExit.input;
              const flipOrderMethod =
                flipInput.orderType === 'MARKET'
                  ? 'MARKET'
                  : flipInput.orderType === 'LIMIT'
                    ? 'LIMIT'
                    : flipInput.orderType === 'LIMIT MAKER'
                      ? 'LIMIT_MAKER'
                      : cfg.automation.orderMethod;
              await dispatchLiveEntryOrder({
                symbol: flipInput.symbol,
                binanceSide: flipInput.side === 'Long' ? 'BUY' : 'SELL',
                orderMethod: flipOrderMethod,
                usdtAmount: flipInput.usdtAmount,
                limitPrice: flipInput.limitPrice,
                timeInForce: flipInput.timeInForce ?? cfg.automation.timeInForce,
                input: flipInput,
              });
            }
          } else {
            rt.reportLiveAutoRejected(`Live EXIT failed (${intent.symbol}): ${data.error ?? 'Rejected'}`);
          }
        } else {
          await dispatchLiveEntryOrder(intent);
        }
      }
      syncSnapshots();
    } catch (err) {
      rt.reportLiveAutoRejected(
        `Live AUTO intent error: ${err instanceof Error ? err.message : 'Network error'}`
      );
      syncSnapshots();
    } finally {
      inflightLiveIntentsRef.current = false;
      if (pendingLiveDrainRef.current) {
        pendingLiveDrainRef.current = false;
        void drainLiveIntents();
      }
    }
  }, [syncSnapshots]);

  const applyLiveStatusToRuntime = useCallback(
    (status: LiveCredentialStatus) => {
      setLiveStatus(status);
      if (!hydratedServerVaultRef.current) {
        hydratedServerVaultRef.current = true;
        const prev = configRef.current;
        const nextVenue = status.venue ?? prev.trading.venue;
        const nextLev = status.leverage ?? prev.trading.leverage;
        const nextMargin = status.marginType ?? prev.trading.marginType;
        if (
          nextVenue !== prev.trading.venue ||
          nextLev !== prev.trading.leverage ||
          nextMargin !== prev.trading.marginType
        ) {
          const updated: BotConfig = {
            ...prev,
            trading: {
              ...prev.trading,
              venue: nextVenue,
              leverage: nextLev,
              marginType: nextMargin,
            },
          };
          setConfig(updated);
          paperRuntimeRef.current?.updateConfig(updated);
          liveRuntimeRef.current?.updateConfig(updated);
        }
      }
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

  const [connectionProfile, setConnectionProfile] = useState<ConnectionProfile>(() =>
    loadConnectionProfile()
  );
  const [connectionHealth, setConnectionHealth] = useState<ServerConnectionHealth | null>(null);
  const [remoteVpsSnapshot, setRemoteVpsSnapshot] = useState<RemoteVpsEngineSnapshot | null>(null);
  const [localTokenDraft, setLocalTokenDraft] = useState('');
  const connectionHealthRef = useRef<ServerConnectionHealth | null>(null);
  connectionHealthRef.current = connectionHealth;
  const sharedProfileCheckedRef = useRef(false);

  const serverTargetLabel =
    connectionProfile.kind === 'remote'
      ? `☁️ Remote VPS (${connectionProfile.name})`
      : '🖥️ This Computer';

  const handleChangeConnectionProfile = useCallback((next: ConnectionProfile) => {
    hydratedServerVaultRef.current = false;
    setRemoteVpsSnapshot(null);
    setActiveConnectionProfile(next);
    setConnectionProfile(next);
  }, []);

  const refreshConnectionHealth = useCallback(async () => {
    const started = Date.now();
    try {
      const resp = await apiFetch('/api/connection/info');
      const latencyMs = Math.max(1, Date.now() - started);
      if (resp.status === 401 || resp.status === 429) {
        const errData = (await resp.json().catch(() => ({}))) as {
          error?: string;
          retryAfterSeconds?: number;
        };
        setConnectionHealth({
          checkedAtMs: Date.now(),
          reachable: true,
          latencyMs,
          authOk: false,
          authRequired: true,
          engineAuthority: 'browser',
          engineReachable: false,
          engineRunning: null,
          environment: 'Testnet',
          venue: 'Spot',
          zeroTrustUser: null,
          apiVersion: '2.0.0',
          error: errData.error || 'Access Token rejected (401)',
          retryAfterSeconds:
            typeof errData.retryAfterSeconds === 'number' && errData.retryAfterSeconds > 0
              ? errData.retryAfterSeconds
              : undefined,
        });
        return;
      }
      if (!resp.ok) {
        setConnectionHealth({
          checkedAtMs: Date.now(),
          reachable: false,
          latencyMs: null,
          authOk: false,
          authRequired: false,
          engineAuthority: 'browser',
          engineReachable: false,
          engineRunning: null,
          environment: 'Testnet',
          venue: 'Spot',
          zeroTrustUser: null,
          apiVersion: '2.0.0',
          error: `HTTP ${resp.status}`,
        });
        return;
      }
      const data = (await resp.json()) as {
        authRequired?: boolean;
        engineAuthority?: 'browser' | 'daemon';
        engineReachable?: boolean;
        engineRunning?: boolean | null;
        environment?: 'Testnet' | 'Production';
        venue?: 'Spot' | 'Futures';
        zeroTrustUser?: string | null;
        apiVersion?: string;
      };
      setConnectionHealth({
        checkedAtMs: Date.now(),
        reachable: true,
        latencyMs,
        authOk: true,
        authRequired: Boolean(data.authRequired),
        engineAuthority: data.engineAuthority === 'daemon' ? 'daemon' : 'browser',
        engineReachable: Boolean(data.engineReachable),
        engineRunning: typeof data.engineRunning === 'boolean' ? data.engineRunning : null,
        environment: data.environment === 'Production' ? 'Production' : 'Testnet',
        venue: data.venue === 'Futures' ? 'Futures' : 'Spot',
        zeroTrustUser: data.zeroTrustUser ?? null,
        apiVersion: String(data.apiVersion ?? '2.0.0'),
      });
    } catch (err) {
      setConnectionHealth({
        checkedAtMs: Date.now(),
        reachable: false,
        latencyMs: null,
        authOk: false,
        authRequired: false,
        engineAuthority: 'browser',
        engineReachable: false,
        engineRunning: null,
        environment: 'Testnet',
        venue: 'Spot',
        zeroTrustUser: null,
        apiVersion: '2.0.0',
        error: err instanceof Error ? err.message : 'Unable to reach server',
      });
    }
  }, []);

  // Hydrate shared .apexrust/remote-profile.json once at boot if CLI/installer configured a Remote VPS profile
  useEffect(() => {
    if (sharedProfileCheckedRef.current) return;
    sharedProfileCheckedRef.current = true;
    try {
      if (window.localStorage.getItem('apexrust_connection_profile_v1')) return;
    } catch {
      // Ignore storage access errors
    }
    if (connectionProfile.kind === 'remote') return;
    apiFetch('/api/remote-profile')
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            ok?: boolean;
            profile?: { activeMode?: string; name?: string; baseUrl?: string; token?: string };
          } | null
        ) => {
          if (
            data?.ok &&
            data.profile?.activeMode === 'remote' &&
            typeof data.profile.baseUrl === 'string' &&
            data.profile.baseUrl.trim()
          ) {
            handleChangeConnectionProfile({
              kind: 'remote',
              name: (data.profile.name || 'Remote VPS').trim(),
              baseUrl: data.profile.baseUrl.trim(),
              token: data.profile.token ?? '',
              rememberToken: Boolean(data.profile.token),
            });
          }
        }
      )
      .catch(() => undefined);
  }, [connectionProfile.kind, handleChangeConnectionProfile]);

  useEffect(() => {
    void refreshConnectionHealth();
    const timer = window.setInterval(() => {
      void refreshConnectionHealth();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [refreshConnectionHealth, connectionProfile]);

  // Acquire/renew single-browser Live Lease when browser is the execution authority
  useEffect(() => {
    if (
      accountMode !== 'Live' ||
      !liveStatus.configured ||
      connectionHealth?.engineAuthority === 'daemon'
    ) {
      return;
    }
    const renewLease = () => {
      void apiFetch('/api/live/lease', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).catch(() => undefined);
    };
    renewLease();
    const timer = window.setInterval(renewLease, 10_000);
    return () => window.clearInterval(timer);
  }, [accountMode, liveStatus.configured, connectionHealth?.engineAuthority, connectionProfile]);

  // Hydrate server-side Live Credentials Vault status (secrets never leave server)
  useEffect(() => {
    let active = true;
    apiFetch('/api/live/config')
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
  }, [applyLiveStatusToRuntime, connectionProfile, connectionHealth?.authOk]);

  const isRemoteVpsDaemon =
    connectionProfile.kind === 'remote' ||
    (connectionHealth?.engineAuthority === 'daemon' &&
      Boolean(connectionHealth?.engineReachable));

  const refreshRemoteVpsSnapshot = useCallback(async () => {
    if (accountMode !== 'Live' || !isRemoteVpsDaemon) return;
    try {
      const resp = await apiFetch('/api/engine/snapshot');
      if (!resp.ok) return;
      const data = (await resp.json()) as { ok?: boolean; snapshot?: unknown; pairs?: unknown };
      const rawSnap =
        data && typeof data === 'object' && 'snapshot' in data && data.snapshot
          ? data.snapshot
          : data;
      if (rawSnap && typeof rawSnap === 'object' && Array.isArray((rawSnap as { pairs?: unknown }).pairs)) {
        setRemoteVpsSnapshot(mapRustEngineSnapshot(rawSnap));
      }
    } catch {
      // Transient VPS snapshot fetch error handled by health pill
    }
  }, [accountMode, isRemoteVpsDaemon]);

  const [binanceWsEpoch, setBinanceWsEpoch] = useState(0);
  const [binanceWsOpenSeq, setBinanceWsOpenSeq] = useState(0);

  // Remote VPS 24/7 Daemon real-time WebSocket (/ws/telemetry) + 5s HTTP fallback while disconnected
  useEffect(() => {
    if (accountMode !== 'Live' || !isRemoteVpsDaemon) {
      setRemoteVpsSnapshot(null);
      return;
    }
    let cancelled = false;
    let ws: WebSocket | null = null;
    let wsConnected = false;
    let reconnectTimer: number | null = null;
    let fallbackTimer: number | null = null;
    let attempt = 0;

    const pollHttpFallback = async () => {
      if (cancelled || wsConnected) return;
      try {
        const resp = await apiFetch('/api/engine/snapshot');
        if (!resp.ok || cancelled) return;
        const data = (await resp.json()) as { ok?: boolean; snapshot?: unknown; pairs?: unknown };
        const rawSnap =
          data && typeof data === 'object' && 'snapshot' in data && data.snapshot
            ? data.snapshot
            : data;
        if (
          !cancelled &&
          rawSnap &&
          typeof rawSnap === 'object' &&
          Array.isArray((rawSnap as { pairs?: unknown }).pairs)
        ) {
          setRemoteVpsSnapshot(mapRustEngineSnapshot(rawSnap));
        }
      } catch {
        // Ignore transient offline error; retry on next fallback tick
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) return;
      const delayMs = Math.min(15_000, Math.round(1500 * Math.pow(1.6, attempt)));
      attempt = Math.min(attempt + 1, 8);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (!cancelled) connectTelemetryWs();
      }, delayMs);
    };

    const connectTelemetryWs = async () => {
      if (cancelled) return;
      try {
        const wsUrl = await buildWebSocketUrlWithTicket('/ws/telemetry', connectionProfile);
        if (cancelled) return;
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          if (cancelled) {
            ws?.close();
            return;
          }
          wsConnected = true;
          attempt = 0;
        };
        ws.onmessage = (event) => {
          if (cancelled) return;
          try {
            const parsed = JSON.parse(String(event.data));
            const rawSnap = parsed?.snapshot ?? parsed;
            if (rawSnap && typeof rawSnap === 'object') {
              setRemoteVpsSnapshot(mapRustEngineSnapshot(rawSnap));
            }
          } catch {
            // Ignore malformed telemetry frame
          }
        };
        ws.onerror = () => {
          wsConnected = false;
        };
        ws.onclose = () => {
          wsConnected = false;
          ws = null;
          scheduleReconnect();
        };
      } catch {
        wsConnected = false;
        scheduleReconnect();
      }
    };

    void pollHttpFallback();
    connectTelemetryWs();
    fallbackTimer = window.setInterval(() => {
      if (!wsConnected) {
        void pollHttpFallback();
      }
    }, 5000);

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (fallbackTimer !== null) window.clearInterval(fallbackTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [accountMode, isRemoteVpsDaemon, connectionProfile]);

  // Real-time Binance Screener WebSocket (/ws/screener) & dynamic watchlist rotation sync
  const screenerWsRef = useRef<WebSocket | null>(null);
  const activeSymbolsCsv = useMemo(
    () => config.trading.pairs.map((s) => s.trim().toUpperCase()).filter(Boolean).join(','),
    [config.trading.pairs]
  );

  const applyScreenerToLocalRuntime = useCallback(
    (snap: ScreenerSnapshotPayload, forceImmediate = false) => {
      setScreenerSnapshot(snap);
      if (accountMode === 'Live' && isRemoteVpsDaemon && connectionHealthRef.current?.engineReachable) {
        return;
      }
      const rt = activeRuntimeRef.current;
      if (!rt) return;
      const now = Date.now();
      if (!forceImmediate && now - lastAutoRotateMsRef.current < 15_000 && rt.snapshot.pairs.length > 0) {
        return;
      }
      lastAutoRotateMsRef.current = now;
      const tradableTickers = snap.tickers.filter((t) => t.tradableOnActiveEnv !== false);
      const res = rt.syncWatchlistPairs(tradableTickers, [], now);
      if (res.addedSymbols.length > 0 || res.removedSymbols.length > 0 || forceImmediate) {
        syncSnapshots();
      }
    },
    [accountMode, isRemoteVpsDaemon, activeRuntimeRef, syncSnapshots]
  );

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let wsConnected = false;
    let reconnectTimer: number | null = null;
    let fallbackTimer: number | null = null;
    let attempt = 0;

    const buildQueryString = () => {
      const cfgT = configRef.current.trading;
      const params = new URLSearchParams({
        venue: cfgT.venue,
        environment: snapshot.transport.environment,
        category: screenerCategory,
        rankingSource: cfgT.rankingSource ?? 'auto',
        quoteAsset: cfgT.quoteAsset ?? 'USDT',
        minQuoteVolumeUsdt: String(cfgT.trendingMinQuoteVolumeUsdt ?? 10_000_000),
        onlyTradable: 'true',
        limit: '100',
      });
      return `/ws/screener?${params.toString()}`;
    };

    const pollHttpScreener = async (force = false) => {
      if (cancelled || (wsConnected && !force)) return;
      try {
        const cfgT = configRef.current.trading;
        const params = new URLSearchParams({
          venue: cfgT.venue,
          environment: snapshot.transport.environment,
          category: screenerCategory,
          rankingSource: cfgT.rankingSource ?? 'auto',
          quoteAsset: cfgT.quoteAsset ?? 'USDT',
          minQuoteVolumeUsdt: String(cfgT.trendingMinQuoteVolumeUsdt ?? 10_000_000),
          onlyTradable: 'true',
          limit: '100',
        });
        const resp = await apiFetch(`/api/market/screener?${params.toString()}`);
        if (!resp.ok || cancelled) return;
        const data = (await resp.json()) as ScreenerSnapshotPayload & { ok?: boolean };
        if (Array.isArray(data.tickers) && !cancelled) {
          applyScreenerToLocalRuntime(data, force);
        }
      } catch {
        // Ignore transient screener poll error
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) return;
      const delayMs = Math.min(20_000, Math.round(2000 * Math.pow(1.6, attempt)));
      attempt = Math.min(attempt + 1, 6);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (!cancelled) connectScreenerWs();
      }, delayMs);
    };

    const connectScreenerWs = async () => {
      if (cancelled) return;
      try {
        const wsUrl = await buildWebSocketUrlWithTicket(buildQueryString(), connectionProfile);
        if (cancelled) return;
        ws = new WebSocket(wsUrl);
        screenerWsRef.current = ws;
        ws.onopen = () => {
          if (cancelled) {
            ws?.close();
            return;
          }
          wsConnected = true;
          attempt = 0;
        };
        ws.onmessage = (event) => {
          if (cancelled) return;
          try {
            const msg = JSON.parse(String(event.data)) as {
              type?: string;
              data?: ScreenerSnapshotPayload;
            } & Partial<ScreenerSnapshotPayload>;
            const payload = msg.type === 'screener_snapshot' ? msg.data : (msg as ScreenerSnapshotPayload);
            if (payload && Array.isArray(payload.tickers)) {
              applyScreenerToLocalRuntime(payload, false);
            }
          } catch {
            // Ignore malformed screener packet
          }
        };
        ws.onerror = () => {
          wsConnected = false;
        };
        ws.onclose = () => {
          wsConnected = false;
          if (screenerWsRef.current === ws) {
            screenerWsRef.current = null;
          }
          ws = null;
          scheduleReconnect();
        };
      } catch {
        wsConnected = false;
        scheduleReconnect();
      }
    };

    void pollHttpScreener(true);
    connectScreenerWs();
    fallbackTimer = window.setInterval(() => {
      if (!wsConnected) {
        void pollHttpScreener(false);
      }
    }, 15_000);

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (fallbackTimer !== null) window.clearInterval(fallbackTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      if (screenerWsRef.current === ws) {
        screenerWsRef.current = null;
      }
    };
  }, [connectionProfile, snapshot.transport.environment, screenerCategory, applyScreenerToLocalRuntime]);

  // Update open /ws/screener subscription in-place when venue/filter settings change
  useEffect(() => {
    const ws = screenerWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(
        JSON.stringify({
          venue: config.trading.venue,
          environment: snapshot.transport.environment,
          category: screenerCategory,
          rankingSource: config.trading.rankingSource,
          quoteAsset: config.trading.quoteAsset,
          minQuoteVolumeUsdt: config.trading.trendingMinQuoteVolumeUsdt,
          onlyTradable: true,
          limit: 100,
          activeWatchlist: activeSymbolsCsv ? activeSymbolsCsv.split(',') : [],
        })
      );
    } catch {
      // Ignore send on closing socket
    }
  }, [
    config.trading.venue,
    snapshot.transport.environment,
    screenerCategory,
    config.trading.rankingSource,
    config.trading.quoteAsset,
    config.trading.trendingMinQuoteVolumeUsdt,
    activeSymbolsCsv,
  ]);

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

  const activeWatchlistSymbolsKey = useMemo(
    () =>
      Array.from(
        new Set([...snapshot.pairs.map((p) => p.symbol.toUpperCase()), selectedSymbol.toUpperCase()])
      )
        .filter(Boolean)
        .sort()
        .join(','),
    [snapshot.pairs, selectedSymbol]
  );

  // Live Binance Public WebSocket combined stream (<sym>@kline_<tf> + <sym>@bookTicker) with <23h recycle + REST fallback
  useEffect(() => {
    if (snapshot.transport.feedSource !== 'BinanceLive') {
      subscribedBinanceStreamsRef.current.clear();
      return;
    }
    const rt = activeRuntimeRef.current;
    if (!rt) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let restTimer: number | null = null;
    let recycleTimer: number | null = null;
    const isTestnet = snapshot.transport.environment === 'Testnet';
    const isFutures = config.trading.venue === 'Futures';
    const wsBase = isFutures
      ? isTestnet
        ? 'wss://stream.binancefuture.com/stream'
        : 'wss://fstream.binance.com/stream'
      : isTestnet
        ? 'wss://stream.testnet.binance.vision/stream'
        : 'wss://stream.binance.com:9443/stream';

    const initialSymbols = Array.from(
      new Set([
        ...rt.snapshot.pairs.map((p) => p.symbol.trim().toUpperCase()),
        selectedSymbolRef.current.trim().toUpperCase(),
      ])
    )
      .filter(Boolean)
      .slice(0, 60);

    const initialStreams: string[] = [];
    for (const sym of initialSymbols) {
      const lower = sym.toLowerCase();
      initialStreams.push(`${lower}@kline_${config.trading.timeframe}`);
      initialStreams.push(`${lower}@bookTicker`);
    }
    const safeInitialStreams =
      initialStreams.length > 0
        ? initialStreams
        : [`btcusdt@kline_${config.trading.timeframe}`, 'btcusdt@bookTicker'];
    const wsUrl = `${wsBase}?streams=${safeInitialStreams.join('/')}`;

    const pollRestFallback = async () => {
      if (!configRef.current.features.restFallback) return;
      const pollSymbols = rt.snapshot.pairs.map((p) => p.symbol).slice(0, 12);
      for (const symbol of pollSymbols) {
        if (cancelled) return;
        try {
          const resp = await apiFetch(
            `/api/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(configRef.current.trading.timeframe)}&venue=${encodeURIComponent(configRef.current.trading.venue)}&environment=${encodeURIComponent(snapshot.transport.environment)}&limit=3`
          );
          if (!resp.ok) continue;
          const payload = (await resp.json()) as {
            ok?: boolean;
            rows?: Array<Array<string | number>>;
          };
          const rows = Array.isArray(payload.rows) ? payload.rows : [];
          if (rows.length === 0) continue;

          const lastRow = rows[rows.length - 1];
          const prevRow = rows.length >= 2 ? rows[rows.length - 2] : undefined;
          const nowTs = Date.now();
          const lastCloseTime = Number(lastRow[6] ?? 0);
          const lastIsClosed = Number.isFinite(lastCloseTime) && lastCloseTime > 0 ? lastCloseTime <= nowTs : false;

          if (prevRow && !lastIsClosed) {
            const pairState = rt.snapshot.pairs.find((p) => p.symbol === symbol);
            const lastClosedCandle = [...(pairState?.candles ?? [])].reverse().find((c) => c.isClosed);
            const prevOpenTime = Number(prevRow[0]);
            if (!lastClosedCandle || prevOpenTime > lastClosedCandle.openTimeMs) {
              const confirmedCandle: Candle = {
                openTimeMs: prevOpenTime,
                open: Number(prevRow[1]),
                high: Number(prevRow[2]),
                low: Number(prevRow[3]),
                close: Number(prevRow[4]),
                volume: Number(prevRow[5]),
                isClosed: true,
              };
              rt.stepBar(nowTs, { symbol, candle: confirmedCandle });
            }
          }

          const candle: Candle = {
            openTimeMs: Number(lastRow[0]),
            open: Number(lastRow[1]),
            high: Number(lastRow[2]),
            low: Number(lastRow[3]),
            close: Number(lastRow[4]),
            volume: Number(lastRow[5]),
            isClosed: lastIsClosed,
          };
          rt.stepBar(nowTs, { symbol, candle });
          syncSnapshots();
          if (rt.snapshot.accountMode === 'Live') {
            void drainLiveIntents();
          }
        } catch {
          // Network blocked in restricted sandbox -> retain current state gracefully
        }
      }
    };

    if (!config.features.wsPrimaryFeed) {
      if (config.features.restFallback) {
        rt.setTransportMode(
          'RestFallback',
          `WS Primary toggled OFF — polling Binance ${config.trading.venue} REST fallback`
        );
        syncSnapshots();
        void pollRestFallback();
        restTimer = window.setInterval(pollRestFallback, 3000);
      } else {
        rt.setTransportMode(
          'Reconnecting',
          'Both WebSocket Primary and REST Fallback are disabled in Feature Toggles'
        );
        syncSnapshots();
      }
      return () => {
        cancelled = true;
        if (restTimer !== null) window.clearInterval(restTimer);
      };
    }

    try {
      ws = new WebSocket(wsUrl);
      binanceWsRef.current = ws;
      ws.onopen = () => {
        if (!cancelled) {
          subscribedBinanceStreamsRef.current = new Set(safeInitialStreams);
          setBinanceWsOpenSeq((n) => n + 1);
          rt.setTransportMode(
            'WsPrimary',
            `Connected to live Binance ${config.trading.venue} WebSocket stream (kline + bookTicker)`
          );
          syncSnapshots();
        }
      };
      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(event.data as string);
          const payload = msg?.data ?? msg;
          if (!payload || typeof payload !== 'object') return;
          if (payload.k && payload.s) {
            const k = payload.k;
            const candle: Candle = {
              openTimeMs: Number(k.t),
              open: Number(k.o),
              high: Number(k.h),
              low: Number(k.l),
              close: Number(k.c),
              volume: Number(k.v),
              isClosed: Boolean(k.x),
            };
            rt.stepBar(Date.now(), { symbol: payload.s, candle });
            syncSnapshots();
            if (rt.snapshot.accountMode === 'Live') {
              void drainLiveIntents();
            }
          } else if (payload.b && payload.a && payload.s) {
            const sym = String(payload.s).toUpperCase();
            const bestBid = Number(payload.b);
            const bestAsk = Number(payload.a);
            if (bestBid > 0 && bestAsk > 0 && bestAsk >= bestBid) {
              const now = Date.now();
              bookTickerUpdatedAtRef.current[sym] = now;
              rt.updatePairBookTicker(sym, bestBid, bestAsk);
              if (now - lastBookUiSyncRef.current >= 250) {
                lastBookUiSyncRef.current = now;
                if (sym === selectedSymbolRef.current) {
                  setLiveTicker({
                    symbol: sym,
                    bid: bestBid,
                    ask: bestAsk,
                    last: (bestBid + bestAsk) * 0.5,
                  });
                }
                syncSnapshots();
              }
            }
          }
        } catch {
          // Ignore malformed frame
        }
      };
      ws.onerror = () => {
        if (!cancelled && configRef.current.features.restFallback) {
          rt.setTransportMode('RestFallback', 'Binance WS unavailable — switching to REST fallback');
          syncSnapshots();
          if (restTimer === null) {
            restTimer = window.setInterval(pollRestFallback, 3000);
          }
        }
      };
      ws.onclose = () => {
        if (binanceWsRef.current === ws) {
          binanceWsRef.current = null;
        }
        subscribedBinanceStreamsRef.current.clear();
        if (!cancelled && configRef.current.features.restFallback) {
          rt.setTransportMode('RestFallback', 'Binance WS closed — polling REST fallback');
          syncSnapshots();
          if (restTimer === null) {
            restTimer = window.setInterval(pollRestFallback, 3000);
          }
        }
      };
      // Recycle before Binance's 24h connection expiry limit (22.5h)
      recycleTimer = window.setTimeout(() => {
        if (!cancelled) {
          setBinanceWsEpoch((n) => n + 1);
        }
      }, 22.5 * 60 * 60 * 1000);
    } catch {
      if (config.features.restFallback) {
        rt.setTransportMode('RestFallback', 'WebSocket init failed — polling REST fallback');
        syncSnapshots();
        restTimer = window.setInterval(pollRestFallback, 3000);
      }
    }

    return () => {
      cancelled = true;
      if (recycleTimer !== null) window.clearTimeout(recycleTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      if (binanceWsRef.current === ws) {
        binanceWsRef.current = null;
      }
      subscribedBinanceStreamsRef.current.clear();
      if (restTimer !== null) window.clearInterval(restTimer);
    };
  }, [
    accountMode,
    activeRuntimeRef,
    snapshot.transport.feedSource,
    snapshot.transport.environment,
    config.trading.venue,
    config.trading.timeframe,
    config.features.wsPrimaryFeed,
    config.features.restFallback,
    syncSnapshots,
    drainLiveIntents,
    binanceWsEpoch,
  ]);

  // Debounced in-place SUBSCRIBE / UNSUBSCRIBE diffs when watchlist rotates (< 5 msgs/sec Spot, < 10 msgs/sec Futures)
  useEffect(() => {
    if (snapshot.transport.feedSource !== 'BinanceLive') return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const ws = binanceWsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const syms = activeWatchlistSymbolsKey.split(',').filter(Boolean).slice(0, 128);
      const desired = new Set<string>();
      for (const s of syms) {
        const lower = s.toLowerCase();
        desired.add(`${lower}@kline_${config.trading.timeframe}`);
        desired.add(`${lower}@bookTicker`);
      }

      const current = subscribedBinanceStreamsRef.current;
      const toSubscribe: string[] = [];
      const toUnsubscribe: string[] = [];
      for (const stream of desired) {
        if (!current.has(stream) && current.size + toSubscribe.length < 1024) {
          toSubscribe.push(stream);
        }
      }
      for (const stream of current) {
        if (!desired.has(stream)) {
          toUnsubscribe.push(stream);
        }
      }
      if (toSubscribe.length === 0 && toUnsubscribe.length === 0) return;

      const paceMs = config.trading.venue === 'Spot' ? 260 : 140;
      const sendBatches = async () => {
        let reqId = Date.now();
        for (let i = 0; i < toUnsubscribe.length; i += 10) {
          if (cancelled || ws.readyState !== WebSocket.OPEN) return;
          const batch = toUnsubscribe.slice(i, i + 10);
          ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: batch, id: reqId++ }));
          for (const s of batch) current.delete(s);
          await new Promise((r) => window.setTimeout(r, paceMs));
        }
        for (let i = 0; i < toSubscribe.length; i += 10) {
          if (cancelled || ws.readyState !== WebSocket.OPEN) return;
          const batch = toSubscribe.slice(i, i + 10);
          ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: batch, id: reqId++ }));
          for (const s of batch) current.add(s);
          await new Promise((r) => window.setTimeout(r, paceMs));
        }
      };
      void sendBatches();
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    snapshot.transport.feedSource,
    activeWatchlistSymbolsKey,
    config.trading.timeframe,
    config.trading.venue,
    binanceWsOpenSeq,
  ]);

  // Staggered 220-bar historical kline warmup for newly added or cold BinanceLive watchlist pairs
  const warmupCheckKey = useMemo(
    () =>
      snapshot.pairs
        .map((p) => `${p.symbol}:${p.candles.length}:${p.barsWarmedUp ?? 0}`)
        .join('|'),
    [snapshot.pairs]
  );

  useEffect(() => {
    if (snapshot.transport.feedSource !== 'BinanceLive') return;
    if (warmingInProgressRef.current) return;
    const rt = activeRuntimeRef.current;
    if (!rt) return;

    const env = snapshot.transport.environment;
    const venue = config.trading.venue;
    const tf = config.trading.timeframe;
    const pendingWarm = rt.snapshot.pairs.filter((p) => {
      const k = `${accountMode}:${venue}:${env}:${tf}:${p.symbol}`;
      return (
        !warmedKeysRef.current.has(k) &&
        (p.candles.length < 220 || (p.barsWarmedUp ?? 0) < 50)
      );
    });
    if (pendingWarm.length === 0) return;

    let cancelled = false;
    warmingInProgressRef.current = true;
    const runWarmup = async () => {
      try {
        for (const p of pendingWarm) {
          if (cancelled) break;
          const k = `${accountMode}:${venue}:${env}:${tf}:${p.symbol}`;
          try {
            const resp = await apiFetch(
              `/api/market/klines?symbol=${encodeURIComponent(p.symbol)}&interval=${encodeURIComponent(tf)}&venue=${encodeURIComponent(venue)}&environment=${encodeURIComponent(env)}&limit=220`
            );
            if (!resp.ok || cancelled) continue;
            const payload = (await resp.json()) as {
              ok?: boolean;
              rows?: Array<Array<string | number>>;
            };
            const rows = Array.isArray(payload.rows) ? payload.rows : [];
            if (rows.length > 0 && !cancelled) {
              const nowTs = Date.now();
              const candles: Candle[] = rows
                .map((row) => {
                  const closeMs = Number(row[6] ?? 0);
                  return {
                    openTimeMs: Number(row[0]),
                    open: Number(row[1]),
                    high: Number(row[2]),
                    low: Number(row[3]),
                    close: Number(row[4]),
                    volume: Number(row[5]),
                    isClosed: Number.isFinite(closeMs) && closeMs > 0 ? closeMs <= nowTs : true,
                  };
                })
                .filter((c) => Number.isFinite(c.openTimeMs) && c.close > 0);
              if (candles.length > 0) {
                rt.hydrateSymbolCandles(p.symbol, candles);
                warmedKeysRef.current.add(k);
                syncSnapshots();
              }
            }
          } catch {
            // Retry next scan if endpoint temporarily unavailable
          }
          await new Promise((r) => window.setTimeout(r, 180));
        }
      } finally {
        warmingInProgressRef.current = false;
      }
    };
    void runWarmup();

    return () => {
      cancelled = true;
    };
  }, [
    accountMode,
    activeRuntimeRef,
    snapshot.transport.feedSource,
    snapshot.transport.environment,
    config.trading.venue,
    config.trading.timeframe,
    warmupCheckKey,
    syncSnapshots,
  ]);

  // Poll live Binance bookTicker via REST only as fallback when WS @bookTicker hasn't updated selectedSymbol recently
  useEffect(() => {
    if (snapshot.transport.feedSource !== 'BinanceLive') {
      setLiveTicker(null);
      return;
    }
    let cancelled = false;
    const fetchTicker = async () => {
      const lastWsAt = bookTickerUpdatedAtRef.current[selectedSymbol] ?? 0;
      if (Date.now() - lastWsAt < 6000) return;
      try {
        const resp = await apiFetch(
          `/api/market/ticker?symbol=${encodeURIComponent(selectedSymbol)}&venue=${encodeURIComponent(config.trading.venue)}&environment=${encodeURIComponent(snapshot.transport.environment)}`
        );
        if (!resp.ok || cancelled) return;
        const data = (await resp.json()) as {
          ok?: boolean;
          symbol?: string;
          bid?: number | string;
          ask?: number | string;
          price?: number | string;
          bidPrice?: number | string;
          askPrice?: number | string;
          lastPrice?: number | string;
        };
        const lastPx = Number(data.lastPrice ?? data.price ?? 0);
        const bidPx = Number(data.bidPrice ?? data.bid ?? 0);
        const askPx = Number(data.askPrice ?? data.ask ?? 0);
        if (data.ok && lastPx > 0 && !cancelled) {
          setLiveTicker({
            symbol: data.symbol ?? selectedSymbol,
            bid: bidPx > 0 ? bidPx : lastPx,
            ask: askPx > 0 ? askPx : lastPx,
            last: lastPx,
          });
        }
      } catch {
        // Ignore transient ticker poll errors
      }
    };
    void fetchTicker();
    const timer = window.setInterval(fetchTicker, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    snapshot.transport.feedSource,
    snapshot.transport.environment,
    selectedSymbol,
    config.trading.venue,
  ]);

  // Periodically reconcile resting Live pending orders against Binance openOrders
  useEffect(() => {
    if (
      accountMode !== 'Live' ||
      !liveStatus.configured ||
      liveSnapshot.pendingOrders.length === 0
    ) {
      return;
    }
    let cancelled = false;
    const reconcileOpenOrders = async () => {
      const rt = liveRuntimeRef.current;
      if (!rt || cancelled) return;
      try {
        const venues = Array.from(
          new Set(rt.snapshot.pendingOrders.map((o) => o.venue ?? configRef.current.trading.venue))
        );
        const openIdsByVenue = new Map<ExchangeVenue, Set<string>>();
        for (const venue of venues) {
          const resp = await apiFetch(
            `/api/live/open-orders?venue=${encodeURIComponent(venue)}`
          );
          if (!resp.ok || cancelled) continue;
          const data = (await resp.json()) as {
            ok?: boolean;
            orders?: Array<{ orderId?: number | string; symbol?: string }>;
          };
          if (data.ok && Array.isArray(data.orders)) {
            openIdsByVenue.set(
              venue,
              new Set(data.orders.map((o) => String(o.orderId ?? '')))
            );
          }
        }
        if (cancelled) return;
        let changed = false;
        const currentPending = [...rt.snapshot.pendingOrders];
        for (const pending of currentPending) {
          const pendVenue = pending.venue ?? configRef.current.trading.venue;
          const openIds = openIdsByVenue.get(pendVenue);
          if (openIds && pending.exchangeOrderId && !openIds.has(pending.exchangeOrderId)) {
            try {
              const statusResp = await apiFetch(
                `/api/live/order-status?symbol=${encodeURIComponent(pending.symbol)}&orderId=${encodeURIComponent(pending.exchangeOrderId)}&venue=${encodeURIComponent(pendVenue)}`
              );
              if (!statusResp.ok) continue;
              const statusData = (await statusResp.json()) as {
                ok?: boolean;
                status?: string;
                executedQty?: number;
                avgPrice?: number;
              };
              if (!statusData.ok) continue;
              const stUpper = String(statusData.status ?? '').toUpperCase();
              const isTerminal =
                stUpper === 'CANCELED' ||
                stUpper === 'CANCELLED' ||
                stUpper === 'REJECTED' ||
                stUpper === 'EXPIRED' ||
                stUpper === 'EXPIRED_IN_MATCH';
              const filledQty = Number(statusData.executedQty ?? 0) || 0;
              if (stUpper === 'FILLED' || (filledQty > 0 && isTerminal)) {
                rt.promoteExternalLivePendingOrder(
                  pending.id,
                  statusData.avgPrice,
                  filledQty > 0 ? filledQty : undefined,
                  Date.now()
                );
                changed = true;
              } else if (isTerminal) {
                rt.cancelPendingOrder(pending.id);
                changed = true;
              }
            } catch {
              // Ignore transient order-status error; retry next poll
            }
          }
        }
        if (changed) {
          syncSnapshots();
        }
      } catch {
        // Ignore transient reconciliation error
      }
    };
    const timer = window.setInterval(reconcileOpenOrders, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    accountMode,
    liveStatus.configured,
    liveSnapshot.pendingOrders.length,
    config.trading.venue,
    syncSnapshots,
  ]);

  // Persist workspace navigation, account isolation mode, symbol, environment, and paper feed source
  useEffect(() => {
    savePersistedWorkspaceUiState({
      accountMode,
      section,
      botSubTab,
      selectedSymbol,
      environment: snapshot.transport.environment,
      paperFeedSource: paperSnapshot.transport.feedSource,
      paperRunning: paperSnapshot.running,
    });
  }, [
    accountMode,
    section,
    botSubTab,
    selectedSymbol,
    snapshot.transport.environment,
    paperSnapshot.transport.feedSource,
    paperSnapshot.running,
  ]);

  // Mirror newly generated Paper and Live execution fills into persistent backend /api/orders/history
  useEffect(() => {
    const seen = syncedExecIdsRef.current;
    if (!seen) return;
    const inflight = inflightExecIdsRef.current;

    const toOrderLog = (rec: BinanceExecutionRecord): OrderExecutionLog => ({
      id: `client-${rec.accountMode.toLowerCase()}-${rec.id}`,
      orderId: String(rec.orderId),
      clientOrderId: rec.clientOrderId,
      orderListId: rec.orderListId > 0 ? rec.orderListId : undefined,
      symbol: rec.symbol,
      venue: rec.venue,
      environment: rec.environment,
      accountMode: rec.accountMode,
      source: rec.accountMode === 'Live' ? 'live_proxy' : 'paper_engine',
      lifecycle: rec.lifecycle,
      side: rec.side,
      binanceSide: rec.binanceSide,
      orderType: rec.orderType,
      timeInForce: rec.timeInForce,
      status: rec.orderStatus,
      price: rec.price,
      executedQty: rec.executedQty,
      origQty: rec.origQty,
      quoteQty: rec.cummulativeQuoteQty,
      commission: rec.commission,
      commissionAsset: rec.commissionAsset,
      isMaker: rec.isMaker,
      realizedPnlUsdt: rec.realizedPnlUsdt,
      rMultiple: rec.rMultiple,
      exitReason: rec.exitReason,
      latencyMs: rec.accountMode === 'Paper' ? 14 : null,
      endpoint:
        rec.lifecycle === 'CANCEL'
          ? rec.venue === 'Futures'
            ? 'DELETE /fapi/v1/order'
            : 'DELETE /api/v3/order'
          : rec.venue === 'Futures'
            ? 'POST /fapi/v1/order'
            : rec.orderListId !== -1
              ? 'POST /api/v3/orderList/oco'
              : 'POST /api/v3/order',
      rationale: rec.strategyRationale,
      timestampMs: rec.transactTime,
    });

    const newLogs: OrderExecutionLog[] = [];
    const keysToMark: string[] = [];
    for (const rec of paperSnapshot.executionHistory) {
      const key = `Paper:${rec.id}`;
      if (!seen.has(key) && !inflight.has(key)) {
        inflight.add(key);
        keysToMark.push(key);
        newLogs.push(toOrderLog(rec));
      }
    }
    for (const rec of liveSnapshot.executionHistory) {
      const key = `Live:${rec.id}`;
      if (!seen.has(key) && !inflight.has(key)) {
        inflight.add(key);
        keysToMark.push(key);
        newLogs.push(toOrderLog(rec));
      }
    }

    if (notifiedLiveFillIdsRef.current) {
      const missedLiveFills = collectNewLiveFillNotifications(
        liveSnapshot.executionHistory,
        notifiedLiveFillIdsRef.current
      );
      if (missedLiveFills.length > 0) {
        dispatchBrowserLiveFillNotifications(missedLiveFills);
      }
    }

    if (newLogs.length === 0) return;

    void apiFetch('/api/orders/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: newLogs }),
    })
      .then((res) => {
        if (res.ok) {
          for (const key of keysToMark) {
            seen.add(key);
          }
          setOrderLogRefreshKey((k) => k + 1);
        }
      })
      .catch(() => {
        // Ignore transient offline sync failure
      })
      .finally(() => {
        for (const key of keysToMark) {
          inflight.delete(key);
        }
      });
  }, [
    paperSnapshot.executionHistory,
    liveSnapshot.executionHistory,
    dispatchBrowserLiveFillNotifications,
  ]);

  const handleUpdateConfig = (next: BotConfig) => {
    const isSpot = next.trading.venue === 'Spot';
    const normalized: BotConfig = {
      ...next,
      automation: {
        ...next.automation,
        enabled: next.features.automatedTrading,
        directionPolicy: isSpot ? 'long_only' : next.automation.directionPolicy,
        autoFlipOnReversal: isSpot ? false : next.automation.autoFlipOnReversal,
      },
    };
    setConfig(normalized);
    setScreenerCategory(normalized.trading.trendingCategory ?? 'hot_volume');
    savePersistedBotConfig(normalized);
    paperRuntimeRef.current?.updateConfig(normalized);
    liveRuntimeRef.current?.updateConfig(normalized);
    if (
      screenerSnapshotRef.current &&
      !(accountMode === 'Live' && isRemoteVpsDaemon && connectionHealthRef.current?.engineReachable)
    ) {
      const tradable = screenerSnapshotRef.current.tickers.filter(
        (t) => t.tradableOnActiveEnv !== false
      );
      activeRuntimeRef.current?.syncWatchlistPairs(tradable, [], Date.now());
    }
    syncSnapshots();

    if (accountMode === 'Live' && isRemoteVpsDaemon && connectionHealthRef.current?.engineReachable) {
      if (watchlistSyncTimerRef.current !== null) {
        window.clearTimeout(watchlistSyncTimerRef.current);
      }
      watchlistSyncTimerRef.current = window.setTimeout(() => {
        void apiFetch('/api/engine/watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pairSelectionMode: normalized.trading.pairSelectionMode,
            pinnedPairs: normalized.trading.pairs,
            trendingCategory: normalized.trading.trendingCategory,
            quoteAsset: normalized.trading.quoteAsset,
            maxWatchlistPairs: normalized.trading.maxWatchlistPairs,
            trendingTopN: normalized.trading.trendingTopN,
          }),
        }).catch(() => undefined);
      }, 500);
    }

    if (normalized.features.gitAutoBackup) {
      if (gitBackupTimerRef.current !== null) {
        window.clearTimeout(gitBackupTimerRef.current);
      }
      gitBackupTimerRef.current = window.setTimeout(() => {
        void apiFetch('/api/git/backup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commitMessage: `chore(backup): auto-sync ${normalized.trading.venue} config`,
            push: false,
            config: normalized,
          }),
        }).catch(() => undefined);
      }, 1500);
    }
  };

  const handleResetConfigDefaults = () => {
    const defaults = clearPersistedBotConfig();
    setConfig(defaults);
    setScreenerCategory(defaults.trading.trendingCategory ?? 'hot_volume');
    paperRuntimeRef.current?.setVenue(defaults.trading.venue);
    liveRuntimeRef.current?.setVenue(defaults.trading.venue);
    paperRuntimeRef.current?.updateConfig(defaults);
    liveRuntimeRef.current?.updateConfig(defaults);
    syncSnapshots();
  };

  const handleUpdateVenue = (venue: ExchangeVenue) => {
    if (venue === 'Spot' && !config.features.spotMarket) return;
    if (venue === 'Futures' && !config.features.futuresMarket) return;
    const nextDirection =
      venue === 'Spot'
        ? 'long_only'
        : config.automation.directionPolicy === 'long_only'
          ? 'both'
          : config.automation.directionPolicy;
    const nextConfig: BotConfig = {
      ...config,
      trading: { ...config.trading, venue },
      automation: {
        ...config.automation,
        directionPolicy: nextDirection,
        autoFlipOnReversal: venue === 'Spot' ? false : config.automation.autoFlipOnReversal,
      },
    };
    paperRuntimeRef.current?.setVenue(venue);
    liveRuntimeRef.current?.setVenue(venue);
    handleUpdateConfig(nextConfig);
    void apiFetch('/api/live/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ venue }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { status?: LiveCredentialStatus } | null) => {
        if (data?.status) applyLiveStatusToRuntime(data.status);
      })
      .catch(() => undefined);
  };

  const handleUpdateFuturesSettings = (leverage: number, marginType: MarginType) => {
    if (!config.features.futuresMarket) return;
    const safeLeverage = Math.min(20, Math.max(1, leverage));
    const nextConfig: BotConfig = {
      ...config,
      trading: {
        ...config.trading,
        leverage: safeLeverage,
        marginType,
      },
    };
    handleUpdateConfig(nextConfig);
    void apiFetch('/api/live/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leverage: safeLeverage, marginType }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { status?: LiveCredentialStatus } | null) => {
        if (data?.status) applyLiveStatusToRuntime(data.status);
      })
      .catch(() => undefined);
  };

  const handleToggleAutomation = () => {
    // Master toggle lives in Feature Toggles; prevent re-enabling here when toggled OFF.
    if (!config.features.automatedTrading) return;
    const nextEnabled = !config.automation.enabled;
    const next: BotConfig = {
      ...config,
      automation: {
        ...config.automation,
        enabled: nextEnabled,
      },
      features: {
        ...config.features,
        automatedTrading: nextEnabled,
      },
    };
    handleUpdateConfig(next);
  };

  const handleRunAutoScan = () => {
    if (!config.features.automatedTrading || !config.features.signalGenerator) return;
    if (
      (config.trading.venue === 'Spot' && !config.features.spotMarket) ||
      (config.trading.venue === 'Futures' && !config.features.futuresMarket)
    ) {
      return;
    }
    const rt = activeRuntimeRef.current;
    if (!rt) return;
    rt.runAutoScanNow(Date.now());
    syncSnapshots();
    if (accountMode === 'Live') {
      void drainLiveIntents();
    }
  };

  const handleSimulateVolatilitySpike = (symbol: string) => {
    const rt = activeRuntimeRef.current;
    if (!rt) return;
    rt.simulateVolatilitySpike(symbol, Date.now());
    syncSnapshots();
  };

  const handleChangeTimeframe = (tf: Timeframe) => {
    const nextConfig: BotConfig = {
      ...config,
      trading: { ...config.trading, timeframe: tf },
    };
    setConfig(nextConfig);
    savePersistedBotConfig(nextConfig);
    paperRuntimeRef.current?.setTimeframe(tf);
    liveRuntimeRef.current?.setTimeframe(tf);
    paperRuntimeRef.current?.updateConfig(nextConfig);
    liveRuntimeRef.current?.updateConfig(nextConfig);
    syncSnapshots();
  };

  const isControllingVpsBot =
    accountMode === 'Live' &&
    isRemoteVpsDaemon &&
    Boolean(connectionHealth?.engineReachable);

  const vpsBotRunning = connectionHealth?.engineRunning ?? true;

  const displaySnapshot = useMemo(
    () =>
      accountMode === 'Live' && isRemoteVpsDaemon
        ? mergeRemoteVpsSnapshot(snapshot, remoteVpsSnapshot, config.trading.leverage)
        : snapshot,
    [accountMode, isRemoteVpsDaemon, snapshot, remoteVpsSnapshot, config.trading.leverage]
  );

  const handleToggleRunning = () => {
    if (isControllingVpsBot) {
      const nextAction = vpsBotRunning ? 'pause' : 'resume';
      const requestId = `hdr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      void apiFetch('/api/engine/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: nextAction, request_id: requestId }),
      })
        .then(() => refreshConnectionHealth())
        .catch(() => undefined);
      return;
    }
    const rt = activeRuntimeRef.current;
    if (!rt) return;
    if (accountMode === 'Live' && !snapshot.running && (!liveStatus.configured || !liveStatus.armedForLiveOrders)) {
      setSection('bot');
      setBotSubTab('credentials');
      return;
    }
    if (accountMode === 'Live' && !snapshot.running) {
      setLiveStartedThisSession(true);
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
    if (
      source === 'BinanceLive' &&
      !config.features.wsPrimaryFeed &&
      !config.features.restFallback
    ) {
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
    if (accountMode === 'Paper') {
      paperRuntimeRef.current?.setEnvironment(nextEnv);
      syncSnapshots();
      return;
    }
    liveRuntimeRef.current?.setEnvironment(nextEnv);
    syncSnapshots();
    void apiFetch('/api/live/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ environment: nextEnv }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { status?: LiveCredentialStatus } | null) => {
        if (data?.status) {
          applyLiveStatusToRuntime(data.status);
        }
      })
      .catch(() => undefined);
  };

  const handleSubmitOrder = async (
    input: ManualOrderInput
  ): Promise<{ ok: true; warning?: string } | { ok: false; reason: string }> => {
    const rt = activeRuntimeRef.current;
    if (!rt) return { ok: false, reason: 'Engine uninitialized' };

    if (!config.features.manualTrading) {
      return { ok: false, reason: 'Manual Trading is disabled in Feature Toggles.' };
    }
    const venue = config.trading.venue;
    if (venue === 'Spot' && !config.features.spotMarket) {
      return { ok: false, reason: 'Binance Spot market is disabled in Feature Toggles.' };
    }
    if (venue === 'Futures' && !config.features.futuresMarket) {
      return { ok: false, reason: 'Binance USD-M Futures market is disabled in Feature Toggles.' };
    }

    if (accountMode === 'Live') {
      if (venue === 'Spot' && input.side === 'Short' && !input.reduceOnly) {
        return {
          ok: false,
          reason: 'Live Short opening requires USD-M Futures. Switch venue to Futures first.',
        };
      }

      const binanceType =
        input.orderType === 'OCO SELL' ||
        input.orderType === 'OCO BUY' ||
        input.orderType === 'ATR SCALP'
          ? 'OCO'
          : input.orderType === 'LIMIT MAKER'
            ? 'LIMIT_MAKER'
            : input.orderType === 'LIMIT'
              ? 'LIMIT'
              : 'MARKET';

      const pair = rt.snapshot.pairs.find((p) => p.symbol === input.symbol);
      const refPx =
        input.limitPrice && input.limitPrice > 0 ? input.limitPrice : pair?.lastPrice ?? 0;
      const isLong = input.side === 'Long';
      const atrVal = pair?.indicators.atr ?? refPx * 0.01;
      const slDist =
        input.stopLossMode === 'ATR' && config.features.atrDynamicExits
          ? atrVal * config.exits.atrSlMultiplier
          : refPx * (Math.max(0.2, input.stopLossPct) / 100);
      const riskSlPx = refPx > 0 ? (isLong ? refPx - slDist : refPx + slDist) : 0;

      const selectedTarget =
        venue === 'Futures' && input.targets.length > 1
          ? input.targets[input.targets.length - 1]
          : input.targets[0];
      const primaryTpPct = selectedTarget?.pctOffset ?? 2.5;
      const tpPx =
        binanceType === 'OCO' && refPx > 0 && config.features.takeProfitLadder
          ? refPx * (1 + (isLong ? 1 : -1) * (primaryTpPct / 100))
          : undefined;
      const slPx =
        binanceType === 'OCO' && refPx > 0
          ? riskSlPx
          : undefined;

      // When 24/7 Remote VPS Daemon is active, route manual orders (entries, OCOs, and reduceOnly closes) directly to it.
      if (isRemoteVpsDaemon) {
        try {
          const requestId = `ticket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const vpsMethod =
            binanceType === 'OCO'
              ? 'OCO'
              : binanceType === 'LIMIT_MAKER'
                ? 'LIMIT_MAKER'
                : binanceType === 'LIMIT'
                  ? 'LIMIT'
                  : 'MARKET';
          const vpsResp = await apiFetch('/api/engine/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'manual_order',
              symbol: input.symbol,
              side: isLong ? 'Long' : 'Short',
              notional_usdt: input.usdtAmount,
              order_method: vpsMethod,
              limit_price: input.limitPrice,
              take_profit_price: tpPx,
              stop_loss_price: slPx,
              reduce_only: Boolean(input.reduceOnly),
              request_id: requestId,
            }),
          });
          const vpsData = (await vpsResp.json()) as { accepted?: boolean; error?: string };
          if (!vpsResp.ok || vpsData.accepted === false) {
            return {
              ok: false,
              reason: vpsData.error ?? '24/7 VPS Bot rejected manual order',
            };
          }
          await Promise.all([refreshConnectionHealth(), refreshRemoteVpsSnapshot()]);
          return {
            ok: true,
            warning: 'Order dispatched to 24/7 Remote VPS Bot (ATR Break-Even & Trailing Stop managed 24/7 on VPS).',
          };
        } catch (err) {
          return {
            ok: false,
            reason: err instanceof Error ? err.message : 'Unable to reach 24/7 VPS Bot',
          };
        }
      }

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

      if (!input.reduceOnly) {
        const authCheck = rt.authorizeManualEntry(input.symbol, refPx, riskSlPx, Date.now());
        if (!authCheck.ok) {
          return authCheck;
        }
      }

      try {
        const resp = await apiFetch('/api/live/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: input.symbol,
            venue,
            leverage: config.trading.leverage,
            side: isLong ? 'BUY' : 'SELL',
            type: binanceType,
            quoteOrderQty: input.usdtAmount,
            price: input.limitPrice,
            timeInForce: input.timeInForce ?? 'GTC',
            takeProfitPrice: tpPx,
            stopLossPrice: slPx,
            workingType: input.workingType ?? 'MARK_PRICE',
            reduceOnly: input.reduceOnly,
            preflightOnly: false,
          }),
        });
        const data = (await resp.json()) as {
          ok?: boolean;
          error?: string;
          latencyMs?: number;
          orderId?: string;
          orderStatus?: string;
          executedQty?: number;
          avgPrice?: number;
          commission?: number;
          baseCommission?: number;
          commissionAsset?: string;
          ocoOrderListId?: number;
          algoOrderIds?: string[];
          ocoWarning?: string;
          ocoNote?: string;
        };
        if (!resp.ok || !data.ok) {
          return { ok: false, reason: data.error ?? 'Binance live order rejected' };
        }
        const statusUpper = String(data.orderStatus ?? '').toUpperCase();
        const execQtyNum = Number(data.executedQty ?? 0) || 0;
        const isTerminalUnfilled =
          (statusUpper === 'EXPIRED' ||
            statusUpper === 'EXPIRED_IN_MATCH' ||
            statusUpper === 'CANCELED' ||
            statusUpper === 'REJECTED') &&
          execQtyNum <= 0;
        if (isTerminalUnfilled) {
          return {
            ok: false,
            reason: `Binance ${venue} ${binanceType} order ended ${statusUpper} with 0 fill (${data.latencyMs ?? 0}ms).`,
          };
        }
        if (statusUpper === 'NEW' && input.limitPrice) {
          rt.recordExternalLivePendingOrder(
            input,
            input.limitPrice,
            data.orderId,
            `Live ${liveStatus.environment} ${venue} resting ${binanceType} ${input.symbol} @ $${fmtPx(input.limitPrice)} (${data.latencyMs ?? 0}ms)`
          );
        } else if (input.reduceOnly) {
          const existingPos = rt.snapshot.pairs.find((p) => p.symbol === input.symbol)?.openPosition;
          const exitPx = data.avgPrice && data.avgPrice > 0 ? data.avgPrice : refPx;
          if (existingPos) {
            const closeQty = execQtyNum > 0 ? execQtyNum : input.usdtAmount / Math.max(exitPx, 1e-8);
            const ratio =
              existingPos.remainingQuantity > 0
                ? Math.min(1, closeQty / existingPos.remainingQuantity)
                : 1;
            rt.recordExternalLiveExit(
              input.symbol,
              ratio,
              exitPx,
              'ManualClose',
              `Live ${liveStatus.environment} ${venue} Reduce-Only ${binanceType} ${input.symbol} @ $${fmtPx(exitPx)} (${data.latencyMs ?? 0}ms)`,
              Date.now(),
              data.orderId,
              execQtyNum > 0 ? execQtyNum : undefined
            );
          }
        } else {
          rt.recordExternalLiveOrder(
            input,
            `Live ${liveStatus.environment} ${venue} ${binanceType} ${input.side} ${input.symbol} $${input.usdtAmount.toFixed(2)}${data.ocoNote ? ` · ${data.ocoNote}` : ''} (${data.latencyMs ?? 0}ms)`,
            Date.now(),
            {
              executedQty: data.executedQty,
              avgPrice: data.avgPrice,
              commission: data.commission,
              baseCommission: data.baseCommission,
              commissionAsset: data.commissionAsset,
              orderId: data.orderId,
              ocoOrderListId: data.ocoOrderListId,
              algoOrderIds: data.algoOrderIds,
            }
          );
        }
        syncSnapshots();
        return { ok: true, warning: data.ocoWarning };
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

  const dispatchVpsControl = async (payload: Record<string, unknown>) => {
    const requestId = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const resp = await apiFetch('/api/engine/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, request_id: requestId }),
      });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        liveRuntimeRef.current?.reportLiveAutoRejected(
          data.error ?? `24/7 VPS control error (HTTP ${resp.status})`
        );
        syncSnapshots();
      }
      await Promise.all([refreshConnectionHealth(), refreshRemoteVpsSnapshot()]);
    } catch (err) {
      liveRuntimeRef.current?.reportLiveAutoRejected(
        `Unable to reach 24/7 VPS Bot: ${err instanceof Error ? err.message : 'Network error'}`
      );
      syncSnapshots();
    }
  };

  const handleClosePosition = async (symbol: string) => {
    const rt = activeRuntimeRef.current;
    if (!rt) return;
    const venue = config.trading.venue;

    if (accountMode === 'Live' && isRemoteVpsDaemon) {
      await dispatchVpsControl({ action: 'close_position', symbol });
      return;
    }

    if (accountMode === 'Live') {
      const pair = rt.snapshot.pairs.find((p) => p.symbol === symbol);
      const pos = pair?.openPosition;
      if (
        pos &&
        liveStatus.configured &&
        liveStatus.armedForLiveOrders &&
        (pos.side === 'Long' || venue === 'Futures')
      ) {
        if (
          pos.exchangeListId != null ||
          (pos.exchangeAlgoIds && pos.exchangeAlgoIds.length > 0)
        ) {
          try {
            await apiFetch('/api/live/cancel-open-brackets', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                symbol,
                venue,
                orderListId: pos.exchangeListId,
                algoOrderIds: pos.exchangeAlgoIds,
              }),
            });
          } catch {
            // Proceed to close attempt even if bracket cancel fails
          }
        }
        const closeSide = pos.side === 'Long' ? 'SELL' : 'BUY';
        try {
          const resp = await apiFetch('/api/live/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol,
              venue,
              leverage: config.trading.leverage,
              side: closeSide,
              type: 'MARKET',
              quantity: pos.remainingQuantity,
              reduceOnly: true,
              preflightOnly: false,
            }),
          });
          const data = (await resp.json()) as {
            ok?: boolean;
            orderId?: string;
            executedQty?: number;
            avgPrice?: number;
            latencyMs?: number;
            error?: string;
          };
          if (resp.ok && data.ok) {
            const exitPx = data.avgPrice && data.avgPrice > 0 ? data.avgPrice : pair.lastPrice;
            rt.recordExternalLiveExit(
              symbol,
              1,
              exitPx,
              'ManualClose',
              `Live ${venue} ${closeSide} exit ${symbol} @ $${fmtPx(exitPx)} (${data.latencyMs ?? 0}ms)`,
              Date.now(),
              data.orderId,
              data.executedQty
            );
            syncSnapshots();
            return;
          }
          rt.reportLiveAutoRejected(
            `Live close failed (${symbol}): ${data.error ?? `HTTP ${resp.status}`} — position kept open locally.`
          );
          syncSnapshots();
          return;
        } catch (err) {
          rt.reportLiveAutoRejected(
            `Live close error (${symbol}): ${err instanceof Error ? err.message : 'Network error'} — position kept open locally.`
          );
          syncSnapshots();
          return;
        }
      }
      rt.reportLiveAutoRejected(`Live close blocked (${symbol}): verify credentials and arm Live execution first.`);
      syncSnapshots();
      return;
    }

    rt.closePositionBySymbol(symbol, Date.now());
    syncSnapshots();
  };

  const handleFlattenAll = async () => {
    const rt = activeRuntimeRef.current;
    if (!rt) return;
    const venue = config.trading.venue;

    if (accountMode === 'Live' && isRemoteVpsDaemon) {
      await dispatchVpsControl({ action: 'flatten_all' });
      return;
    }

    if (accountMode === 'Live') {
      if (!liveStatus.configured || !liveStatus.armedForLiveOrders) {
        rt.reportLiveAutoRejected('Live Flatten All blocked: credentials not configured or disarmed.');
        syncSnapshots();
        return;
      }
      // 1. Cancel all resting Live pending orders first (promoting any alreadyFilled race so step 2 flattens it too)
      const pendingCopy = [...rt.snapshot.pendingOrders];
      for (const ord of pendingCopy) {
        if (!ord.exchangeOrderId) {
          rt.confirmLivePendingCanceled(ord.id, 'Emergency Flatten All canceled pending order', Date.now());
          continue;
        }
        try {
          const cResp = await apiFetch('/api/live/cancel-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: ord.symbol,
              venue: ord.venue ?? venue,
              orderId: ord.exchangeOrderId,
              side: ord.side === 'Long' ? 'BUY' : 'SELL',
              reason: 'Emergency Flatten All canceled pending order',
            }),
          });
          const cData = (await cResp.json().catch(() => ({}))) as {
            ok?: boolean;
            alreadyFilled?: boolean;
            executedQty?: number;
            avgPrice?: number;
            error?: string;
          };
          if (cResp.ok && cData.ok && cData.alreadyFilled) {
            rt.promoteExternalLivePendingOrder(ord.id, cData.avgPrice, cData.executedQty, Date.now());
          } else if (cResp.ok && cData.ok) {
            rt.confirmLivePendingCanceled(ord.id, 'Emergency Flatten All canceled pending order', Date.now());
          } else {
            rt.reportLiveAutoRejected(
              `Live Flatten pending cancel failed (${ord.symbol}): ${cData.error ?? `HTTP ${cResp.status}`}`
            );
          }
        } catch (err) {
          rt.reportLiveAutoRejected(
            `Live Flatten pending cancel error (${ord.symbol}): ${err instanceof Error ? err.message : 'Network error'}`
          );
        }
      }

      // 2. Cancel brackets and flatten all open positions (including any promoted above)
      const openPairs = rt.snapshot.pairs.filter(
        (p) => p.openPosition && (p.openPosition.side === 'Long' || venue === 'Futures')
      );
      for (const p of openPairs) {
        const pos = p.openPosition!;
        if (
          pos.exchangeListId != null ||
          (pos.exchangeAlgoIds && pos.exchangeAlgoIds.length > 0)
        ) {
          try {
            await apiFetch('/api/live/cancel-open-brackets', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                symbol: p.symbol,
                venue,
                orderListId: pos.exchangeListId,
                algoOrderIds: pos.exchangeAlgoIds,
              }),
            });
          } catch {
            // Continue bracket cleanup
          }
        }
        try {
          const resp = await apiFetch('/api/live/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: p.symbol,
              venue,
              leverage: config.trading.leverage,
              side: pos.side === 'Long' ? 'SELL' : 'BUY',
              type: 'MARKET',
              quantity: pos.remainingQuantity,
              reduceOnly: true,
              preflightOnly: false,
            }),
          });
          const data = (await resp.json()) as {
            ok?: boolean;
            orderId?: string;
            executedQty?: number;
            avgPrice?: number;
            latencyMs?: number;
            error?: string;
          };
          if (resp.ok && data.ok) {
            const exitPx = data.avgPrice && data.avgPrice > 0 ? data.avgPrice : p.lastPrice;
            rt.recordExternalLiveExit(
              p.symbol,
              1,
              exitPx,
              'CircuitBreakerFlatten',
              `Live Flatten ${venue} ${p.symbol} @ $${fmtPx(exitPx)} (${data.latencyMs ?? 0}ms)`,
              Date.now(),
              data.orderId,
              data.executedQty
            );
          } else {
            rt.reportLiveAutoRejected(
              `Live Flatten failed (${p.symbol}): ${data.error ?? `HTTP ${resp.status}`} — position kept open.`
            );
          }
        } catch (err) {
          rt.reportLiveAutoRejected(
            `Live Flatten error (${p.symbol}): ${err instanceof Error ? err.message : 'Network error'}`
          );
        }
      }
      syncSnapshots();
      return;
    }

    rt.flattenAllPositions();
    syncSnapshots();
  };

  const handleCancelPendingOrder = async (orderId: string) => {
    const rt = activeRuntimeRef.current;
    if (!rt) return;
    if (accountMode === 'Live' && isRemoteVpsDaemon) {
      const vpsOrd =
        remoteVpsSnapshot?.pendingOrders.find((o) => o.id === orderId) ??
        rt.snapshot.pendingOrders.find((o) => o.id === orderId);
      if (vpsOrd) {
        await dispatchVpsControl({ action: 'close_position', symbol: vpsOrd.symbol });
      }
      return;
    }
    const ord = rt.snapshot.pendingOrders.find((o) => o.id === orderId);
    if (
      accountMode === 'Live' &&
      ord?.exchangeOrderId &&
      liveStatus.configured &&
      liveStatus.armedForLiveOrders
    ) {
      try {
        const resp = await apiFetch('/api/live/cancel-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: ord.symbol,
            venue: ord.venue ?? config.trading.venue,
            orderId: ord.exchangeOrderId,
            side: ord.side === 'Long' ? 'BUY' : 'SELL',
            reason: 'Manual pending order cancel',
          }),
        });
        const data = (await resp.json().catch(() => ({}))) as {
          ok?: boolean;
          alreadyFilled?: boolean;
          executedQty?: number;
          avgPrice?: number;
          error?: string;
        };
        if (resp.ok && data.ok && data.alreadyFilled) {
          rt.promoteExternalLivePendingOrder(
            orderId,
            data.avgPrice,
            data.executedQty,
            Date.now()
          );
          syncSnapshots();
          return;
        }
        if (!resp.ok || !data.ok) {
          rt.reportLiveAutoRejected(
            `Live cancel failed (${ord.symbol}): ${data.error ?? `HTTP ${resp.status}`} — keeping pending order tracked`
          );
          syncSnapshots();
          return;
        }
      } catch (err) {
        rt.reportLiveAutoRejected(
          `Live cancel error (${ord.symbol}): ${err instanceof Error ? err.message : 'network error'} — keeping pending order tracked`
        );
        syncSnapshots();
        return;
      }
    }
    rt.confirmLivePendingCanceled(orderId, 'Manual pending order cancel', Date.now());
    syncSnapshots();
  };

  const handleTripCB = () => {
    if (!config.features.circuitBreaker) return;
    if (accountMode === 'Live' && isRemoteVpsDaemon) {
      void dispatchVpsControl({
        action: 'trip_cb',
        reason: 'Manual operator circuit breaker activation',
      });
      return;
    }
    activeRuntimeRef.current?.tripCircuitBreaker('Manual operator circuit breaker activation');
    syncSnapshots();
  };

  const handleResetCB = () => {
    if (!config.features.circuitBreaker) return;
    if (accountMode === 'Live' && isRemoteVpsDaemon) {
      void dispatchVpsControl({ action: 'reset_cb' });
      return;
    }
    activeRuntimeRef.current?.resetCircuitBreaker();
    syncSnapshots();
  };

  const handleSimulateLoss = (symbol: string, lossUsdt: number) => {
    if (!config.features.circuitBreaker) return;
    activeRuntimeRef.current?.simulateLossStress(symbol, lossUsdt);
    syncSnapshots();
  };

  const handleSelectPairAndTrade = (symbol: string) => {
    setSelectedSymbol(symbol);
    setSection('trade');
  };

  const handleUpdatePairSelectionMode = (mode: PairSelectionMode) => {
    handleUpdateConfig({
      ...config,
      trading: {
        ...config.trading,
        pairSelectionMode: mode,
      },
    });
  };

  const handleTogglePinPair = (symbol: string) => {
    const clean = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) return;
    const exists = config.trading.pairs.includes(clean);
    const nextPairs = exists
      ? config.trading.pairs.length > 1 || config.trading.pairSelectionMode !== 'static'
        ? config.trading.pairs.filter((s) => s !== clean)
        : config.trading.pairs
      : [...config.trading.pairs, clean];
    handleUpdateConfig({
      ...config,
      trading: {
        ...config.trading,
        pairs: nextPairs,
      },
    });
  };

  const handlePinAndTradeSymbol = (symbol: string) => {
    const clean = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) return;
    const activeAlready = displaySnapshot.pairs.some((p) => p.symbol === clean);
    if (!activeAlready && !config.trading.pairs.includes(clean)) {
      handleUpdateConfig({
        ...config,
        trading: {
          ...config.trading,
          pairs: [...config.trading.pairs, clean],
        },
      });
    }
    setSelectedSymbol(clean);
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

  const handleOpenFeatureToggles = () => {
    setSection('bot');
    setBotSubTab('features');
  };

  const handleSyncLiveTrades = async (
    symbol: string
  ): Promise<{ ok: boolean; added: number; latencyMs?: number; message: string }> => {
    try {
      const resp = await apiFetch(
        `/api/live/trades?symbol=${encodeURIComponent(symbol)}&venue=${encodeURIComponent(config.trading.venue)}&limit=25`
      );
      const data = (await resp.json()) as {
        ok?: boolean;
        configured?: boolean;
        latencyMs?: number;
        endpoint?: string;
        error?: string;
        trades?: BinanceExecutionRecord[];
      };
      if (!data.ok) {
        return {
          ok: false,
          added: 0,
          latencyMs: data.latencyMs,
          message:
            data.error ??
            'Live credentials not configured in server vault — showing local & simulated execution fills.',
        };
      }
      const list = Array.isArray(data.trades) ? data.trades : [];
      const added = activeRuntimeRef.current?.syncExternalLiveTrades(list) ?? 0;
      syncSnapshots();
      return {
        ok: true,
        added,
        latencyMs: data.latencyMs,
        message: `Synced ${list.length} trade(s) (${added} new) from Binance ${config.trading.venue} ${data.endpoint ?? ''} for ${symbol}`,
      };
    } catch (err) {
      return {
        ok: false,
        added: 0,
        message: err instanceof Error ? err.message : 'Unable to reach /api/live/trades',
      };
    }
  };

  // Server-Side Live Credential Vault Actions
  const handleSaveCredentials = async (payload: {
    environment: 'Testnet' | 'Production';
    venue: ExchangeVenue;
    leverage: number;
    marginType: MarginType;
    authMethod: BinanceAuthMethod;
    apiKey: string;
    apiSecret: string;
    recvWindowMs: number;
    maxOrderNotionalUsdt: number;
    requirePreflightTestOrder: boolean;
  }): Promise<{ ok: boolean; message: string }> => {
    try {
      const resp = await apiFetch('/api/live/config', {
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
      // Keep active venue, leverage, marginType, and directionPolicy aligned atomically
      const safeLeverage = Math.min(20, Math.max(1, payload.leverage));
      const nextVenue = payload.venue;
      const nextDirection =
        nextVenue === 'Spot'
          ? 'long_only'
          : config.automation.directionPolicy === 'long_only'
            ? 'both'
            : config.automation.directionPolicy;
      if (nextVenue !== config.trading.venue) {
        paperRuntimeRef.current?.setVenue(nextVenue);
        liveRuntimeRef.current?.setVenue(nextVenue);
      }
      handleUpdateConfig({
        ...config,
        trading: {
          ...config.trading,
          venue: nextVenue,
          leverage: safeLeverage,
          marginType: payload.marginType,
        },
        automation: {
          ...config.automation,
          directionPolicy: nextDirection,
          autoFlipOnReversal: nextVenue === 'Spot' ? false : config.automation.autoFlipOnReversal,
        },
      });
      return {
        ok: true,
        message: `Credentials stored in server vault (${payload.venue} · ${payload.environment} · ${payload.authMethod}).`,
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
      const resp = await apiFetch('/api/live/verify', { method: 'POST' });
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
      const resp = await apiFetch('/api/live/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selectedSymbol,
          venue: config.trading.venue,
          leverage: config.trading.leverage,
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
      const resp = await apiFetch('/api/live/arm', {
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
      const resp = await apiFetch('/api/live/config', { method: 'DELETE' });
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

          {/* Always-Visible Execution Target Pill (This Computer vs Remote VPS) */}
          <button
            type="button"
            onClick={() => {
              setSection('bot');
              setBotSubTab('vps');
            }}
            aria-label="Configure execution server location (This Computer or Remote VPS)"
            className={`hidden items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition sm:flex whitespace-nowrap ${
              connectionProfile.kind === 'remote'
                ? connectionHealth?.reachable === false
                  ? 'border-rose-500/40 bg-rose-950/30 text-rose-200 hover:border-rose-400'
                  : 'border-cyan-400/40 bg-cyan-950/30 text-cyan-200 hover:border-cyan-300'
                : 'border-white/[0.08] bg-[#141820] text-slate-200 hover:border-[#7DF2AD]/40'
            }`}
          >
            {connectionProfile.kind === 'remote' ? (
              <>
                <Cloud className="h-3.5 w-3.5 text-cyan-300" aria-hidden="true" />
                <span>☁️ Remote VPS · {connectionProfile.name}</span>
                {connectionHealth?.latencyMs != null && connectionHealth.reachable && (
                  <span className="font-mono text-[11px] text-cyan-300/80">
                    ({connectionHealth.latencyMs} ms)
                  </span>
                )}
              </>
            ) : (
              <>
                <Laptop className="h-3.5 w-3.5 text-[#7DF2AD]" aria-hidden="true" />
                <span>🖥️ This Computer</span>
              </>
            )}
          </button>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <PWAInstallButton />

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
                displaySnapshot.transport.mode === 'WsPrimary' ? 'bg-[#7DF2AD]' : 'bg-amber-400'
              }`}
              aria-hidden="true"
            />
            {displaySnapshot.transport.mode} · {displaySnapshot.pairs.length || config.trading.pairs.length} Pairs ({config.trading.pairSelectionMode})
          </span>

          <button
            type="button"
            onClick={handleToggleRunning}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition whitespace-nowrap shrink-0 ${
              (isControllingVpsBot ? vpsBotRunning : displaySnapshot.running)
                ? 'border border-white/[0.08] bg-[#141820] text-slate-100 hover:bg-[#1C222D]'
                : accountMode === 'Live'
                  ? 'bg-amber-400 text-[#0B0F17] hover:bg-amber-300'
                  : 'bg-[#7DF2AD] text-[#0B0F17] hover:bg-[#95F7BD]'
            }`}
          >
            {(isControllingVpsBot ? vpsBotRunning : displaySnapshot.running) ? (
              <>
                <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {isControllingVpsBot
                    ? 'Pause VPS Bot'
                    : accountMode === 'Paper'
                      ? 'Pause Paper Sim'
                      : 'Pause Local Bot'}
                </span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {isControllingVpsBot
                    ? 'Resume VPS Bot'
                    : accountMode === 'Paper'
                      ? 'Resume Paper Sim'
                      : liveStartedThisSession
                        ? 'Resume Local Bot'
                        : 'Start Local Bot'}
                </span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Same-Origin Access Token Unlock Bar (when accessing a token-protected server directly in browser) */}
      {connectionProfile.kind === 'local' &&
        connectionHealth?.reachable &&
        connectionHealth.authRequired &&
        !connectionHealth.authOk && (
          <form
            role="region"
            aria-label="Server Access Token Unlock"
            onSubmit={(e) => {
              e.preventDefault();
              const clean = localTokenDraft.trim();
              if (!clean) return;
              setLocalAccessToken(clean);
              setLocalTokenDraft('');
              hydratedServerVaultRef.current = false;
              setOrderLogRefreshKey((k) => k + 1);
              void refreshConnectionHealth();
            }}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-950/35 px-4 py-2 text-xs text-amber-100"
          >
            <span>
              🔐 Access Token required by this server (`APEXRUST_PROXY_TOKEN`). Enter token to unlock API routes for this browser session:
            </span>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={localTokenDraft}
                onChange={(e) => setLocalTokenDraft(e.target.value)}
                placeholder="Paste APEXRUST_PROXY_TOKEN…"
                className="w-60 rounded-md border border-amber-400/35 bg-[#0D1015] px-2.5 py-1 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-300 focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-md bg-amber-400 px-3 py-1 text-xs font-bold text-[#0B0F17] hover:bg-amber-300"
              >
                Unlock
              </button>
            </div>
          </form>
        )}

      {/* Remote VPS Auth / Connection Alert Bar */}
      {connectionProfile.kind === 'remote' &&
        connectionHealth &&
        (!connectionHealth.reachable || !connectionHealth.authOk) && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 border-b border-rose-500/30 bg-rose-950/35 px-4 py-2 text-xs text-rose-100"
          >
            <span>
              {!connectionHealth.authOk && connectionHealth.reachable
                ? `🔑 Remote VPS (${connectionProfile.name}) rejected the Access Token (HTTP 401). Please update or reconnect in VPS & Server Connection.`
                : `☁️ Remote VPS (${connectionProfile.name}) is temporarily unreachable over Cloudflare One. Your 24/7 VPS Bot keeps running and managing positions on the server.`}
            </span>
            <button
              type="button"
              onClick={() => {
                setSection('bot');
                setBotSubTab('vps');
              }}
              className="rounded-md bg-rose-400 px-3 py-1 text-xs font-bold text-[#0B0F17] hover:bg-rose-300"
            >
              Reconnect to VPS
            </button>
          </div>
        )}

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

              <button
                type="button"
                onClick={() => {
                  setSection('bot');
                  setBotSubTab('vps');
                  setMobileMenuOpen(false);
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-cyan-300 hover:bg-white/[0.05]"
              >
                {connectionProfile.kind === 'remote' ? (
                  <Cloud className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Laptop className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span>{serverTargetLabel}</span>
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
              snapshot={displaySnapshot}
              config={config}
              liveStatus={liveStatus}
              liveTicker={liveTicker}
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
              onOpenFeatureToggles={handleOpenFeatureToggles}
              onUpdateVenue={handleUpdateVenue}
              onUpdateFuturesSettings={handleUpdateFuturesSettings}
              onResetCircuitBreaker={handleResetCB}
              onOpenLiveCredentials={handleOpenLiveCredentials}
              serverTargetLabel={serverTargetLabel}
              isRemoteVpsDaemon={isRemoteVpsDaemon}
              onOpenVpsConnection={() => {
                setSection('bot');
                setBotSubTab('vps');
              }}
              onSyncLiveTrades={handleSyncLiveTrades}
            />
          )}

          {section === 'markets' && (
            <MarketsView
              snapshot={displaySnapshot}
              config={config}
              selectedSymbol={selectedSymbol}
              onSelectPairAndTrade={handleSelectPairAndTrade}
              onSimulateTransport={handleSimulateTransport}
              onToggleFeedSource={handleToggleFeedSource}
              screenerSnapshot={screenerSnapshot}
              screenerCategory={screenerCategory}
              onChangeScreenerCategory={setScreenerCategory}
              onUpdatePairSelectionMode={handleUpdatePairSelectionMode}
              onTogglePinPair={handleTogglePinPair}
              onPinAndTradeSymbol={handlePinAndTradeSymbol}
            />
          )}

          {section === 'orders' && (
            <OrderHistoryView
              accountMode={accountMode}
              activeSymbol={selectedSymbol}
              activeVenue={config.trading.venue}
              symbols={Array.from(
                new Set([...config.trading.pairs, ...displaySnapshot.pairs.map((p) => p.symbol)])
              )}
              refreshKey={orderLogRefreshKey}
              serverTargetLabel={serverTargetLabel}
              onSelectPairAndTrade={handleSelectPairAndTrade}
              onAdoptOrphanPair={(sym) => {
                const clean = sym.trim().toUpperCase();
                if (!clean || config.trading.pairs.includes(clean)) return;
                handleUpdateConfig({
                  ...config,
                  trading: {
                    ...config.trading,
                    pairs: [...config.trading.pairs, clean],
                  },
                });
              }}
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
                    aria-selected={botSubTab === 'features'}
                    onClick={() => setBotSubTab('features')}
                    className={`rounded-md px-4 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                      botSubTab === 'features'
                        ? 'bg-[#7DF2AD] text-[#0B0F17]'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    Feature Toggles
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
                  <button
                    type="button"
                    role="tab"
                    aria-selected={botSubTab === 'git'}
                    onClick={() => setBotSubTab('git')}
                    className={`rounded-md px-4 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                      botSubTab === 'git'
                        ? 'bg-[#7DF2AD] text-[#0B0F17]'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    Git Backup
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={botSubTab === 'vps'}
                    onClick={() => setBotSubTab('vps')}
                    className={`rounded-md px-4 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                      botSubTab === 'vps'
                        ? 'bg-cyan-400 text-[#0B0F17]'
                        : 'text-cyan-300 hover:text-cyan-100'
                    }`}
                  >
                    VPS & Server Connection
                  </button>
                </div>

                <span className="font-mono text-xs text-slate-400">
                  Account:{' '}
                  <span className={accountMode === 'Live' ? 'text-amber-300' : 'text-[#7DF2AD]'}>
                    {accountMode}
                  </span>{' '}
                  · Venue:{' '}
                  <span className={config.trading.venue === 'Futures' ? 'text-amber-300' : 'text-slate-200'}>
                    {config.trading.venue}
                  </span>{' '}
                  · Risk:{' '}
                  <span
                    className={
                      displaySnapshot.risk.state === 'Active'
                        ? 'text-[#7DF2AD]'
                        : displaySnapshot.risk.state === 'Cooldown'
                          ? 'text-amber-400'
                          : 'text-rose-400'
                    }
                  >
                    {displaySnapshot.risk.state}
                  </span>
                </span>
              </div>

              {botSubTab === 'strategy' && (
                <StrategyConfigView
                  config={config}
                  snapshot={displaySnapshot}
                  onUpdateConfig={handleUpdateConfig}
                  onToggleAutomation={handleToggleAutomation}
                  onRunAutoScan={handleRunAutoScan}
                  onSimulateVolatilitySpike={handleSimulateVolatilitySpike}
                  onResetDefaults={handleResetConfigDefaults}
                />
              )}

              {botSubTab === 'features' && (
                <FeatureTogglesView
                  config={config}
                  onUpdateConfig={handleUpdateConfig}
                />
              )}

              {botSubTab === 'risk' && (
                <RiskCircuitBreakerView
                  snapshot={displaySnapshot}
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
                  serverTargetLabel={serverTargetLabel}
                  isRemoteVps={connectionProfile.kind === 'remote'}
                  onSaveCredentials={handleSaveCredentials}
                  onVerifyConnection={handleVerifyConnection}
                  onRunPreflightOrder={handleRunPreflightOrder}
                  onToggleArmLive={handleToggleArmLive}
                  onRevokeCredentials={handleRevokeCredentials}
                  onSwitchAccountMode={setAccountMode}
                />
              )}

              {botSubTab === 'git' && (
                <GitBackupView
                  config={config}
                  snapshot={displaySnapshot}
                  serverTargetLabel={serverTargetLabel}
                />
              )}

              {botSubTab === 'vps' && (
                <RemoteEngineView
                  profile={connectionProfile}
                  connectionHealth={connectionHealth}
                  localFeatures={config.features}
                  onChangeProfile={handleChangeConnectionProfile}
                  onRefreshConnectionHealth={refreshConnectionHealth}
                />
              )}
            </div>
          )}

          {section === 'signal' && (
            <SignalsView
              snapshot={displaySnapshot}
              config={config}
              onSelectPairAndTrade={handleSelectPairAndTrade}
            />
          )}

          {section === 'rust' && <RustCodebaseView />}
        </main>
      </div>

      {(liveFillToast || volatilityToast) && (
        <div className="fixed bottom-4 right-4 z-50 flex max-w-md flex-col gap-2.5">
          {liveFillToast && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-xl border border-[#7DF2AD]/50 bg-[#141820]/95 p-4 shadow-2xl backdrop-blur"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-bold uppercase tracking-wider text-[#7DF2AD]">
                      Live Execution Fill
                    </span>
                    <span className="font-mono text-[11px] font-semibold text-slate-200 tabular-nums">
                      #{liveFillToast.orderId}
                    </span>
                    <span className="font-mono text-[11px] font-semibold text-amber-300">
                      {liveFillToast.symbol}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-200 font-mono tabular-nums">
                    {liveFillToast.summary}
                  </p>
                  {typeof window !== 'undefined' &&
                    'Notification' in window &&
                    notifPermission === 'default' &&
                    window.Notification.permission === 'default' && (
                      <button
                        type="button"
                        onClick={() =>
                          void window.Notification.requestPermission().then((res) =>
                            setNotifPermission(res)
                          )
                        }
                        className="mt-2 rounded-md border border-[#7DF2AD]/40 bg-[#0B0F17] px-2.5 py-1 text-[11px] font-medium text-[#7DF2AD] hover:bg-[#7DF2AD]/10"
                      >
                        Enable Desktop Alerts
                      </button>
                    )}
                </div>
                <button
                  type="button"
                  aria-label="Dismiss live execution alert"
                  onClick={() => setLiveFillToast(null)}
                  className="rounded-md p-1 text-slate-400 transition hover:bg-white/[0.08] hover:text-slate-100"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}

          {volatilityToast && (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded-xl border border-amber-400/50 bg-[#141820]/95 p-4 shadow-2xl backdrop-blur"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold uppercase tracking-wider text-amber-300">
                      ATR Volatility Spike Push Alert
                    </span>
                    <span className="font-mono text-[11px] font-semibold text-[#7DF2AD]">
                      {volatilityToast.symbol}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-200">
                    {volatilityToast.message}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Dismiss volatility alert"
                  onClick={() => setVolatilityToast(null)}
                  className="rounded-md p-1 text-slate-400 transition hover:bg-white/[0.08] hover:text-slate-100"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <OfflineIndicator />
    </div>
  );
}
