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

  // Admin Panel State
  const [adminStats, setAdminStats] = useState(null);
  const [adminOrders, setAdminOrders] = useState([]);
  const [adminTickets, setAdminTickets] = useState([]);
  const [adminSubTab, setAdminSubTab] = useState('overview'); // overview | events | orders | tickets | cluster
  const [adminLoading, setAdminLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newEventTitle, setNewEventTitle] = useState('');
  const [newEventPrice, setNewEventPrice] = useState(4500);
  const [newEventDays, setNewEventDays] = useState(14);
  const [newEventSeats, setNewEventSeats] = useState(12);

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

  // Load executive admin data
  const loadAdminData = useCallback(async () => {
    if (!token) return;
    setAdminLoading(true);
    try {
      const [statsData, ordersData, ticketsData] = await Promise.all([
        call('/v1/admin/stats', { token }).catch(() => null),
        call('/v1/admin/orders', { token }).catch(() => []),
        call('/v1/admin/tickets', { token }).catch(() => []),
      ]);
      if (statsData) setAdminStats(statsData);
      setAdminOrders(ordersData || []);
      setAdminTickets(ticketsData || []);
    } catch (e) {
      console.error(e);
    } finally {
      setAdminLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (activeTab === 'admin' && token && (userRole === 'admin' || userRole === 'organizer')) {
      loadAdminData();
    }
  }, [activeTab, token, userRole, loadAdminData]);

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

  async function quickAdminLogin() {
    setBusy(true);
    setError('');
    try {
      const data = await call('/v1/auth/login', {
        method: 'POST',
        body: { email: 'admin@tozaitech.com', password: 'AdminPass1234!' },
      });
      setToken(data.token);
      setUserEmail('admin@tozaitech.com');
      setUserRole(data.role || 'admin');
      setUserId(data.user_id || '');
      localStorage.setItem('eticket_token', data.token);
      localStorage.setItem('eticket_email', 'admin@tozaitech.com');
      localStorage.setItem('eticket_role', data.role || 'admin');
      localStorage.setItem('eticket_id', data.user_id || '');
      setActiveTab('admin');
      setSuccess('Logged in as Administrator (admin@tozaitech.com)!');
      setTimeout(() => setSuccess(''), 4000);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateEvent(e) {
    e.preventDefault();
    if (!newEventTitle.trim()) {
      setError('Event title is required');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await call('/v1/admin/events', {
        method: 'POST',
        token,
        body: {
          title: newEventTitle.trim(),
          price_yen: Number(newEventPrice),
          days_ahead: Number(newEventDays),
          seat_count: Number(newEventSeats),
        },
      });
      setSuccess(`Event "${newEventTitle}" successfully published with ${res.seats_created} seats!`);
      setTimeout(() => setSuccess(''), 5000);
      setNewEventTitle('');
      setShowCreateModal(false);
      await refreshEvents();
      await loadAdminData();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
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
          {(userRole === 'admin' || userRole === 'organizer') && (
            <div className="system-pill" style={{ borderColor: 'rgba(99, 102, 241, 0.4)', color: '#a5b4fc', background: 'rgba(99, 102, 241, 0.1)' }}>
              <span>🛡️ Admin Operator</span>
            </div>
          )}
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

        <button
          className={`view-tab ${activeTab === 'admin' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('admin');
            if (token && (userRole === 'admin' || userRole === 'organizer')) {
              loadAdminData();
            }
          }}
          style={activeTab === 'admin' ? { borderColor: 'var(--indigo)' } : {}}
        >
          <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Admin Portal {(userRole === 'admin' || userRole === 'organizer') && <span className="badge-count" style={{ background: 'var(--indigo)' }}>STAFF</span>}
        </button>
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

                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ width: '100%', marginTop: '10px', borderColor: 'rgba(99, 102, 241, 0.4)', color: '#a5b4fc', fontSize: '13px' }}
                    onClick={quickAdminLogin}
                    disabled={busy}
                  >
                    ⚡ Demo Admin Login (admin@tozaitech.com)
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

                  {(userRole === 'admin' || userRole === 'organizer') && (
                    <button
                      className="btn-primary"
                      style={{ width: '100%', marginBottom: '10px', background: 'linear-gradient(135deg, var(--indigo), #8b5cf6)' }}
                      onClick={() => { setActiveTab('admin'); loadAdminData(); }}
                    >
                      🛡️ Open Admin Console
                    </button>
                  )}

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

      {/* TAB 5: Comprehensive Admin Panel */}
      {activeTab === 'admin' && (
        <div>
          {/* If not logged in as admin or organizer, show security login gateway */}
          {!(token && (userRole === 'admin' || userRole === 'organizer')) ? (
            <section className="glass-panel" style={{ maxWidth: '580px', margin: '40px auto', textAlign: 'center', padding: '40px 32px' }}>
              <div style={{ width: '64px', height: '64px', borderRadius: '18px', background: 'linear-gradient(135deg, var(--indigo), var(--emerald))', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', boxShadow: '0 0 30px var(--indigo-glow)' }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.5">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
              </div>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '26px', fontWeight: '800', marginBottom: '8px' }}>
                Administrator Gateway
              </h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '28px' }}>
                Access the distributed cluster KPIs, global customer orders, real-time ticket audits, and live event management.
              </p>

              <button
                className="btn-primary"
                style={{ width: '100%', padding: '14px', fontSize: '15px', background: 'linear-gradient(135deg, var(--indigo), #8b5cf6)', marginBottom: '16px' }}
                onClick={quickAdminLogin}
                disabled={busy}
              >
                {busy ? 'Authenticating…' : '⚡ Sign In as System Administrator (admin@tozaitech.com)'}
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '20px 0', color: 'var(--text-dim)', fontSize: '12px' }}>
                <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }} />
                <span>OR SIGN IN WITH CUSTOM CREDENTIALS</span>
                <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }} />
              </div>

              <form onSubmit={authenticate}>
                <div className="form-group" style={{ textAlign: 'left' }}>
                  <label>Operator Email</label>
                  <input
                    type="email"
                    required
                    className="form-input"
                    placeholder="admin@tozaitech.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="form-group" style={{ textAlign: 'left' }}>
                  <label>Password</label>
                  <input
                    type="password"
                    required
                    className="form-input"
                    placeholder="••••••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <button className="btn-secondary" style={{ width: '100%' }} disabled={busy}>
                  {busy ? 'Verifying…' : 'Authenticate with Credentials →'}
                </button>
              </form>
            </section>
          ) : (
            /* Logged In Administrator View */
            <section className="glass-panel">
              {/* Admin Top Header */}
              <div className="admin-header">
                <div className="admin-title-group">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <h2>Operator Console</h2>
                    <span className="status-tag tag-active">CLUSTER ACTIVE</span>
                  </div>
                  <p>
                    Session: <strong style={{ color: 'var(--text-main)' }}>{userEmail}</strong> • Role: <strong style={{ color: 'var(--emerald-light)', textTransform: 'uppercase' }}>{userRole}</strong> • PostgreSQL + Kafka Dual-Engine
                  </p>
                </div>

                <div className="admin-actions">
                  <button
                    className="btn-primary"
                    onClick={() => setShowCreateModal(!showCreateModal)}
                  >
                    {showCreateModal ? '✕ Close Form' : '+ Create Event'}
                  </button>
                  <button className="btn-secondary" onClick={loadAdminData} disabled={adminLoading}>
                    {adminLoading ? '↻ Refreshing…' : '↻ Refresh'}
                  </button>
                  <button className="btn-secondary" onClick={() => setActiveTab('events')}>
                    Customer View →
                  </button>
                </div>
              </div>

              {/* Collapsible Fast Event Creator */}
              {showCreateModal && (
                <div className="admin-create-box">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h3 style={{ fontSize: '18px', fontWeight: '700' }}>Publish New Live Event</h3>
                    <span className="system-pill">INSTANT PROVISIONING</span>
                  </div>
                  <form onSubmit={handleCreateEvent}>
                    <div className="admin-form-grid">
                      <div className="form-group">
                        <label>Event Title</label>
                        <input
                          type="text"
                          required
                          className="form-input"
                          placeholder="e.g. Tokyo Neon Music Festival 2026"
                          value={newEventTitle}
                          onChange={(e) => setNewEventTitle(e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label>Ticket Price (¥)</label>
                        <input
                          type="number"
                          required
                          min={500}
                          step={100}
                          className="form-input"
                          placeholder="4500"
                          value={newEventPrice}
                          onChange={(e) => setNewEventPrice(e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label>Days Ahead</label>
                        <input
                          type="number"
                          required
                          min={1}
                          max={365}
                          className="form-input"
                          placeholder="14"
                          value={newEventDays}
                          onChange={(e) => setNewEventDays(e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label>Seat Capacity</label>
                        <select
                          className="form-input"
                          value={newEventSeats}
                          onChange={(e) => setNewEventSeats(Number(e.target.value))}
                        >
                          <option value={12}>12 Seats (Standard Section A)</option>
                          <option value={24}>24 Seats (Full Hall)</option>
                        </select>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                      <button type="button" className="btn-secondary" onClick={() => setShowCreateModal(false)}>
                        Cancel
                      </button>
                      <button className="btn-primary" disabled={busy}>
                        {busy ? 'Publishing…' : 'Publish Event to Cluster →'}
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* Subnavigation Bar */}
              <div className="admin-subnav">
                <button
                  className={`admin-subnav-btn ${adminSubTab === 'overview' ? 'active' : ''}`}
                  onClick={() => setAdminSubTab('overview')}
                >
                  <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>
                  Overview & Metrics
                </button>
                <button
                  className={`admin-subnav-btn ${adminSubTab === 'events' ? 'active' : ''}`}
                  onClick={() => setAdminSubTab('events')}
                >
                  <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                  Event Catalog ({events.length})
                </button>
                <button
                  className={`admin-subnav-btn ${adminSubTab === 'orders' ? 'active' : ''}`}
                  onClick={() => setAdminSubTab('orders')}
                >
                  <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
                  Global Orders ({adminOrders.length})
                </button>
                <button
                  className={`admin-subnav-btn ${adminSubTab === 'tickets' ? 'active' : ''}`}
                  onClick={() => setAdminSubTab('tickets')}
                >
                  <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/></svg>
                  Issued Tickets ({adminTickets.length})
                </button>
                <button
                  className={`admin-subnav-btn ${adminSubTab === 'cluster' ? 'active' : ''}`}
                  onClick={() => setAdminSubTab('cluster')}
                >
                  <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>
                  Cluster Topology
                </button>
              </div>

              {/* SUBTAB 1: Overview & Metrics */}
              {adminSubTab === 'overview' && (
                <div>
                  <div className="kpi-grid">
                    <div className="kpi-card">
                      <div className="kpi-top">
                        <span className="kpi-label">Total Revenue</span>
                        <div className="kpi-icon emerald">
                          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                        </div>
                      </div>
                      <div className="kpi-val" style={{ color: 'var(--emerald-light)' }}>
                        ¥{(adminStats?.total_revenue_yen || 0).toLocaleString()}
                      </div>
                      <div className="kpi-sub">Confirmed settled orders</div>
                    </div>

                    <div className="kpi-card">
                      <div className="kpi-top">
                        <span className="kpi-label">Total Orders</span>
                        <div className="kpi-icon">
                          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/></svg>
                        </div>
                      </div>
                      <div className="kpi-val">{adminStats?.total_orders || 0}</div>
                      <div className="kpi-sub">Completed transactions</div>
                    </div>

                    <div className="kpi-card">
                      <div className="kpi-top">
                        <span className="kpi-label">Tickets Issued / Used</span>
                        <div className="kpi-icon amber">
                          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/></svg>
                        </div>
                      </div>
                      <div className="kpi-val">
                        {adminStats?.total_tickets || 0} <span style={{ fontSize: '18px', color: 'var(--text-muted)' }}>/ {adminStats?.used_tickets || 0} used</span>
                      </div>
                      <div className="kpi-sub">Admission burn rate: {adminStats?.total_tickets ? Math.round(((adminStats.used_tickets || 0) / adminStats.total_tickets) * 100) : 0}%</div>
                    </div>

                    <div className="kpi-card">
                      <div className="kpi-top">
                        <span className="kpi-label">Active Holds</span>
                        <div className="kpi-icon">
                          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        </div>
                      </div>
                      <div className="kpi-val">{adminStats?.active_reservations || 0}</div>
                      <div className="kpi-sub">In-flight 10m TTL locks</div>
                    </div>

                    <div className="kpi-card">
                      <div className="kpi-top">
                        <span className="kpi-label">Registered Users</span>
                        <div className="kpi-icon emerald">
                          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                        </div>
                      </div>
                      <div className="kpi-val">{adminStats?.total_users || 0}</div>
                      <div className="kpi-sub">Customer & staff accounts</div>
                    </div>

                    <div className="kpi-card">
                      <div className="kpi-top">
                        <span className="kpi-label">Kafka Outbox Sync</span>
                        <div className="kpi-icon rose">
                          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></svg>
                        </div>
                      </div>
                      <div className="kpi-val">{adminStats?.pending_outbox || 0} <span style={{ fontSize: '15px', color: 'var(--text-muted)' }}>pending</span></div>
                      <div className="kpi-sub">Dual-write publisher health: OK</div>
                    </div>
                  </div>

                  {/* Dual Grid: Recent Orders & Recent Tickets */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '20px', marginTop: '20px' }}>
                    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '16px', background: 'rgba(255,255,255,0.02)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <h4 style={{ fontSize: '14px', fontWeight: '700' }}>Recent Customer Orders</h4>
                        <button className="btn-secondary" style={{ fontSize: '11px', padding: '4px 10px' }} onClick={() => setAdminSubTab('orders')}>View All →</button>
                      </div>
                      {adminOrders.length === 0 ? (
                        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No orders recorded yet.</p>
                      ) : (
                        <table className="data-table" style={{ fontSize: '13px' }}>
                          <thead>
                            <tr>
                              <th>Customer</th>
                              <th>Amount</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {adminOrders.slice(0, 5).map((o) => (
                              <tr key={o.id}>
                                <td>{o.customer_email}</td>
                                <td><strong style={{ color: 'var(--emerald-light)' }}>¥{o.amount_yen.toLocaleString()}</strong></td>
                                <td><span className="status-tag tag-valid">{o.status}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>

                    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '16px', background: 'rgba(255,255,255,0.02)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <h4 style={{ fontSize: '14px', fontWeight: '700' }}>Recent Ticket Passes</h4>
                        <button className="btn-secondary" style={{ fontSize: '11px', padding: '4px 10px' }} onClick={() => setAdminSubTab('tickets')}>View All →</button>
                      </div>
                      {adminTickets.length === 0 ? (
                        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No tickets issued yet.</p>
                      ) : (
                        <table className="data-table" style={{ fontSize: '13px' }}>
                          <thead>
                            <tr>
                              <th>Event</th>
                              <th>Seat</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {adminTickets.slice(0, 5).map((t) => (
                              <tr key={t.id}>
                                <td>{t.event_title}</td>
                                <td>{t.section}-{t.row}{t.number}</td>
                                <td>
                                  <span className={`status-tag ${t.status === 'valid' ? 'tag-valid' : 'tag-used'}`}>
                                    {t.status.toUpperCase()}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* SUBTAB 2: Event Catalog */}
              {adminSubTab === 'events' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h3 style={{ fontSize: '16px', fontWeight: '700' }}>All Published Events</h3>
                    <button className="btn-primary" onClick={() => setShowCreateModal(true)}>+ Publish New Event</button>
                  </div>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Starts At</th>
                        <th>Venue</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((ev) => (
                        <tr key={ev.id}>
                          <td><strong>{ev.title}</strong></td>
                          <td>{new Date(ev.starts_at).toLocaleString()}</td>
                          <td>TozaiTech Demo Hall, Tokyo</td>
                          <td><span className="status-tag tag-valid">{ev.status.toUpperCase()}</span></td>
                          <td>
                            <button
                              className="btn-secondary"
                              style={{ fontSize: '12px', padding: '4px 12px' }}
                              onClick={() => { selectEvent(ev); setActiveTab('events'); }}
                            >
                              Open Seating Plan →
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* SUBTAB 3: Global Orders Audit */}
              {adminSubTab === 'orders' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h3 style={{ fontSize: '16px', fontWeight: '700' }}>Global Orders Ledger</h3>
                    <span className="system-pill">Showing latest {adminOrders.length} records</span>
                  </div>
                  {adminOrders.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>No orders found in the database.</p>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Order ID</th>
                          <th>Customer</th>
                          <th>Tickets</th>
                          <th>Amount</th>
                          <th>Status</th>
                          <th>Placed At</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminOrders.map((o) => (
                          <tr key={o.id}>
                            <td><code>{o.id.slice(0, 8)}…{o.id.slice(-4)}</code></td>
                            <td>{o.customer_email}</td>
                            <td>{o.ticket_count} ticket{o.ticket_count === 1 ? '' : 's'}</td>
                            <td><strong style={{ color: 'var(--emerald-light)' }}>¥{o.amount_yen.toLocaleString()}</strong></td>
                            <td><span className="status-tag tag-valid">{o.status.toUpperCase()}</span></td>
                            <td style={{ color: 'var(--text-dim)', fontSize: '13px' }}>{new Date(o.created_at).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* SUBTAB 4: Issued Tickets Audit */}
              {adminSubTab === 'tickets' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <div>
                      <h3 style={{ fontSize: '16px', fontWeight: '700' }}>Master Tickets Audit & Admission Tracking</h3>
                      <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Real-time status for all issued admissions across all events.</p>
                    </div>
                    <span className="system-pill">Showing latest {adminTickets.length} tickets</span>
                  </div>
                  {adminTickets.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>No tickets found in the database.</p>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Ticket ID</th>
                          <th>Event</th>
                          <th>Seat</th>
                          <th>Status</th>
                          <th>Issued At</th>
                          <th>Admission At</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminTickets.map((t) => (
                          <tr key={t.id}>
                            <td><code>{t.id.slice(0, 8)}…{t.id.slice(-4)}</code></td>
                            <td>{t.event_title}</td>
                            <td><strong>{t.section} • Row {t.row} • #{t.number}</strong></td>
                            <td>
                              <span className={`status-tag ${t.status === 'valid' ? 'tag-valid' : 'tag-used'}`}>
                                {t.status.toUpperCase()}
                              </span>
                            </td>
                            <td style={{ color: 'var(--text-dim)', fontSize: '13px' }}>{new Date(t.created_at).toLocaleTimeString()}</td>
                            <td style={{ color: 'var(--text-dim)', fontSize: '13px' }}>
                              {t.used_at ? new Date(t.used_at).toLocaleTimeString() : 'Not Yet Used'}
                            </td>
                            <td>
                              <button
                                className="btn-secondary"
                                style={{ fontSize: '11px', padding: '4px 10px' }}
                                onClick={() => {
                                  setActiveTab('checkin');
                                }}
                              >
                                Go to Scanner →
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* SUBTAB 5: Cluster Topology */}
              {adminSubTab === 'cluster' && (
                <div>
                  <div style={{ marginBottom: '20px' }}>
                    <h3 style={{ fontSize: '18px', fontWeight: '700' }}>Distributed Multi-Node Architecture</h3>
                    <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      AWS ap-northeast-1 (Tokyo) production topology running live.
                    </p>
                  </div>

                  <div className="cluster-grid">
                    {/* Node 1 */}
                    <div className="node-card">
                      <div className="node-header">
                        <div className="node-title">
                          <span className="pulse-dot" />
                          <span>Server 1 (App Node)</span>
                        </div>
                        <span className="status-tag tag-valid">HEALTHY</span>
                      </div>
                      <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        <div>Public IP: <code style={{ color: '#fff' }}>43.207.228.69</code></div>
                        <div>Private IP: <code>172.31.18.194</code></div>
                        <div>Instance: <code>i-0ba4b17c55a0a9166</code></div>
                      </div>
                      <div className="service-badge-list">
                        <span className="service-chip active">Go HTTP API :8080</span>
                        <span className="service-chip active">Next.js Web :3000</span>
                        <span className="service-chip active">Nginx Proxy :80/:8088</span>
                        <span className="service-chip active">Outbox Publisher</span>
                        <span className="service-chip active">Reservation Expiry Worker</span>
                        <span className="service-chip active">Notification Consumer</span>
                      </div>
                    </div>

                    {/* Node 2 */}
                    <div className="node-card">
                      <div className="node-header">
                        <div className="node-title">
                          <span className="pulse-dot" />
                          <span>Server 2 (Infra Node)</span>
                        </div>
                        <span className="status-tag tag-valid">HEALTHY</span>
                      </div>
                      <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        <div>Public IP: <code style={{ color: '#fff' }}>35.78.227.201</code></div>
                        <div>Private IP: <code>172.31.30.95</code></div>
                        <div>Instance: <code>i-07830db7e34f6f542</code></div>
                      </div>
                      <div className="service-badge-list">
                        <span className="service-chip active">Apache Kafka KRaft 3.8.0 :9092</span>
                        <span className="service-chip active">Redis 7.4-Alpine Cache :6379</span>
                        <span className="service-chip">Topic: booking.confirmed</span>
                        <span className="service-chip">Topic: reservation.created</span>
                        <span className="service-chip">Topic: reservation.expired</span>
                        <span className="service-chip">Topic: ticket.checked_in</span>
                      </div>
                    </div>

                    {/* Neon Database */}
                    <div className="node-card">
                      <div className="node-header">
                        <div className="node-title">
                          <span className="pulse-dot" />
                          <span>Neon PostgreSQL</span>
                        </div>
                        <span className="status-tag tag-valid">AUTHORITATIVE</span>
                      </div>
                      <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        <div>Engine: <code>PostgreSQL 16 Serverless</code></div>
                        <div>Isolation: <code>Row-Level FOR UPDATE NOWAIT</code></div>
                        <div>Pattern: <code>Transactional Outbox</code></div>
                      </div>
                      <div className="service-badge-list">
                        <span className="service-chip active">pgcrypto (bcrypt)</span>
                        <span className="service-chip active">Multi-seat atomic holds</span>
                        <span className="service-chip active">Zero double-booking</span>
                        <span className="service-chip active">Schema Migrations V1-V3</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* Footer */}
      <footer style={{ marginTop: '60px', paddingTop: '24px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', color: 'var(--text-dim)', fontSize: '13px' }}>
        <div>ETicket — By TozaiTech</div>
        <div>Go API • Apache Kafka KRaft • Redis Cache • Neon PostgreSQL • Next.js</div>
      </footer>
    </main>
  );
}

