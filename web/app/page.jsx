'use client';
import {useCallback,useEffect,useState} from 'react';

async function call(path,{method='GET',token,body,headers={}}={}) {
 const res=await fetch(path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{'Authorization':`Bearer ${token}`} :{}),...headers},body:body?JSON.stringify(body):undefined,cache:'no-store'});
 const data=await res.json().catch(()=>({error:`HTTP ${res.status}`}));
 if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);
 return data;
}
export default function Page(){
 const [token,setToken]=useState('');
 const [email,setEmail]=useState('');const [password,setPassword]=useState('');
 const [events,setEvents]=useState([]);const [current,setCurrent]=useState(null);
 const [seats,setSeats]=useState([]);const [selected,setSelected]=useState([]);
 const [hold,setHold]=useState(null);const [tickets,setTickets]=useState(null);
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 const [mode,setMode]=useState('register');
 const refresh=useCallback(async()=>{try{setEvents(await call('/v1/events'))}catch(e){setError(e.message)}},[]);
 useEffect(()=>{refresh()},[refresh]);
 async function openEvent(event){setCurrent(event);setSelected([]);setHold(null);setTickets(null);try{setSeats(await call(`/v1/events/${event.id}/seats`))}catch(e){setError(e.message)}}
 async function authenticate(e){e.preventDefault();setBusy(true);setError('');try{const d=await call(`/v1/auth/${mode}`,{method:'POST',body:{email,password}});setToken(d.token);setPassword('')}catch(e){setError(e.message)}finally{setBusy(false)}}
 async function reserve(){setBusy(true);setError('');try{const idempotency=crypto.randomUUID();const d=await call('/v1/reservations',{method:'POST',token,headers:{'Idempotency-Key':idempotency},body:{event_id:current.id,seat_ids:selected}});setHold(d)}catch(e){setError(e.message)}finally{setBusy(false)}}
 async function confirm(){setBusy(true);setError('');try{const d=await call(`/v1/reservations/${hold.reservation_id}/confirm`,{method:'POST',token});setTickets(d);setHold(null);setSelected([]);setSeats(await call(`/v1/events/${current.id}/seats`))}catch(e){setError(e.message)}finally{setBusy(false)}}
 const total=seats.filter(s=>selected.includes(s.id)).reduce((n,s)=>n+s.price_yen,0);
 return <main className="shell">
  <header className="nav"><div className="logo">E<span>TICKET</span><small>BY TOZAITECH</small></div><div className="status"><span className="dot"/> AWS Tokyo • Staging MVP</div></header>
  <section className="hero"><div className="eyebrow">TICKETFLOW ENGINE / V0.1</div><h1>Events, without<br/><em>the wait.</em></h1><p>A working event-ticketing demo powered by Go, PostgreSQL, Redis and Apache Kafka. Payments are simulated.</p></section>
  {error&&<div className="error" role="alert">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
  <div className="cols"><section className="panel"><div className="paneltop"><h2>Discover events</h2><button className="minor" onClick={refresh}>Refresh</button></div>{events.map(e=><button key={e.id} className={`event ${current?.id===e.id?'active':''}`} onClick={()=>openEvent(e)}><span className="eventicon">✦</span><span><strong>{e.title}</strong><small>{new Date(e.starts_at).toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short'})}</small></span><span>↗</span></button>)}{events.length===0&&<p className="muted">No events yet. Run the database migrations to load the sample.</p>}</section>
  <section className="panel"><div className="paneltop"><h2>My account</h2><span className="tag">{token?'SIGNED IN':'GUEST'}</span></div>{!token?<form onSubmit={authenticate}><div className="tabs"><button type="button" onClick={()=>setMode('register')} className={mode==='register'?'chosen':''}>Create account</button><button type="button" onClick={()=>setMode('login')} className={mode==='login'?'chosen':''}>Login</button></div><label>Email<input type="email" required placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Password<input type="password" required minLength={12} placeholder="Minimum 12 characters" value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="primary" disabled={busy}>{busy?'Working…':mode==='register'?'Register':'Login'}</button></form>:<div className="signed"><p>Signed in as <strong>{email}</strong></p><button className="minor" onClick={()=>{setToken('');setTickets(null);setHold(null)}}>Sign out</button></div>}<p className="hint">For demo only. Session is held in memory and is lost on refresh; no permanent browser token storage.</p></section></div>
  {current&&<section className="panel booking"><div className="paneltop"><div><div className="eyebrow">RESERVATION ENGINE</div><h2>{current.title}</h2></div><span className="tag">{seats.filter(s=>s.status==='available').length} OPEN</span></div><p className="muted">Choose up to six seats. Sold seats cannot be selected. Reservation holds last ten minutes.</p><div className="stage">STAGE</div><div className="seatgrid">{seats.map(s=><button key={s.id} title={`${s.section} ${s.row}-${s.number} · ¥${s.price_yen}`} disabled={s.status!=='available'||!!hold||!!tickets} className={`seat ${selected.includes(s.id)?'selected':''} ${s.status!=='available'?'unavailable':''}`} onClick={()=>setSelected(old=>old.includes(s.id)?old.filter(x=>x!==s.id):old.length<6?[...old,s.id]:old)}>{s.row}{s.number}</button>)}</div><div className="legend"><span>□ Available</span><span>■ Selected</span><span>× Held / Sold</span></div><div className="checkout"><div><strong>{selected.length} seats selected</strong><small>Total ¥{total.toLocaleString()}</small></div>{!hold&&!tickets&&<button className="primary" disabled={!token||selected.length===0||busy} onClick={reserve}>Hold seats →</button>}{hold&&<div><div className="hold">Reserved until {new Date(hold.expires_at).toLocaleTimeString()}</div><button className="primary" disabled={busy} onClick={confirm}>Confirm mock payment →</button></div>}</div>{!token&&<p className="hint">Create an account or log in to book tickets.</p>}{tickets&&<div className="success"><h3>Booking confirmed</h3><p>Order ID: <code>{tickets.order_id}</code></p><p>Save these one-time QR tokens before leaving this page:</p>{tickets.tickets.map(t=><pre key={t.ticket_id}>{t.qr_token}</pre>)}<p className="hint">Use a QR renderer and authenticated scanner for a real entry workflow. Never use this demo for paid public events.</p></div>}</section>}
  <footer>ETicket — By TozaiTech <span>Prototype • Go / Kafka / Redis / Neon / Next.js</span></footer>
 </main>
}
