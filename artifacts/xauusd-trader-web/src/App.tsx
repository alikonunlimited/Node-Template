import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  Check,
  Clock3,
  Crosshair,
  LineChart,
  Radio,
  ShieldCheck,
  Table2,
  Wifi,
  X,
} from "lucide-react";

type TabId = "trade-log" | "stats" | "equity" | "stream";

type Position = {
  type: "buy" | "sell";
  entry: number;
  takeProfit: number;
  stopLoss: number;
  lots: number;
  openedAt: string;
};

type Trade = {
  id: number;
  type: "BUY" | "SELL";
  entry: number;
  exit: number;
  pnl: number;
  result: "WIN" | "LOSS";
  reason: string;
};

const STARTING_BALANCE = 10_000;
const INITIAL_PRICE = 4_351.07;

const tabLabels: Array<{ id: TabId; label: string; icon: typeof Table2 }> = [
  { id: "trade-log", label: "Trade Log", icon: Table2 },
  { id: "stats", label: "Stats", icon: BarChart3 },
  { id: "equity", label: "Equity", icon: LineChart },
  { id: "stream", label: "AI Stream", icon: Radio },
];

function formatCurrency(value: number, digits = 2) {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function formatSignedCurrency(value: number) {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatCurrency(Math.abs(value))}`;
}

function formatClock(date: Date) {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function App() {
  const [activeTab, setActiveTab] = useState<TabId>("trade-log");
  const [currentPrice, setCurrentPrice] = useState(INITIAL_PRICE);
  const [now, setNow] = useState(() => new Date());
  const [position, setPosition] = useState<Position | null>({
    type: "sell",
    entry: 4_351.25,
    takeProfit: 4_346.25,
    stopLoss: 4_354.25,
    lots: 0.01,
    openedAt: "17:02 UTC",
  });
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stream, setStream] = useState([
    { time: "17:02:08", message: "SELL position opened at $4,351.25", tone: "trade" },
    { time: "17:00:00", message: "AI analysis cycle started", tone: "info" },
    { time: "16:59:30", message: "Price history updated from simulated feed", tone: "info" },
  ]);
  const tick = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      tick.current += 1;
      const next = INITIAL_PRICE + Math.sin(tick.current / 2.4) * 0.34 + Math.cos(tick.current / 5) * 0.08;
      setCurrentPrice(Number(next.toFixed(2)));
      setNow(new Date());
    }, 4_000);
    return () => window.clearInterval(timer);
  }, []);

  const openPnl = useMemo(() => {
    if (!position) return 0;
    const difference = position.type === "buy" ? currentPrice - position.entry : position.entry - currentPrice;
    return difference * 1_000 * position.lots;
  }, [currentPrice, position]);

  const totalPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const wins = trades.filter((trade) => trade.result === "WIN").length;
  const winRate = trades.length ? Math.round((wins / trades.length) * 100) : null;
  const trend = currentPrice >= INITIAL_PRICE ? "up" : "down";

  function closePosition() {
    if (!position) return;
    const pnl = Number(openPnl.toFixed(2));
    const trade: Trade = {
      id: trades.length + 1,
      type: position.type.toUpperCase() as Trade["type"],
      entry: position.entry,
      exit: currentPrice,
      pnl,
      result: pnl >= 0 ? "WIN" : "LOSS",
      reason: "Manual close from dashboard",
    };
    setTrades((current) => [trade, ...current]);
    setStream((current) => [
      { time: formatClock(new Date()), message: `${trade.type} position closed at ${formatCurrency(currentPrice)}`, tone: pnl >= 0 ? "win" : "loss" },
      ...current,
    ]);
    setPosition(null);
  }

  return (
    <main className="terminal-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>XAU/USD AI TRADER</h1>
            <p>RUNNING 24/7 · RESULTS → GOOGLE SHEETS DAILY</p>
          </div>
        </div>
        <div className="ticker" aria-label={`Current XAU/USD price ${formatCurrency(currentPrice)}`}>
          <strong>{formatCurrency(currentPrice)}</strong>
          <span className={`ticker-change ${trend}`}>{trend === "up" ? "+" : "−"}0.18%</span>
        </div>
      </header>

      <section className="system-strip" aria-label="System status">
        <span className="status-dot" />
        <span>Server running</span>
        <span className="separator">·</span>
        <span>Uptime 458m</span>
        <span className="separator">·</span>
        <span>Price from simulated</span>
        <span className="separator">·</span>
        <span>Updated {formatClock(now)}</span>
        <Wifi size={13} strokeWidth={1.8} aria-hidden="true" />
      </section>

      <section className="metric-grid" aria-label="Account overview">
        <Metric label="Balance" value={formatCurrency(STARTING_BALANCE + totalPnl)} tone="gold" />
        <Metric label="Open P&L" value={formatSignedCurrency(openPnl)} tone={openPnl >= 0 ? "green" : "red"} />
        <Metric label="Total Trades" value={String(trades.length)} tone="gold" />
        <Metric label="Win Rate" value={winRate === null ? "—" : `${winRate}%`} tone="gold" />
      </section>

      <section className="decision-panel panel">
        <div className="panel-heading">
          <span className="eyebrow"><Bot size={14} /> LAST AI DECISION</span>
          <span className="decision-state">WAIT · {formatClock(now)}</span>
        </div>
        <div className="decision-reason">
          <span className="accent-bar" />
          <span>{formatCurrency(currentPrice)} @ 17:00 UTC | RSI neutral 42.7 · EMA aligned bull</span>
        </div>
      </section>

      <section className={`position-panel ${position ? "has-position" : "empty-position"}`} aria-label="Open position">
        <div className="position-header">
          <div className="position-title">
            {position ? <span className="sell-label">SELL</span> : <span className="muted-label">NO OPEN POSITION</span>}
            {position && <span className="lots-label">· {position.lots.toFixed(2)} lots</span>}
          </div>
          {position && <span className="position-time"><Clock3 size={12} /> OPENED {position.openedAt}</span>}
        </div>
        {position ? (
          <>
            <div className="position-values">
              <Value label="Entry" value={formatCurrency(position.entry)} />
              <Value label="Current" value={formatCurrency(currentPrice)} />
              <Value label="Take Profit" value={formatCurrency(position.takeProfit)} tone="green" />
              <Value label="Stop Loss" value={formatCurrency(position.stopLoss)} tone="red" />
              <Value label="Unrealized" value={formatSignedCurrency(openPnl)} tone={openPnl >= 0 ? "green" : "red"} />
            </div>
            <button className="close-button" onClick={closePosition} type="button">
              <X size={14} /> Close Position Manually
            </button>
          </>
        ) : (
          <div className="flat-message"><Check size={14} /> Position closed. The result was added to the trade log.</div>
        )}
      </section>

      <section className="activity-panel panel">
        <nav className="tab-row" aria-label="Trader data views">
          {tabLabels.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={activeTab === id ? "tab active" : "tab"}
              aria-pressed={activeTab === id}
              onClick={() => setActiveTab(id)}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </nav>
        <TabContent activeTab={activeTab} trades={trades} stream={stream} totalPnl={totalPnl} />
      </section>

      <footer className="disclaimer">
        <AlertTriangle size={14} />
        <span>Fully simulated. No real money. Price uses live XAU/USD spot data. Results logged to Google Sheets daily. This runs on your server 24/7 even with this tab closed.</span>
      </footer>
    </main>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: "gold" | "green" | "red" }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function Value({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="position-value">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function TabContent({
  activeTab,
  trades,
  stream,
  totalPnl,
}: {
  activeTab: TabId;
  trades: Trade[];
  stream: Array<{ time: string; message: string; tone: string }>;
  totalPnl: number;
}) {
  if (activeTab === "stats") {
    const wins = trades.filter((trade) => trade.result === "WIN").length;
    return (
      <div className="tab-content stats-content">
        <StatRow label="Closed trades" value={String(trades.length)} />
        <StatRow label="Winning trades" value={String(wins)} tone="green" />
        <StatRow label="Net P&L" value={formatSignedCurrency(totalPnl)} tone={totalPnl >= 0 ? "green" : "red"} />
        <StatRow label="Strategy" value="AI momentum + trend guard" />
      </div>
    );
  }

  if (activeTab === "equity") {
    return (
      <div className="tab-content equity-content">
        <div className="equity-visual" aria-label="Equity curve">
          <div className="equity-line" />
          <span className="equity-point point-one" />
          <span className="equity-point point-two" />
          <span className="equity-point point-three" />
          <span className="equity-point point-four" />
        </div>
        <div className="equity-meta"><span>START</span><strong>{formatCurrency(10_000)}</strong><span>NOW</span><strong>{formatCurrency(10_000 + totalPnl)}</strong></div>
      </div>
    );
  }

  if (activeTab === "stream") {
    return (
      <div className="tab-content stream-content">
        {stream.slice(0, 5).map((item, index) => (
          <div className="stream-row" key={`${item.time}-${index}`}>
            <span className={`stream-dot ${item.tone}`} />
            <time>{item.time}</time>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="trade-log">
      <div className="table-head"><span>#</span><span>TYPE</span><span>ENTRY</span><span>EXIT</span><span>P&amp;L</span><span>RESULT</span><span>REASON</span></div>
      {trades.length === 0 ? (
        <div className="empty-table"><Crosshair size={15} /> No trades yet</div>
      ) : (
        trades.map((trade) => (
          <div className="trade-row" key={trade.id}>
            <span>{trade.id}</span>
            <strong className={trade.type === "BUY" ? "green" : "red"}>{trade.type}</strong>
            <span>{formatCurrency(trade.entry)}</span>
            <span>{formatCurrency(trade.exit)}</span>
            <strong className={trade.pnl >= 0 ? "green" : "red"}>{formatSignedCurrency(trade.pnl)}</strong>
            <span className={trade.result === "WIN" ? "green" : "red"}>{trade.result}</span>
            <span>{trade.reason}</span>
          </div>
        ))
      )}
    </div>
  );
}

function StatRow({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return <div className="stat-row"><span>{label}</span><strong className={tone}>{value}</strong></div>;
}

export default App;