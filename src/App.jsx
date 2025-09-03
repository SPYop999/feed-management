// src/App.jsx
import React, { useEffect, useState } from "react";
import { db } from "./firebase";
import {
  collection,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  query,
  where,
} from "firebase/firestore";

/* App behavior based on your spec:
 - Categories: Shrimp Feed, Fish Feed Growfin, Fish Feed Nutriva
 - Godown page shows counts per category + total, click category to see feeds
 - Truck Management: only Incoming / Outgoing that update Godown
 - Direct Transfer: type source truck number to register its onboard stock (selectable feeds)
      then perform outgoing transfer to destination truck (type number), deduct from source, add to dest
 - Admin: add/edit/delete feeds and assign to categories; password 4312
 - All feeds selectable via <select> everywhere
*/

const CATEGORIES = ["Shrimp Feed", "Fish Feed Growfin", "Fish Feed Nutriva"];
const ADMIN_PASS = "4312";

export default function App() {
  // state for collections
  const [feeds, setFeeds] = useState([]); // feed docs: {id, name, category, price}
  const [godown, setGodown] = useState([]); // godownStock docs: {id, feedId, quantity}
  const [trucks, setTrucks] = useState([]); // truck docs: {id, truckNumber, stock: [{feedId, quantity}], createdAt}
  const [transfers, setTransfers] = useState([]);
  const [logs, setLogs] = useState([]);

  // UI state
  const [page, setPage] = useState("dashboard"); // dashboard | godown | truck | transfer | admin | logs
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminPass, setAdminPass] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  // fetch helpers
  async function fetchAll() {
    try {
      const feedSnap = await getDocs(collection(db, "feeds"));
      setFeeds(feedSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const stockSnap = await getDocs(collection(db, "godownStock"));
      setGodown(stockSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const trucksSnap = await getDocs(collection(db, "trucks"));
      setTrucks(trucksSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const transSnap = await getDocs(collection(db, "directTransfers"));
      setTransfers(transSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const logsSnap = await getDocs(collection(db, "logs"));
      setLogs(logsSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error("Fetch error:", e);
      alert("Error fetching data; check console.");
    }
  }

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line
  }, []);

  // utility: find feed doc
  const findFeed = (feedId) => feeds.find(f => f.id === feedId) || null;

  // ---------- GODOWN helpers ----------
  async function addOrIncreaseGodown(feedId, qty) {
    const existing = godown.find(g => g.feedId === feedId);
    if (existing) {
      await updateDoc(doc(db, "godownStock", existing.id), { quantity: existing.quantity + qty });
    } else {
      await addDoc(collection(db, "godownStock"), { feedId, quantity: qty });
    }
    await fetchAll();
  }

  async function decreaseGodown(feedId, qty) {
    const existing = godown.find(g => g.feedId === feedId);
    if (!existing || existing.quantity < qty) throw new Error("Not enough godown stock");
    await updateDoc(doc(db, "godownStock", existing.id), { quantity: existing.quantity - qty });
    await fetchAll();
  }

  // ---------- FEEDS (ADMIN) ----------
  async function handleAddFeed(feedObj, initialQty = 0) {
    // feedObj: { name, category, price }
    const ref = await addDoc(collection(db, "feeds"), { ...feedObj, createdAt: serverTimestamp() });
    if (initialQty > 0) {
      await addDoc(collection(db, "godownStock"), { feedId: ref.id, quantity: Number(initialQty) });
    }
    await fetchAll();
  }

  async function handleEditFeed(feedId, patch) {
    await updateDoc(doc(db, "feeds", feedId), patch);
    await fetchAll();
  }

  async function handleDeleteFeed(feedId) {
    // remove feed doc and any godownStock references (optional)
    await deleteDoc(doc(db, "feeds", feedId));
    // remove godownStock entries for that feed
    for (const s of godown.filter(g => g.feedId === feedId)) {
      await deleteDoc(doc(db, "godownStock", s.id));
    }
    await fetchAll();
  }

  // ---------- TRUCK MANAGEMENT (Incoming / Outgoing) ----------
  // Incoming: truck arrives with load (type incoming) -> optionally unload to godown (we interpret as increasing godown)
  // Outgoing: truck takes load from godown -> decrease godown
  // In truck management we DO NOT store truck stock for later; truck stock only used in direct transfer step
  async function submitTruckEntry({ truckNumber, type, destinations /*string comma*/, items /*[{feedId, qty}]*/ }) {
    if (!truckNumber || !items?.length) return alert("Truck number and at least one feed required");
    const docData = {
      truckNumber,
      type,
      destinations: destinations ? destinations.split(",").map(s => s.trim()).filter(Boolean) : [],
      items: items.map(i => ({ feedId: i.feedId, quantity: Number(i.quantity) })),
      createdAt: serverTimestamp(),
    };
    await addDoc(collection(db, "trucks"), docData);

    // Update godown
    if (type === "incoming") {
      // incoming: add items into godown
      for (const it of items) await addOrIncreaseGodown(it.feedId, Number(it.quantity));
    } else if (type === "outgoing") {
      // outgoing: deduct from godown
      for (const it of items) {
        try {
          await decreaseGodown(it.feedId, Number(it.quantity));
        } catch (e) {
          alert(`Not enough godown stock for ${findFeed(it.feedId)?.name || "feed"}`);
          // don't rollback existing operations (simple approach) — in production you'd batch / transaction
        }
      }
    }

    // log
    await addDoc(collection(db, "logs"), {
      action: "Truck Entry",
      truckNumber,
      type,
      destinations: docData.destinations,
      items: docData.items,
      timestamp: serverTimestamp(),
    });

    await fetchAll();
    alert("Truck entry saved.");
  }

  // ---------- DIRECT TRANSFER ----------
  // Step 1: Register the source truck's onboard inventory (typed truck number + selectable feeds/qty)
  // This creates/updates a truck doc in `trucks` collection with property stock (we will use a separate collection for trucks used for direct transfer)
  async function registerSourceTruckLoad(truckNumber, items /*[{feedId, quantity}]*/) {
    if (!truckNumber || !items?.length) return alert("truck and items required");
    // find existing truck doc where truckNumber matches (we created truck docs earlier as entries too; but direct-use trucks should be stored in trucks as well)
    // We'll create a new truck doc representing the vehicle's stock for direct transfers:
    const q = query(collection(db, "trucks"), where("truckNumber", "==", truckNumber));
    const snap = await getDocs(q);
    if (!snap.empty) {
      // update first found truck doc's stock (overwrite or merge)
      const docRef = snap.docs[0];
      await updateDoc(doc(db, "trucks", docRef.id), {
        truckNumber,
        stock: items.map(i => ({ feedId: i.feedId, quantity: Number(i.quantity) })),
        updatedAt: serverTimestamp(),
      });
    } else {
      await addDoc(collection(db, "trucks"), {
        truckNumber,
        stock: items.map(i => ({ feedId: i.feedId, quantity: Number(i.quantity) })),
        createdAt: serverTimestamp(),
      });
    }

    await addDoc(collection(db, "logs"), {
      action: "Register Truck Load",
      truckNumber,
      items,
      timestamp: serverTimestamp(),
    });

    await fetchAll();
    alert("Source truck load registered.");
  }

  // Step 2: Transfer out from a source truck to a destination truck (typed dest truck number)
  async function transferFromSourceToDest({ sourceTruckNumber, destTruckNumber, items /*[{feedId, qty}]*/ }) {
    if (!sourceTruckNumber || !destTruckNumber || !items?.length) return alert("fill required fields");

    // find source truck doc
    const qSrc = query(collection(db, "trucks"), where("truckNumber", "==", sourceTruckNumber));
    const snapSrc = await getDocs(qSrc);
    if (snapSrc.empty) return alert("Source truck not found. Register load first.");

    const srcDoc = snapSrc.docs[0];
    const srcData = { id: srcDoc.id, ...srcDoc.data() };
    // ensure stock field exists
    const srcStock = Array.isArray(srcData.stock) ? srcData.stock : [];

    // find or create dest truck doc
    const qDest = query(collection(db, "trucks"), where("truckNumber", "==", destTruckNumber));
    const snapDest = await getDocs(qDest);
    let destDocRef = null;
    let destData = null;
    if (!snapDest.empty) {
      destDocRef = snapDest.docs[0];
      destData = { id: destDocRef.id, ...destDocRef.data() };
    } else {
      // create
      const newRef = await addDoc(collection(db, "trucks"), { truckNumber: destTruckNumber, stock: [], createdAt: serverTimestamp() });
      const newSnap = await getDocs(query(collection(db, "trucks"), where("truckNumber", "==", destTruckNumber)));
      destDocRef = newSnap.docs[0];
      destData = { id: destDocRef.id, ...destDocRef.data() };
    }
    const destStock = Array.isArray(destData.stock) ? destData.stock : [];

    // process each item: deduct from source truck stock, add to dest
    for (const item of items) {
      const sIdx = srcStock.findIndex(s => s.feedId === item.feedId);
      if (sIdx === -1 || srcStock[sIdx].quantity < item.quantity) {
        return alert(`Not enough ${findFeed(item.feedId)?.name || item.feedId} in source truck`);
      }
      srcStock[sIdx].quantity -= item.quantity;

      const dIdx = destStock.findIndex(s => s.feedId === item.feedId);
      if (dIdx >= 0) destStock[dIdx].quantity += item.quantity;
      else destStock.push({ feedId: item.feedId, quantity: item.quantity });
    }

    // save updates
    await updateDoc(doc(db, "trucks", srcData.id), { stock: srcStock, updatedAt: serverTimestamp() });
    await updateDoc(doc(db, "trucks", destData.id), { stock: destStock, updatedAt: serverTimestamp() });

    // log and store transfer doc
    await addDoc(collection(db, "directTransfers"), {
      sourceTruckNumber,
      destTruckNumber,
      items,
      timestamp: serverTimestamp(),
    });
    await addDoc(collection(db, "logs"), {
      action: "Direct Transfer",
      sourceTruckNumber,
      destTruckNumber,
      items,
      timestamp: serverTimestamp(),
    });

    await fetchAll();
    alert("Transfer completed.");
  }

  // ---------- UI pieces ----------
  // helper counts per category
  const categoryCounts = {};
  for (const c of CATEGORIES) categoryCounts[c] = 0;
  for (const s of godown) {
    const feedDoc = findFeed(s.feedId);
    if (feedDoc && CATEGORIES.includes(feedDoc.category)) categoryCounts[feedDoc.category] += Number(s.quantity || 0);
  }
  const totalBags = godown.reduce((acc, s) => acc + Number(s.quantity || 0), 0);

  // ========================= RENDER =========================
  return (
    <div className="app">
      <div className="header">
        <div>
          <h1>Godown Manager</h1>
          <div style={{ fontSize: 13, color: "#6b7280" }}>Categories: {CATEGORIES.join(" • ")}</div>
        </div>
        <div>
          <button className="small form-input" onClick={fetchAll}>Refresh</button>
        </div>
      </div>

      <div className="grid">
        <aside className="sidebar card">
          <button className="side-button" onClick={() => { setPage("dashboard"); setSelectedCategory(null); }}>Dashboard</button>
          <button className="side-button" onClick={() => { setPage("godown"); setSelectedCategory(null); }}>Godown Stock</button>
          <button className="side-button" onClick={() => setPage("truck")}>Truck Management</button>
          <button className="side-button" onClick={() => setPage("transfer")}>Direct Transfer</button>
          <button className="side-button" onClick={() => setPage("logs")}>Logs</button>
          <hr />
          <button className="side-button" onClick={() => { setAdminOpen(true); setIsAdmin(false); }}>Admin Panel</button>
        </aside>

        <main>
          {/* Dashboard */}
          {page === "dashboard" && (
            <div className="card">
              <h2>Dashboard</h2>
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ flex: 1 }} className="card">
                  <h3>Godown Summary</h3>
                  <div>Total bags: <strong>{totalBags}</strong></div>
                  <ul>
                    {CATEGORIES.map(cat => (<li key={cat}>{cat}: <strong>{categoryCounts[cat]}</strong></li>))}
                  </ul>
                </div>
                <div style={{ flex: 1 }} className="card">
                  <h3>Trucks</h3>
                  <div>Registered trucks: <strong>{trucks.length}</strong></div>
                </div>
              </div>
            </div>
          )}

          {/* GODOWN */}
          {page === "godown" && (
            <div className="card">
              <button className="small form-input" onClick={() => { setSelectedCategory(null); }}>All Categories</button>
              <h2>Godown Stock</h2>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                {CATEGORIES.map(cat => (
                  <button key={cat} className="feed-button" onClick={() => setSelectedCategory(cat)}>
                    {cat} — {categoryCounts[cat]} bags
                  </button>
                ))}
              </div>

              <h3>{selectedCategory ? selectedCategory : "All Feeds"}</h3>
              <table className="table">
                <thead><tr><th>Feed</th><th>Category</th><th>Qty</th><th>Actions</th></tr></thead>
                <tbody>
                  {feeds.filter(f => !selectedCategory || f.category === selectedCategory).map(feed => {
                    const s = godown.find(g => g.feedId === feed.id);
                    return (
                      <tr key={feed.id}>
                        <td>{feed.name}</td>
                        <td>{feed.category}</td>
                        <td>{s ? s.quantity : 0}</td>
                        <td>
                          <button className="small form-input" onClick={() => addOrIncreaseGodown(feed.id, 1)}>+1</button>
                          <button className="small form-input" onClick={async () => { try { await decreaseGodown(feed.id, 1); } catch(e){ alert(e.message) } }}>-1</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* TRUCK MANAGEMENT */}
          {page === "truck" && (
            <div className="card">
              <h2>Truck Management — Incoming / Outgoing</h2>
              <TruckForm feeds={feeds} onSubmit={submitTruckEntry} />
              <hr />
              <h3>Recent truck entries</h3>
              <table className="table">
                <thead><tr><th>Time</th><th>Truck</th><th>Type</th><th>Items</th></tr></thead>
                <tbody>
                  {trucks.slice().reverse().map(t => (
                    <tr key={t.id}>
                      <td>{t.createdAt?.seconds ? new Date(t.createdAt.seconds*1000).toLocaleString() : "-"}</td>
                      <td>{t.truckNumber}</td>
                      <td>{t.type}</td>
                      <td>{t.items?.map(it => `${findFeed(it.feedId)?.name||it.feedId}:${it.quantity}`).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* DIRECT TRANSFER */}
          {page === "transfer" && (
            <div className="card">
              <h2>Direct Transfer — Register source truck load / Transfer out</h2>

              <RegisterSourceTruck feeds={feeds} onRegister={registerSourceTruckLoad} />

              <hr />

              <TransferOutSection trucks={trucks} feeds={feeds} onTransfer={transferFromSourceToDest} />

              <hr />
              <h3>Recent transfers</h3>
              <table className="table">
                <thead><tr><th>Time</th><th>From</th><th>To</th><th>Items</th></tr></thead>
                <tbody>
                  {transfers.slice().reverse().map(tr => (
                    <tr key={tr.id}>
                      <td>{tr.timestamp?.seconds ? new Date(tr.timestamp.seconds*1000).toLocaleString() : "-"}</td>
                      <td>{tr.sourceTruckNumber}</td>
                      <td>{tr.destTruckNumber}</td>
                      <td>{tr.items?.map(i => `${findFeed(i.feedId)?.name||i.feedId}:${i.quantity}`).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* LOGS */}
          {page === "logs" && (
            <div className="card">
              <h2>Logs</h2>
              <div style={{ maxHeight:420, overflow:"auto" }}>
                <table className="table">
                  <thead><tr><th>Time</th><th>Action</th><th>Details</th></tr></thead>
                  <tbody>
                    {logs.slice().reverse().map(l => (
                      <tr key={l.id}>
                        <td>{l.timestamp?.seconds ? new Date(l.timestamp.seconds*1000).toLocaleString() : "-"}</td>
                        <td>{l.action}</td>
                        <td style={{ whiteSpace:"pre-wrap" }}>{JSON.stringify(l, null, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>
      </div>

      <div className="footer">Made for your godown — all data in Firestore.</div>

      {/* ADMIN modal */}
      {adminOpen && (
        <div style={{ position:"fixed", inset:0, display:"flex", alignItems:"center", justifyContent:"center", background:"rgba(0,0,0,0.4)" }}>
          <div style={{ background:"white", padding:18, width:560, borderRadius:8 }}>
            <h3>Admin Panel</h3>
            {!isAdmin ? (
              <div>
                <input className="form-input" placeholder="Password" type="password" value={adminPass} onChange={e=>setAdminPass(e.target.value)} />
                <div style={{ marginTop:8 }}>
                  <button className="small form-input" onClick={() => { if (adminPass === ADMIN_PASS) { setIsAdmin(true); setAdminPass(""); } else alert("Wrong password"); }}>Unlock</button>
                  <button className="small form-input" onClick={() => { setAdminOpen(false); setAdminPass(""); }}>Close</button>
                </div>
              </div>
            ) : (
              <AdminPanel
                feeds={feeds}
                categories={CATEGORIES}
                onAdd={handleAddFeed}
                onEdit={handleEditFeed}
                onDelete={handleDeleteFeed}
                onClose={() => { setAdminOpen(false); setIsAdmin(false); fetchAll(); }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------- Subcomponents ----------------- */

function TruckForm({ feeds, onSubmit }) {
  const [truckNumber, setTruckNumber] = useState("");
  const [type, setType] = useState("incoming");
  const [destinations, setDestinations] = useState("");
  const [selectedFeed, setSelectedFeed] = useState(feeds[0]?.id || "");
  const [qty, setQty] = useState("");
  const [items, setItems] = useState([]);

  useEffect(() => { if (feeds[0] && !selectedFeed) setSelectedFeed(feeds[0].id); }, [feeds, selectedFeed]);

  function addItem() {
    if (!selectedFeed || !qty) return alert("choose feed and qty");
    setItems(prev => {
      const existing = prev.find(i => i.feedId === selectedFeed);
      if (existing) {
        return prev.map(i => i.feedId === selectedFeed ? { ...i, quantity: i.quantity + Number(qty) } : i);
      } else return [...prev, { feedId: selectedFeed, quantity: Number(qty) }];
    });
    setQty("");
  }

  function removeItem(feedId) {
    setItems(prev => prev.filter(i => i.feedId !== feedId));
  }

  function submit() {
    if (!truckNumber) return alert("truck number required");
    if (items.length === 0) return alert("add items");
    onSubmit({ truckNumber, type, destinations, items });
    setTruckNumber(""); setType("incoming"); setDestinations(""); setItems([]);
  }

  return (
    <div>
      <div className="row" style={{ marginBottom:8 }}>
        <input className="form-input" placeholder="Truck Number" value={truckNumber} onChange={e=>setTruckNumber(e.target.value)} />
        <select className="form-input" value={type} onChange={e=>setType(e.target.value)} style={{ minWidth:200 }}>
          <option value="incoming">Incoming (add to godown)</option>
          <option value="outgoing">Outgoing (deduct from godown)</option>
        </select>
        <input className="form-input" placeholder="Destinations (comma separated)" value={destinations} onChange={e=>setDestinations(e.target.value)} />
      </div>

      <div style={{ marginBottom:8 }}>
        <select className="form-input" value={selectedFeed} onChange={e=>setSelectedFeed(e.target.value)}>
          {feeds.map(f => <option key={f.id} value={f.id}>{f.name} ({f.category})</option>)}
        </select>
        <input className="form-input" placeholder="Qty" value={qty} onChange={e=>setQty(e.target.value)} style={{ width:120, marginLeft:8 }} />
        <button className="small form-input" onClick={addItem} style={{ marginLeft:8 }}>Add</button>
      </div>

      <div>
        {items.map(it => <div key={it.feedId} className="row" style={{ marginBottom:6 }}>
          <div style={{ minWidth:260 }}>{feeds.find(f=>f.id===it.feedId)?.name || it.feedId}</div>
          <div>Qty: {it.quantity}</div>
          <button className="small form-input" onClick={()=>removeItem(it.feedId)}>Remove</button>
        </div>)}
      </div>

      <div style={{ marginTop:8 }}>
        <button className="small form-input" onClick={submit}>Submit Truck Entry</button>
      </div>
    </div>
  );
}

function RegisterSourceTruck({ feeds, onRegister }) {
  const [truckNumber, setTruckNumber] = useState("");
  const [items, setItems] = useState([]);
  const [selectedFeed, setSelectedFeed] = useState(feeds[0]?.id || "");
  const [qty, setQty] = useState("");

  useEffect(() => { if (feeds[0] && !selectedFeed) setSelectedFeed(feeds[0].id); }, [feeds]);

  function addItem() {
    if (!selectedFeed || !qty) return alert("choose feed and qty");
    setItems(prev => {
      const ex = prev.find(p => p.feedId === selectedFeed);
      if (ex) return prev.map(p => p.feedId === selectedFeed ? { ...p, quantity: p.quantity + Number(qty) } : p);
      return [...prev, { feedId: selectedFeed, quantity: Number(qty) }];
    });
    setQty("");
  }

  function removeItem(fid) { setItems(prev => prev.filter(p => p.feedId !== fid)); }

  function register() {
    if (!truckNumber) return alert("Enter truck number");
    if (!items.length) return alert("Add items");
    onRegister(truckNumber, items);
    setTruckNumber(""); setItems([]);
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <h4>Register Source Truck Load (type truck number)</h4>
      <div className="row" style={{ marginBottom:8 }}>
        <input className="form-input" placeholder="Truck Number (source)" value={truckNumber} onChange={e=>setTruckNumber(e.target.value)} />
      </div>
      <div className="row" style={{ marginBottom:8 }}>
        <select className="form-input" value={selectedFeed} onChange={e=>setSelectedFeed(e.target.value)}>
          {feeds.map(f => <option key={f.id} value={f.id}>{f.name} ({f.category})</option>)}
        </select>
        <input className="form-input" placeholder="Qty" value={qty} onChange={e=>setQty(e.target.value)} style={{ width:120 }} />
        <button className="small form-input" onClick={addItem}>Add</button>
      </div>
      <div>
        {items.map(it => (<div key={it.feedId} className="row" style={{ marginBottom:6 }}>
          <div style={{ minWidth:220 }}>{feeds.find(f=>f.id===it.feedId)?.name}</div>
          <div>Qty: {it.quantity}</div>
          <button className="small form-input" onClick={()=>removeItem(it.feedId)}>Remove</button>
        </div>))}
      </div>
      <div style={{ marginTop:8 }}>
        <button className="small form-input" onClick={register}>Register Truck Load</button>
      </div>
    </div>
  );
}

function TransferOutSection({ trucks, feeds, onTransfer }) {
  const [sourceTruckNumber, setSourceTruckNumber] = useState("");
  const [destTruckNumber, setDestTruckNumber] = useState("");
  const [items, setItems] = useState([]);
  const [selectedFeed, setSelectedFeed] = useState(feeds[0]?.id || "");
  const [qty, setQty] = useState("");

  useEffect(()=>{ if(feeds[0] && !selectedFeed) setSelectedFeed(feeds[0].id); }, [feeds]);

  function addItem() {
    if(!selectedFeed || !qty) return alert("choose feed and qty");
    setItems(prev => {
      const ex = prev.find(p=>p.feedId===selectedFeed);
      if (ex) return prev.map(p=> p.feedId===selectedFeed ? {...p, quantity: p.quantity + Number(qty)} : p);
      return [...prev, { feedId: selectedFeed, quantity: Number(qty) }];
    });
    setQty("");
  }
  function removeItem(fid){ setItems(prev => prev.filter(p=>p.feedId !== fid)); }

  async function submit() {
    if (!sourceTruckNumber) return alert("Type source truck number (must be registered)");
    if (!destTruckNumber) return alert("Type destination truck number");
    if (!items.length) return alert("Add items");
    await onTransfer({ sourceTruckNumber, destTruckNumber, items });
    setSourceTruckNumber(""); setDestTruckNumber(""); setItems([]);
  }

  return (
    <div>
      <h4>Transfer Outgoing</h4>
      <div className="row" style={{ marginBottom:8 }}>
        <input className="form-input" placeholder="Source Truck (type number)" value={sourceTruckNumber} onChange={e=>setSourceTruckNumber(e.target.value)} />
        <input className="form-input" placeholder="Destination Truck (type number)" value={destTruckNumber} onChange={e=>setDestTruckNumber(e.target.value)} />
      </div>

      <div className="row" style={{ marginBottom:8 }}>
        <select className="form-input" value={selectedFeed} onChange={e=>setSelectedFeed(e.target.value)}>
          {feeds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <input className="form-input" placeholder="Qty" value={qty} onChange={e=>setQty(e.target.value)} style={{ width:120 }} />
        <button className="small form-input" onClick={addItem}>Add</button>
      </div>

      <div>
        {items.map(it => <div key={it.feedId} className="row" style={{ marginBottom:6 }}>
          <div style={{ minWidth:220 }}>{feeds.find(f=>f.id===it.feedId)?.name}</div>
          <div>Qty: {it.quantity}</div>
          <button className="small form-input" onClick={()=>removeItem(it.feedId)}>Remove</button>
        </div>)}
      </div>

      <div style={{ marginTop:8 }}>
        <button className="small form-input" onClick={submit}>Submit Transfer</button>
      </div>
    </div>
  );
}

function AdminPanel({ feeds, categories, onAdd, onEdit, onDelete, onClose }) {
  const [name, setName] = useState("");
  const [cat, setCat] = useState(categories[0] || "");
  const [price, setPrice] = useState("");
  const [initialQty, setInitialQty] = useState("");

  async function handleAdd() {
    if (!name || !cat) return alert("Fill name & category");
    await onAdd({ name, category: cat, price: Number(price || 0) }, Number(initialQty || 0));
    setName(""); setPrice(""); setInitialQty("");
  }

  return (
    <div>
      <h4>Add New Feed</h4>
      <div className="row">
        <input className="form-input" placeholder="Feed name" value={name} onChange={e=>setName(e.target.value)} />
        <select className="form-input" value={cat} onChange={e=>setCat(e.target.value)}>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className="form-input" placeholder="Price" value={price} onChange={e=>setPrice(e.target.value)} style={{ width:100 }} />
        <input className="form-input" placeholder="Initial Qty (optional)" value={initialQty} onChange={e=>setInitialQty(e.target.value)} style={{ width:140 }} />
        <button className="small form-input" onClick={handleAdd}>Add Feed</button>
      </div>

      <h4 style={{ marginTop:12 }}>Existing Feeds</h4>
      <div style={{ maxHeight:220, overflow:"auto" }}>
        <table className="table">
          <thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Actions</th></tr></thead>
          <tbody>
            {feeds.map(f => (
              <tr key={f.id}>
                <td>{f.name}</td>
                <td>{f.category}</td>
                <td>{f.price}</td>
                <td>
                  <button className="small form-input" onClick={() => {
                    const newName = prompt("New name", f.name);
                    const newPrice = prompt("New price", f.price);
                    const newCat = prompt("New category", f.category);
                    if (newName) onEdit(f.id, { name: newName, price: Number(newPrice||0), category: newCat || f.category });
                  }}>Edit</button>
                  <button className="small form-input" onClick={() => { if (window.confirm("Delete feed?")) onDelete(f.id); }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop:8 }}>
        <button className="small form-input" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
