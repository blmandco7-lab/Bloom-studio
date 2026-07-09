// Bloom Studio — Daily Bots
//
// Runs on a schedule via GitHub Actions (see .github/workflows/daily-bots.yml).
// Connects to your EXISTING Firestore database — same one your app already
// uses — using a Firebase service account (admin) credential. It does not
// change your app's code, your data model, or add any new collections
// beyond the ones your app already reads (studio-notifications, studio-audit-trail).
//
// What it checks, once per run:
//   1. Contracts expiring within 30 days
//   2. Payments that are overdue or due within 3 days
//   3. W-9s that are missing/pending with a deadline within 7 days (or passed)
//   4. Creators with no logged activity in 11+ days (retention)
//
// Anything it finds becomes a real document in studio-notifications, which
// your Notifications screen already knows how to display — no app changes
// needed. It also (optionally) posts a short summary to Slack if you've
// already configured a Slack webhook in Integrations.

const admin = require('firebase-admin');

// ---- Setup: connect using the service account stored in GitHub Secrets ----
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountJson) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT environment variable/secret. See README.md.');
  process.exit(1);
}
const serviceAccount = JSON.parse(serviceAccountJson);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const nowISO = () => new Date().toISOString();

async function addNotification(title, detail, type) {
  await db.collection('studio-notifications').add({
    title,
    detail,
    type, // 'alert' | 'warning' | 'info' | 'success'
    _created: nowISO(),
    _updated: nowISO(),
  });
}

async function logAudit(action, detail) {
  await db.collection('studio-audit-trail').add({
    action,
    detail,
    byUser: 'Daily bots (automated)',
    role: 'system',
    _created: nowISO(),
    _updated: nowISO(),
  });
}

function daysBetween(dateStr, from = new Date()) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  if (isNaN(target.getTime())) return null;
  return Math.round((target - from) / 86400000);
}

