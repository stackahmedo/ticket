'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import QRCode from 'qrcode';

async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export default function Page() {
  const [token, setToken] = useState('');
  const [userId, setUserId] = useState('');
  const [userRole, setUserRole] = useState('customer');
  const [userEmail, setUserEmail] = useState('');

  const [activeTab, setActiveTab] = useState('events'); // events | orders | notifications | checkin
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState('login'); // login | register

  const [events, setEvents] = useState([]);
  const [currentEvent, setCurrentEvent] = useState(null);
  const [seats, setSeats] = useState([]);
  const [selectedSeats, setSelectedSeats] = useState([]);

  const [hold, setHold] = useState(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [tickets, setTickets] = useState(null);
  const [ticketQRs, setTicketQRs] = useState({});

  const [orders, setOrders] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [checkinToken, setCheckinToken] = useState('');
  const [checkinResult, setCheckinResult] = useState(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Restore session from localStorage on initial render
  useEffect(() => {
    try {
      const savedToken = localStorage.getItem('eticket_token');
      const savedEmail = localStorage.getItem('eticket_email');
      const savedRole = localStorage.getItem('eticket_role');
      const savedId = localStorage.getItem('eticket_id');
      if (savedToken) {
        setToken(savedToken);
        setUserEmail(savedEmail || '');
        setUserRole(savedRole || 'customer');
        setUserId(savedId || '');
      }
    } catch {}
  }, []);

  // Refresh published events
  const refreshEvents = useCallback(async () => {
    try {
      const data = await call('/v1/events');
      setEvents(data);
      if (data.length > 0 && !currentEvent) {
        selectEvent(data[0]);
      }
    } catch (e) {
      setError(e.message);
    }
  }, [currentEvent]);

  useEffect(() => {
    refreshEvents();
  }, [refreshEvents]);

  // Load orders and notifications when user is authenticated
  const loadUserData = useCallback(async () => {
    if (!token) return;
    try {
      const [orderList, notifList] = await Promise.all([
        call('/v1/me/orders', { token }).catch(() => []),
        call('/v1/me/notifications', { token }).catch(() => []),
      ]);
      setOrders(orderList);
      setNotifications(notifList);
    } catch (e) {
      console.error(e);
    }
  }, [token]);

  useEffect(() => {
    loadUserData();
  }, [loadUserData]);

  // Hold timer countdown
  useEffect(() => {
    if (!hold?.expires_at) return;
    const interval = setInterval(() => {
      const diff = Math.max(0, Math.floor((new Date(hold.expires_at) - new Date()) / 1000));
      setSecondsRemaining(diff);
      if (diff === 0) {
        setHold(null);
        setError('Your seat hold has expired. Please select seats again.');
        if (currentEvent) {
          call(`/v1/events/${currentEvent.id}/seats`).then(setSeats).catch(() => {});
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [hold, currentEvent]);

  async function selectEvent(ev) {
    setCurrentEvent(ev);
    setSelectedSeats([]);
    setHold(null);
    setTickets(null);
    try {
      const data = await call(`/v1/events/${ev.id}/seats`);
      setSeats(data);
    } catch (e) {
      setError(e.message);
    }
  }

  async function authenticate(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await call(`/v1/auth/${authMode}`, {
        method: 'POST',
        body: { email, password },
      });
      setToken(data.token);
      setUserEmail(email);
      setUserRole(data.role || 'customer');
      setUserId(data.user_id || '');
      localStorage.setItem('eticket_token', data.token);
      localStorage.setItem('eticket_email', email);
      localStorage.setItem('eticket_role', data.role || 'customer');
      localStorage.setItem('eticket_id', data.user_id || '');
      setPassword('');
      setSuccess(`Welcome back, ${email}!`);
      setTimeout(() => setSuccess(''), 4000);
      loadUserData();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    setToken('');
    setUserEmail('');
    setUserRole('customer');
    setUserId('');
    setHold(null);
    setTickets(null);
    setSelectedSeats([]);
    localStorage.removeItem('eticket_token');
    localStorage.removeItem('eticket_email');
    localStorage.removeItem('eticket_role');
    localStorage.removeItem('eticket_id');
  }

  function toggleSeat(seatId) {
    if (hold || tickets) return;
    setSelectedSeats((prev) =>
      prev.includes(seatId)
        ? prev.filter((id) => id !== seatId)
        : prev.length < 6
        ? [...prev, seatId]
        : prev
    );
  }

  async function reserveSeats() {
    if (!token) {
      setError('Please sign in or create an account to book seats.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const idempotencyKey = crypto.randomUUID();
      const data = await call('/v1/reservations', {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': idempotencyKey },
        body: {
          event_id: currentEvent.id,
          seat_ids: selectedSeats,
        },
      });
      setHold(data);
      const totalSec = Math.max(0, Math.floor((new Date(data.expires_at) - new Date()) / 1000));
      setSecondsRemaining(totalSec);
      setSuccess('Seats held successfully! Complete simulated checkout within 10 minutes.');
      setTimeout(() => setSuccess(''), 4000);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmBooking() {
    setBusy(true);
    setError('');
    try {
      const data = await call(`/v1/reservations/${hold.reservation_id}/confirm`, {
        method: 'POST',
        token,
      });
      setTickets(data);
      setHold(null);
      setSelectedSeats([]);

      // Generate real visual QR codes for each ticket
      const qrs = {};
      for (const t of data.tickets) {
        qrs[t.ticket_id] = await QRCode.toDataURL(t.qr_token, {
          margin: 1,
          width: 240,
          color: { dark: '#040d1a', light: '#ffffff' },
        });
      }
      setTicketQRs(qrs);

      // Refresh seats and user data
      const updatedSeats = await call(`/v1/events/${currentEvent.id}/seats`);
      setSeats(updatedSeats);
      loadUserData();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckin(e) {
    e.preventDefault();
    setBusy(true);
    setCheckinResult(null);
    try {
      const res = await call('/v1/checkins', {
        method: 'POST',
        token,
        body: { qr_token: checkinToken.trim() },
      });
      setCheckinResult({ success: true, message: `Ticket ${res.ticket_id} verified and checked in!` });
      setCheckinToken('');
    } catch (err) {
      setCheckinResult({ success: false, message: err.message });
    } finally {
      setBusy(false);
    }
  }

  const selectedTotal = seats
    .filter((s) => selectedSeats.includes(s.id))
    .reduce((sum, s) => sum + s.price_yen, 0);

  const openCount = seats.filter((s) => s.status === 'available').length;

  return (
    <main className="shell">
      {/* Top Navigation */}
      <header className="nav">
        <a href="#" className="brand">
          <div className="brand-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
              <path d="M13 5v2" /><path d="M13 17v2" /><path d="M13 11v2" />
            </svg>
          </div>
          <div className="logo-text">
            E<span>TICKET</span>
            <small>TOZAITECH</small>
          </div>
        </a>

        <div className="nav-actions">
          <div className="system-pill">
            <span className="pulse-dot" />
            <span>AWS Tokyo • 2-Node Cluster</span>
          </div>
          {token && (
            <button className="btn-secondary" onClick={signOut}>
              Sign Out
            </button>
          )}
        </div>
      </header>

      {/* Hero Section */}
      <section className="hero">
        <div className="hero-badge">TICKETFLOW ENGINE • DISTRIBUTED V1.0</div>
        <h1>
          Events, without<br />
          <em>the wait.</em>
        </h1>
        <p>
          High-performance distributed ticketing built with Go, Apache Kafka, Redis, Neon PostgreSQL, and Next.js.
          Multi-seat atomic holds and zero double-booking guaranteed.
        </p>

        <div className="hero-stats">
          <div className="stat-chip">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
            <span>Row-level Lock Isolation</span>
          </div>
          <div className="stat-chip">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            <span>Simulated Instant Settlement</span>
          </div>
          <div className="stat-chip">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></svg>
            <span>Transactional Kafka Outbox</span>
          </div>
        </div>
      </section>

      {/* View Tabs */}
      <nav className="view-tabs">
        <button
          className={`view-tab ${activeTab === 'events' ? 'active' : ''}`}
          onClick={() => setActiveTab('events')}
        >
          <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
          Events & Booking
        </button>

        {token && (
          <>
            <button
              className={`view-tab ${activeTab === 'orders' ? 'active' : ''}`}
              onClick={() => { setActiveTab('orders'); loadUserData(); }}
            >
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
              My Orders {orders.length > 0 && <span className="badge-count">{orders.length}</span>}
            </button>

            <button
              className={`view-tab ${activeTab === 'notifications' ? 'active' : ''}`}
              onClick={() => { setActiveTab('notifications'); loadUserData(); }}
            >
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
              Notifications {notifications.length > 0 && <span className="badge-count">{notifications.length}</span>}
            </button>

            <button
              className={`view-tab ${activeTab === 'checkin' ? 'active' : ''}`}
              onClick={() => setActiveTab('checkin')}
            >
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/></svg>
              Organizer Scanner
            </button>
          </>
        )}
      </nav>

      {/* Floating Alerts */}
      {error && (
        <div className="alert-box alert-error" role="alert">
          <span>{error}</span>
          <button className="btn-secondary" onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      {success && (
        <div className="alert-box alert-success" role="status">
          <span>{success}</span>
          <button className="btn-secondary" onClick={() => setSuccess('')}>OK</button>
        </div>
      )}

      {/* TAB 1: Events & Booking Grid */}
      {activeTab === 'events' && (
        <div className="main-grid">
          {/* Left Column: Events Discovery & Seat Map */}
          <div>
            <section className="glass-panel" style={{ marginBottom: '24px' }}>
              <div className="panel-header">
                <h2 className="panel-title">Discover Events</h2>
                <button className="btn-secondary" onClick={refreshEvents}>
                  ↻ Refresh
                </button>
              </div>

              {events.map((ev) => (
                <div
                  key={ev.id}
                  className={`event-card ${currentEvent?.id === ev.id ? 'selected' : ''}`}
                  onClick={() => selectEvent(ev)}
                >
                  <div className="event-card-info">
                    <h3>{ev.title}</h3>
                    <div className="event-card-meta">
                      <span>TozaiTech Demo Hall, Tokyo</span>
                      <span>•</span>
                      <span>
                        {new Date(ev.starts_at).toLocaleString('en-US', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </span>
                    </div>
                  </div>
                  <span className="event-select-arrow">→</span>
                </div>
              ))}

              {events.length === 0 && (
                <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
                  No published events found.
                </p>
              )}
            </section>

            {/* Interactive Seating Plan */}
            {currentEvent && (
              <section className="glass-panel">
                <div className="panel-header">
                  <div>
                    <h2 className="panel-title">{currentEvent.title}</h2>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      Select up to 6 seats. Hold reservations expire after 10 minutes.
                    </span>
                  </div>
                  <span className="system-pill">
                    <strong>{openCount}</strong> / {seats.length} OPEN
                  </span>
                </div>

                {/* Curved Stage Graphic */}
                <div className="stage-container">
                  <div className="stage-glow">STAGE / PERFORMANCE AREA</div>
                </div>

                {/* 12-Seat Grid */}
                <div className="seat-grid">
                  {seats.map((s) => {
                    const isSelected = selectedSeats.includes(s.id);
                    const isAvailable = s.status === 'available';
                    return (
                      <button
                        key={s.id}
                        disabled={!isAvailable || !!hold || !!tickets}
                        className={`seat-btn ${isSelected ? 'selected' : ''} ${!isAvailable ? 'unavailable' : ''}`}
                        onClick={() => toggleSeat(s.id)}
                        title={`${s.section} Row ${s.row}-${s.number} • ¥${s.price_yen.toLocaleString()}`}
                      >
                        <span>{s.row}{s.number}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Legend */}
                <div className="seat-legend">
                  <div className="legend-item">
                    <div className="legend-swatch swatch-available" />
                    <span>Available</span>
                  </div>
                  <div className="legend-item">
                    <div className="legend-swatch swatch-selected" />
                    <span>Selected</span>
                  </div>
                  <div className="legend-item">
                    <div className="legend-swatch swatch-taken" />
                    <span>Sold / Reserved</span>
                  </div>
                </div>

                {/* Checkout Bar */}
                <div className="checkout-bar">
                  <div className="checkout-summary">
                    <strong>{selectedSeats.length} Seats Selected</strong>
                    <span className="total-price">¥{selectedTotal.toLocaleString()}</span>
                  </div>

                  {!hold && !tickets && (
                    <button
                      className="btn-primary"
                      disabled={!token || selectedSeats.length === 0 || busy}
                      onClick={reserveSeats}
                    >
                      {busy ? 'Securing hold…' : 'Hold Seats (10 min) →'}
                    </button>
                  )}
                </div>

                {/* Active Hold Countdown & Simulated Checkout */}
                {hold && !tickets && (
                  <div className="hold-timer-box">
                    <div className="hold-timer-header">
                      <span>RESERVATION HOLD ACTIVE</span>
                      <span className="hold-countdown">
                        {String(Math.floor(secondsRemaining / 60)).padStart(2, '0')}:
                        {String(secondsRemaining % 60).padStart(2, '0')}
                      </span>
                    </div>
                    <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      Seats are locked across the cluster. Confirm simulated checkout before time expires.
                    </p>
                    <div className="hold-progress-bar">
                      <div
                        className="hold-progress-fill"
                        style={{ width: `${(secondsRemaining / 600) * 100}%` }}
                      />
                    </div>
                    <div style={{ marginTop: '16px', textAlign: 'right' }}>
                      <button className="btn-primary" disabled={busy} onClick={confirmBooking}>
                        {busy ? 'Processing settlement…' : 'Confirm Simulated Payment (¥' + selectedTotal.toLocaleString() + ') →'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Issued Tickets with Real QR Codes */}
                {tickets && (
                  <div style={{ marginTop: '32px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                      <svg width="24" height="24" fill="none" stroke="var(--emerald)" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
                      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '20px' }}>Booking Confirmed!</h3>
                    </div>
                    <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '20px' }}>
                      Order ID: <code>{tickets.order_id}</code> • Total: ¥{tickets.amount_yen?.toLocaleString()}
                      <br />
                      Save these scannable QR tokens securely; they are only revealed once.
                    </p>

                    <div className="ticket-deck">
                      {tickets.tickets.map((t, idx) => (
                        <div key={t.ticket_id} className="ticket-pass">
                          <div className="ticket-main">
                            <div>
                              <div className="system-pill" style={{ marginBottom: '10px' }}>
                                ADMIT ONE • TICKET #{idx + 1}
                              </div>
                              <div className="ticket-event-name">{currentEvent.title}</div>
                              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                                TozaiTech Demo Hall, Tokyo
                              </div>
                            </div>

                            <div className="ticket-details-grid">
                              <div className="ticket-detail-item">
                                <small>Section</small>
                                <strong>Main Hall</strong>
                              </div>
                              <div className="ticket-detail-item">
                                <small>Seat</small>
                                <strong>Row A</strong>
                              </div>
                              <div className="ticket-detail-item">
                                <small>Status</small>
                                <strong style={{ color: 'var(--emerald-light)' }}>VALID</strong>
                              </div>
                            </div>
                          </div>

                          <div className="ticket-qr-side">
                            {ticketQRs[t.ticket_id] ? (
                              <div className="qr-image-frame">
                                <img src={ticketQRs[t.ticket_id]} alt="Ticket QR Token" />
                              </div>
                            ) : (
                              <div style={{ color: 'var(--text-dim)', fontSize: '12px' }}>Generating QR…</div>
                            )}
                            <div className="ticket-token-snippet" title={t.qr_token}>
                              {t.qr_token}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>

          {/* Right Column: Account & Authentication */}
          <div>
            <section className="glass-panel">
              <div className="panel-header">
                <h2 className="panel-title">My Account</h2>
                <span className="system-pill">
                  {token ? userRole.toUpperCase() : 'GUEST'}
                </span>
              </div>

              {!token ? (
                <form onSubmit={authenticate}>
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
                    <button
                      type="button"
                      className={`btn-secondary ${authMode === 'login' ? 'btn-primary' : ''}`}
                      style={{ flex: 1 }}
                      onClick={() => setAuthMode('login')}
                    >
                      Sign In
                    </button>
                    <button
                      type="button"
                      className={`btn-secondary ${authMode === 'register' ? 'btn-primary' : ''}`}
                      style={{ flex: 1 }}
                      onClick={() => setAuthMode('register')}
                    >
                      Register
                    </button>
                  </div>

                  <div className="form-group">
                    <label>Email Address</label>
                    <input
                      type="email"
                      required
                      className="form-input"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>

                  <div className="form-group">
                    <label>Password (min 12 characters)</label>
                    <input
                      type="password"
                      required
                      minLength={12}
                      className="form-input"
                      placeholder="••••••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>

                  <button className="btn-primary" style={{ width: '100%' }} disabled={busy}>
                    {busy ? 'Authenticating…' : authMode === 'login' ? 'Sign In →' : 'Create Account →'}
                  </button>
                </form>
              ) : (
                <div>
                  <p style={{ fontSize: '14px', marginBottom: '16px' }}>
                    Signed in as: <strong style={{ color: 'var(--emerald-light)' }}>{userEmail}</strong>
                  </p>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '20px' }}>
                    Role: <strong style={{ textTransform: 'capitalize' }}>{userRole}</strong>
                    <br />
                    Session is saved to your browser so you stay logged in.
                  </p>
                  <button className="btn-secondary" style={{ width: '100%' }} onClick={signOut}>
                    Sign Out
                  </button>
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* TAB 2: My Orders */}
      {activeTab === 'orders' && (
        <section className="glass-panel">
          <div className="panel-header">
            <h2 className="panel-title">My Confirmed Orders</h2>
            <button className="btn-secondary" onClick={loadUserData}>↻ Refresh</button>
          </div>

          {orders.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
              No orders placed yet. Choose seats in the events tab to complete a booking.
            </p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td><code>{o.id.slice(0, 13)}…</code></td>
                    <td>{new Date(o.created_at).toLocaleString()}</td>
                    <td><strong style={{ color: 'var(--emerald-light)' }}>¥{o.amount_yen.toLocaleString()}</strong></td>
                    <td><span className="system-pill">{o.status.toUpperCase()}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* TAB 3: Notifications */}
      {activeTab === 'notifications' && (
        <section className="glass-panel">
          <div className="panel-header">
            <h2 className="panel-title">Kafka Event Notifications</h2>
            <button className="btn-secondary" onClick={loadUserData}>↻ Refresh</button>
          </div>

          {notifications.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
              No notifications yet. Notifications are produced to Kafka and written by background workers.
            </p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Event Message</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {notifications.map((n, i) => (
                  <tr key={i}>
                    <td>{n.message}</td>
                    <td style={{ color: 'var(--text-dim)', fontSize: '12px' }}>
                      {new Date(n.created_at).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* TAB 4: Organizer Ticket Scanner */}
      {activeTab === 'checkin' && (
        <section className="glass-panel" style={{ maxWidth: '640px', margin: '0 auto' }}>
          <div className="panel-header">
            <h2 className="panel-title">Organizer Ticket Validation</h2>
            <span className="system-pill">STAFF CHECK-IN</span>
          </div>

          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '20px' }}>
            Paste the 64-character hex token from any attendee's QR pass to validate and burn their ticket.
          </p>

          <form onSubmit={handleCheckin}>
            <div className="form-group">
              <label>64-character Ticket Token</label>
              <input
                type="text"
                required
                className="form-input"
                style={{ fontFamily: 'var(--font-mono)', fontSize: '13px' }}
                placeholder="e.g. 830af4fbae1b0790b4ac1946a13bda746bcd6343743385394d6e68f6e78cc4c5"
                value={checkinToken}
                onChange={(e) => setCheckinToken(e.target.value)}
              />
            </div>
            <button className="btn-primary" style={{ width: '100%' }} disabled={busy || checkinToken.length !== 64}>
              {busy ? 'Verifying with cluster…' : 'Burn & Verify Ticket →'}
            </button>
          </form>

          {checkinResult && (
            <div className={`checkin-result ${checkinResult.success ? 'success' : 'error'}`}>
              <strong>{checkinResult.success ? 'VALID TICKET' : 'ENTRY DENIED'}</strong>
              <p style={{ fontSize: '13px', marginTop: '6px' }}>{checkinResult.message}</p>
            </div>
          )}
        </section>
      )}

      {/* Footer */}
      <footer style={{ marginTop: '60px', paddingTop: '24px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', color: 'var(--text-dim)', fontSize: '13px' }}>
        <div>ETicket — By TozaiTech</div>
        <div>Go API • Apache Kafka KRaft • Redis Cache • Neon PostgreSQL • Next.js</div>
      </footer>
    </main>
  );
}

