import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  Clock3,
  LineChart,
  Radio,
  ScrollText,
  ShieldCheck,
  X,
} from 'lucide-react';

type Tab = 'trade' | 'stats' | 'equity' | 'stream';

type Position = {
  side: 'SELL';
  lots: number;
  entry: number;
  takeProfit: number;
  stopLoss: number;
};

type Trade = {
  side: string;
  lots: number;
  entry: number;
  exit: number;
  result: number;
  closedAt: string;
  reason: string;
};

const pricePath = [4351.07, 4351.13, 4351.04, 4351.19, 4351.11, 4351.22, 4351.16, 4351.08];
const initialPosition: Position = {
  side: 'SELL',
  lots: 0.01,
  entry: 4381.25,
  takeProfit: 4345.25,
  stopLoss: 4384.25,
};

const formatPrice = (value: number) =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatClock = (date: Date) =>
  date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

const formatSignedUsd = (value: number) => `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;

function Metric({
  label,
  value,
  tone = 'gold',
}: {
  label: string;
  value: string;
  tone?: 'gold' | 'positive' | 'neutral';
}) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={`metric-value ${tone}`}>{value}</span>
    </div>
  );
}

function DataPoint({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'green' | 'red';
}) {
  return (
    <div className="data-block">
      <span className="data-label">{label}</span>
      <span className={`data-value ${tone ?? ''}`}>{value}</span>
    </div>
  );
}

function TradeLog({ trade }: { trade: Trade | null }) {
  if (!trade) {
    return (
      <div className="empty-log">
        <ScrollText size={17} strokeWidth={1.4} />
        <p>No trades recorded in this session.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="trade-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Entry</th>
            <th>Exit</th>
            <th>P/L</th>
            <th>Result</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{trade.side} · {trade.lots.toFixed(2)}</td>
            <td>{formatPrice(trade.entry)}</td>
            <td>{formatPrice(trade.exit)}</td>
            <td className={trade.result >= 0 ? 'data-value green' : 'data-value red'}>
              {formatSignedUsd(trade.result)}
            </td>
            <td>{trade.result >= 0 ? 'WIN' : 'LOSS'}</td>
            <td>{trade.reason}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function StatsPanel({ trade }: { trade: Trade | null }) {
  const hasTrade = Boolean(trade);
  return (
    <div className="stat-layout">
      <div className="stat-card">
        <span className="data-label">Session result</span>
        <strong className="stat-number">{hasTrade ? formatSignedUsd(trade?.result ?? 0) : '$0.00'}</strong>
        <span className="stat-caption">{hasTrade ? '1 closed position' : 'No closed positions'}</span>
      </div>
      <div className="stat-card">
        <span className="data-label">Win rate</span>
        <strong className="stat-number">{hasTrade ? '100%' : '—'}</strong>
        <span className="stat-caption">{hasTrade ? '1 win · 0 losses' : 'Awaiting first trade'}</span>
      </div>
    </div>
  );
}

function EquityPanel({ balance, trade }: { balance: number; trade: Trade | null }) {
  const points = trade ? '8,83 68,78 128,81 188,68 248,72 308,57 368,63 428,47 488,51 548,40 608,45 668,27 728,31' : '8,83 68,78 128,81 188,68 248,72 308,57 368,63 428,47 488,51 548,40 608,45 668,36 728,39';
  return (
    <div>
      <svg className="equity-chart" viewBox="0 0 736 130" role="img" aria-label="Simulated equity curve">
        <line x1="0" y1="31" x2="736" y2="31" stroke="#222b38" strokeWidth="1" />
        <line x1="0" y1="64" x2="736" y2="64" stroke="#222b38" strokeWidth="1" />
        <line x1="0" y1="97" x2="736" y2="97" stroke="#222b38" strokeWidth="1" />
        <polyline points={points} fill="none" stroke="#d5b56d" strokeWidth="1.6" />
        <circle cx="728" cy={trade ? 31 : 39} r="3" fill="#6bc69a" />
        <text x="10" y="19" className="chart-label">{formatPrice(balance)}</text>
        <text x="10" y="122" className="chart-label">SESSION START</text>
        <text x="653" y="122" className="chart-label">NOW</text>
      </svg>
    </div>
  );
}

function AiStream() {
  return (
    <div className="stream-list">
      <div className="stream-item">
        <span className="stream-time">17:00:00</span>
        <span className="stream-copy"><em>WAIT</em> · RSI neutral at 42.7 · EMA alignment remains bullish</span>
      </div>
      <div className="stream-item">
        <span className="stream-time">16:54:12</span>
        <span className="stream-copy">Spread check passed · liquidity stable around current quote</span>
      </div>
      <div className="stream-item">
        <span className="stream-time">16:48:37</span>
        <span className="stream-copy">Position monitor active · risk remains within simulation limits</span>
      </div>
    </div>
  );
}

function App() {
  const [priceIndex, setPriceIndex] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const [position, setPosition] = useState<Position | null>(initialPosition);
  const [trade, setTrade] = useState<Trade | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('trade');
  const [balance, setBalance] = useState(10000);

  const price = pricePath[priceIndex % pricePath.length];
  const positionPnl = position
    ? Number(((position.entry - price) * position.lots * 0.6).toFixed(2))
    : 0;

  useEffect(() => {
    const priceTimer = window.setInterval(() => {
      setPriceIndex((current) => current + 1);
      setUpdatedAt(new Date());
    }, 2200);
    const clockTimer = window.setInterval(() => setUpdatedAt(new Date()), 1000);
    return () => {
      window.clearInterval(priceTimer);
      window.clearInterval(clockTimer);
    };
  }, []);

  const tabs = useMemo(
    () => [
      { id: 'trade' as const, label: 'Trade Log', icon: ScrollText },
      { id: 'stats' as const, label: 'Stats', icon: BarChart3 },
      { id: 'equity' as const, label: 'Equity', icon: LineChart },
      { id: 'stream' as const, label: 'AI Stream', icon: Bot },
    ],
    [],
  );

  const closePosition = () => {
    if (!position) return;
    const result = positionPnl;
    setTrade({
      side: position.side,
      lots: position.lots,
      entry: position.entry,
      exit: price,
      result,
      closedAt: formatClock(new Date()),
      reason: 'manual close',
    });
    setBalance((current) => Number((current + result).toFixed(2)));
    setPosition(null);
    setActiveTab('trade');
  };

  return (
    <main className="terminal-app">
      <div className="terminal-frame">
        <header className="topbar">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true" />
            <div>
              <h1 className="brand">XAU/USD AI TRADER</h1>
              <p className="subtitle">running 24/7 · results · google sheets daily</p>
            </div>
          </div>
          <div className="quote-block">
            <span className="quote-price">{formatPrice(price)}</span>
            <span className="quote-caption">gold spot · USD</span>
          </div>
        </header>

        <div className="connection-row">
          <span className="status-dot pulse" aria-hidden="true" />
          <span>Server running · Uptime 458m · Price from simulated · Updated {formatClock(updatedAt)}</span>
        </div>

        <section className="metrics-grid" aria-label="Account overview">
          <Metric label="Balance" value={formatPrice(balance)} />
          <Metric label="Open P/L" value={position ? formatSignedUsd(positionPnl) : '$0.00'} tone="positive" />
          <Metric label="Total trades" value={trade ? '1' : '0'} tone="neutral" />
          <Metric label="Win rate" value={trade ? '100%' : '—'} tone="neutral" />
        </section>

        <section className="decision-card" aria-labelledby="decision-heading">
          <div className="decision-head">
            <span className="section-kicker" id="decision-heading">
              <Activity size={11} />
              Last AI decision
            </span>
            <span className="decision-status">WAIT · 16:24:11</span>
          </div>
          <div className="decision-readout">
            <span><strong>{formatPrice(price)}</strong> @ 17:00 UTC&nbsp; | &nbsp;RSI neutral 42.7&nbsp; · &nbsp;EMA aligned bullish</span>
          </div>
        </section>

        <section className="position-section" aria-labelledby="position-heading">
          <div className="position-head">
            <span className="position-title" id="position-heading">
              {position ? `${position.side} · ${position.lots.toFixed(2)} lots` : 'POSITION MONITOR'}
            </span>
            {position ? (
              <span className="position-badge"><span className="status-dot" aria-hidden="true" />active</span>
            ) : (
              <span className="position-badge">flat</span>
            )}
          </div>
          {position ? (
            <>
              <div className="position-grid">
                <DataPoint label="Entry" value={formatPrice(position.entry)} />
                <DataPoint label="Current" value={formatPrice(price)} />
                <DataPoint label="Take profit" value={formatPrice(position.takeProfit)} tone="green" />
                <DataPoint label="Stop loss" value={formatPrice(position.stopLoss)} tone="red" />
                <DataPoint label="Unrealized" value={formatSignedUsd(positionPnl)} tone="green" />
              </div>
              <button type="button" className="close-button" onClick={closePosition}>
                <X size={11} />
                Close position manually
              </button>
            </>
          ) : (
            <div className="closed-state">
              <strong>No open position.</strong>{trade ? ` Last position closed at ${trade.closedAt}.` : ' The monitor is standing by.'}
            </div>
          )}
        </section>

        <nav className="tabs" aria-label="Trading data views">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              className={`tab ${activeTab === id ? 'active' : ''}`}
              key={id}
              aria-pressed={activeTab === id}
              onClick={() => setActiveTab(id)}
            >
              <Icon size={11} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <section className="tab-panel" key={activeTab}>
          {activeTab === 'trade' && <TradeLog trade={trade} />}
          {activeTab === 'stats' && <StatsPanel trade={trade} />}
          {activeTab === 'equity' && <EquityPanel balance={balance} trade={trade} />}
          {activeTab === 'stream' && <AiStream />}
        </section>

        <aside className="disclaimer">
          <AlertTriangle size={11} />
          <span>Fully simulated. No real money. Prices use XAU/USD spot data. Results logged to Google Sheets daily. This runs on your local server 24/7 with this tab closed.</span>
        </aside>

        <p className="footer-note">
          <Radio size={9} aria-hidden="true" /> local simulation · <Clock3 size={9} aria-hidden="true" /> quote refresh 2.2s · <ShieldCheck size={9} aria-hidden="true" /> risk isolated
        </p>
      </div>
    </main>
  );
}

export default App;