async function getAll(collection) {
  const snap = await db.collection(collection).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ---- 1. Contract renewals ----
async function checkContracts() {
  const contracts = await getAll('studio-contracts');
  let flagged = 0;
  for (const c of contracts) {
    const days = daysBetween(c.end);
    if (days === null || days < 0) continue; // no end date, or already expired (handled separately below)
    if (days <= 30) {
      await addNotification(
        `Contract expiring — ${c.party || 'party'}`,
        `${c.type || 'Contract'} expires in ${days} day${days === 1 ? '' : 's'} (${c.end}). Renew or follow up soon.`,
        days <= 7 ? 'alert' : 'warning'
      );
      flagged++;
    }
  }
  return flagged;
}

// ---- 2. Payment schedule ----
async function checkPayments() {
  const payments = await getAll('studio-payment-schedule');
  let flagged = 0;
  for (const p of payments) {
    if (p.status === 'Paid') continue;
    const days = daysBetween(p.due);
    if (days === null) continue;
    if (days < 0) {
      await addNotification(
        `Payment overdue — ${p.who || 'unknown'}`,
        `${p.desc || 'Scheduled payment'} was due ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago ($${p.amount || 0}). Follow up.`,
        'alert'
      );
      flagged++;
    } else if (days <= 3) {
      await addNotification(
        `Payment due soon — ${p.who || 'unknown'}`,
        `${p.desc || 'Scheduled payment'} is due in ${days} day${days === 1 ? '' : 's'} ($${p.amount || 0}).`,
        'warning'
      );
      flagged++;
    }
  }
  return flagged;
}

// ---- 3. W-9 deadlines ----
async function checkW9s() {
  const w9s = await getAll('studio-w9s');
  let flagged = 0;
  for (const w of w9s) {
    if (w.status === 'On file') continue;
    const days = daysBetween(w.deadline);
    if (days === null) continue;
    if (days <= 7) {
      const label = days < 0 ? `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} past deadline` : `due in ${days} day${days === 1 ? '' : 's'}`;
      await addNotification(
        `W-9 missing — ${w.name || 'creator'}`,
        `Still not on file, ${label}. Can't process payment without this.`,
        days < 0 ? 'alert' : 'warning'
      );
      flagged++;
    }
  }
  return flagged;
}

// ---- 4. Creator retention (inactivity) ----
async function checkRetention() {
  const [roster, activity] = await Promise.all([
    getAll('studio-roster'),
    getAll('studio-activity-log'),
  ]);
  let flagged = 0;
  for (const creator of roster) {
    if (!creator.handle) continue;
    const related = activity.filter(
      (a) => a.who && a.who.toLowerCase().includes(creator.handle.toLowerCase())
    );
    let mostRecentDays = null;
    if (related.length) {
      const mostRecent = related.reduce((latest, a) =>
        new Date(a._created) > new Date(latest._created) ? a : latest
      );
      mostRecentDays = daysBetween(mostRecent._created);
    }
    // No logged activity at all, or none in 11+ days
    if (mostRecentDays === null || mostRecentDays >= 11) {
      const context = mostRecentDays === null ? 'no logged check-ins yet' : `${mostRecentDays} days since last logged activity`;
      await addNotification(
        `Check in — ${creator.handle}`,
        `${context}. Worth a quick message to keep the relationship warm.`,
        'warning'
      );
      flagged++;
    }
  }
  return flagged;
}

// ---- 5. Auto-generate invoices when a deal is marked Completed ----
async function checkClosedDeals() {
  const deals = await getAll('studio-deals');
  let flagged = 0;
  for (const d of deals) {
    if (d.stage !== 'Completed') continue;
    if (d._invoiced) continue; // already handled on a previous run — skip

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30); // standard 30-day payment term

    const invoiceRef = await db.collection('studio-invoices').add({
      to: d.brand || 'Brand',
      forWork: `${d.creator || 'Creator'} — ${d.notes || 'Completed campaign'}`,
      amount: d.budget || 0,
      due: dueDate.toISOString().slice(0, 10),
      notes: 'Auto-generated when this deal was marked Completed.',
      status: 'Pending',
      _created: nowISO(),
      _updated: nowISO(),
    });

    // Mirror what the app itself does when a human creates an invoice —
    // also add a matching entry to the payment schedule.
    await db.collection('studio-payment-schedule').add({
      who: d.brand || 'Brand',
      desc: `Invoice for ${d.creator || 'creator'} — ${d.notes || 'completed campaign'}`,
      direction: 'Incoming (from brand)',
      amount: d.budget || 0,
      due: dueDate.toISOString().slice(0, 10),
      status: 'Due',
      _created: nowISO(),
      _updated: nowISO(),
    });

    // Mark the deal so it's never invoiced twice on future runs
    await db.collection('studio-deals').doc(d.id).update({ _invoiced: true, _updated: nowISO() });

    await addNotification(
      `Invoice created — ${d.brand || 'brand'}`,
      `${d.creator || 'Creator'}'s deal was marked Completed, so an invoice for $${d.budget || 0} (invoice #${invoiceRef.id.slice(0, 6)}) and a matching payment reminder were created automatically. Due ${dueDate.toISOString().slice(0, 10)}.`,
      'success'
    );
    flagged++;
  }
  return flagged;
}

// ---- Optional: post a short summary to Slack, if configured ----
async function postSlackSummary(counts, totalFlagged) {
  try {
    const configDoc = await db.collection('studio-config').doc('api-keys').get();
    const webhook = configDoc.exists ? configDoc.data().slack : null;
    if (!webhook) return; // no Slack connected — that's fine, skip silently

    const lines = [
      `*Bloom Studio — daily bot run*`,
      `Contracts flagged: ${counts.contracts}`,
      `Payments flagged: ${counts.payments}`,
      `W-9s flagged: ${counts.w9s}`,
      `Retention check-ins: ${counts.retention}`,
      `Invoices auto-created: ${counts.invoicing}`,
      totalFlagged === 0 ? '_Nothing needs attention today._' : `_${totalFlagged} item(s) added to Notifications._`,
    ];
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
    });
  } catch (e) {
    console.error('Slack summary failed (non-fatal):', e.message);
  }
}

async function main() {
  console.log('Bloom Studio daily bots — starting run at', nowISO());

  const counts = {
    contracts: await checkContracts(),
    payments: await checkPayments(),
    w9s: await checkW9s(),
    retention: await checkRetention(),
    invoicing: await checkClosedDeals(),
  };
  const totalFlagged = Object.values(counts).reduce((a, b) => a + b, 0);

  await logAudit('Daily bots ran', `Flagged ${totalFlagged} item(s) — contracts:${counts.contracts} payments:${counts.payments} w9s:${counts.w9s} retention:${counts.retention} invoicing:${counts.invoicing}`);
  await postSlackSummary(counts, totalFlagged);

  console.log('Done. Counts:', counts, '| Total flagged:', totalFlagged);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Daily bots run failed:', err);
    process.exit(1);
  });
