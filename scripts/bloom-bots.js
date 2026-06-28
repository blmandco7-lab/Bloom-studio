// ============================================================
// BLOOM STUDIO — GITHUB ACTIONS BOTS
// Runs daily on GitHub's free servers
// ============================================================
 
const admin = require('firebase-admin');
 
// Initialize Firebase Admin
let db;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;
  
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID
    });
  } else {
    // Use application default credentials
    admin.initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID
    });
  }
  db = admin.firestore();
  console.log('✅ Firebase connected');
} catch(e) {
  console.error('Firebase init error:', e.message);
  process.exit(1);
}
 
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const TODAY = new Date();
 
// ── HELPER: Write alert to Firestore (shows in app Notifications) ──
async function writeAlert(type, title, message, priority = 'normal') {
  try {
    await db.collection('studio-notifications').add({
      type,
      title,
      message,
      priority,
      read: false,
      _ts: admin.firestore.FieldValue.serverTimestamp(),
      _created: new Date().toISOString()
    });
    console.log(`📨 Alert: ${title}`);
  } catch(e) {
    console.error('Alert write error:', e.message);
  }
}
 
// ── HELPER: Days between two dates ──
function daysBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}
 
// ── HELPER: Call Gemini AI ──
async function callGemini(prompt) {
  if (!GEMINI_KEY) return null;
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 200, temperature: 0.7 }
        })
      }
    );
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch(e) {
    console.error('Gemini error:', e.message);
    return null;
  }
}
 
// ══════════════════════════════════════════════════════
// BOT 1: RETENTION BOT
// Checks all creators, flags inactive ones
// ══════════════════════════════════════════════════════
async function retentionBot() {
  console.log('\n🤖 Running Retention Bot...');
  try {
    const snap = await db.collection('studio-missions')
      .where('status', '==', 'Active')
      .get();
    
    let flagged = 0;
    for (const doc of snap.docs) {
      const mission = doc.data();
      const lastUpdate = mission._updated || mission._created;
      if (!lastUpdate) continue;
      
      const daysSince = daysBetween(lastUpdate, TODAY.toISOString());
      
      if (daysSince >= 7) {
        flagged++;
        const msg = `${mission.creator || 'A creator'} has been inactive for ${daysSince} days on mission: ${mission.name || 'Unknown'}`;
        await writeAlert('retention', `⚠️ Creator inactive ${daysSince} days`, msg, daysSince >= 14 ? 'high' : 'normal');
        
        // Generate AI check-in message
        if (GEMINI_KEY && daysSince >= 10) {
          const prompt = `Write a short friendly check-in message (under 60 words) from Bloom & Co Network to creator ${mission.creator || 'the creator'} who hasn't updated their mission "${mission.name || 'campaign'}" in ${daysSince} days. Warm but motivating tone.`;
          const aiMsg = await callGemini(prompt);
          if (aiMsg) {
            await db.collection('studio-notifications').add({
              type: 'ai-checkin',
              title: `AI check-in ready for ${mission.creator || 'creator'}`,
              message: aiMsg,
              priority: 'normal',
              read: false,
              _ts: admin.firestore.FieldValue.serverTimestamp(),
              _created: new Date().toISOString()
            });
          }
        }
      }
    }
    console.log(`✅ Retention bot: ${flagged} creators flagged`);
  } catch(e) {
    console.error('Retention bot error:', e.message);
  }
}
 
// ══════════════════════════════════════════════════════
// BOT 2: CONTRACT RENEWAL BOT
// Flags contracts expiring within 30 days
// ══════════════════════════════════════════════════════
async function contractRenewalBot() {
  console.log('\n🤖 Running Contract Renewal Bot...');
  try {
    const snap = await db.collection('studio-ndas').get();
    let flagged = 0;
    
    for (const doc of snap.docs) {
      const contract = doc.data();
      if (!contract.expires) continue;
      
      const daysUntilExpiry = daysBetween(TODAY.toISOString(), contract.expires);
      
      if (daysUntilExpiry >= 0 && daysUntilExpiry <= 30) {
        flagged++;
        const urgency = daysUntilExpiry <= 7 ? '🚨 URGENT' : '⚠️';
        await writeAlert(
          'contract-renewal',
          `${urgency} Contract expiring in ${daysUntilExpiry} days`,
          `${contract.party || 'Unknown'} — ${contract.type || 'Agreement'} expires on ${contract.expires}`,
          daysUntilExpiry <= 7 ? 'high' : 'normal'
        );
      }
    }
    console.log(`✅ Contract bot: ${flagged} expiring soon`);
  } catch(e) {
    console.error('Contract bot error:', e.message);
  }
}
 
// ══════════════════════════════════════════════════════
// BOT 3: INVOICE REMINDER BOT  
// Flags overdue invoices
// ══════════════════════════════════════════════════════
async function invoiceReminderBot() {
  console.log('\n🤖 Running Invoice Reminder Bot...');
  try {
    const snap = await db.collection('studio-pending-invoices')
      .where('status', '==', 'pending')
      .get();
    
    let flagged = 0;
    for (const doc of snap.docs) {
      const invoice = doc.data();
      const created = invoice._created;
      if (!created) continue;
      
      const daysSince = daysBetween(created, TODAY.toISOString());
      
      if (daysSince >= 7) {
        flagged++;
        await writeAlert(
          'invoice',
          `💰 Invoice unpaid ${daysSince} days`,
          `${invoice.brandName || 'Brand'} — $${invoice.amount || '?'} — submitted ${daysSince} days ago`,
          daysSince >= 14 ? 'high' : 'normal'
        );
      }
    }
    console.log(`✅ Invoice bot: ${flagged} overdue`);
  } catch(e) {
    console.error('Invoice bot error:', e.message);
  }
}
 
// ══════════════════════════════════════════════════════
// BOT 4: BRAND INQUIRY BOT
// Flags new inquiries that haven't been responded to
// ══════════════════════════════════════════════════════
async function brandInquiryBot() {
  console.log('\n🤖 Running Brand Inquiry Bot...');
  try {
    const snap = await db.collection('studio-brand-inquiries')
      .where('status', '==', 'new')
      .get();
    
    let flagged = 0;
    for (const doc of snap.docs) {
      const inquiry = doc.data();
      const created = inquiry._created;
      if (!created) continue;
      
      const hoursSince = (TODAY - new Date(created)) / (1000 * 60 * 60);
      
      if (hoursSince >= 24) {
        flagged++;
        await writeAlert(
          'brand-inquiry',
          `📬 Brand inquiry needs response`,
          `${inquiry.brandName || 'A brand'} submitted an inquiry ${Math.floor(hoursSince)} hours ago — Budget: ${inquiry.budget || 'Unknown'}`,
          hoursSince >= 48 ? 'high' : 'normal'
        );
      }
    }
    console.log(`✅ Brand inquiry bot: ${flagged} need response`);
  } catch(e) {
    console.error('Brand inquiry bot error:', e.message);
  }
}
 
// ══════════════════════════════════════════════════════
// BOT 5: W-9 REMINDER BOT
// Flags creators without W-9 on file
// ══════════════════════════════════════════════════════
async function w9ReminderBot() {
  console.log('\n🤖 Running W-9 Reminder Bot...');
  try {
    const paymentsSnap = await db.collection('studio-payments').get();
    const w9Snap = await db.collection('studio-w9s').get();
    
    const w9Creators = new Set();
    w9Snap.forEach(doc => {
      const d = doc.data();
      if (d.status === 'Received' || d.status === 'On file') {
        w9Creators.add(d.creator);
      }
    });
    
    const missingW9 = new Set();
    paymentsSnap.forEach(doc => {
      const d = doc.data();
      if (d.creator && !w9Creators.has(d.creator)) {
        missingW9.add(d.creator);
      }
    });
    
    if (missingW9.size > 0) {
      await writeAlert(
        'w9',
        `📋 ${missingW9.size} creator(s) missing W-9`,
        `Missing W-9: ${Array.from(missingW9).join(', ')}. Required before year-end tax filing.`,
        'normal'
      );
    }
    console.log(`✅ W-9 bot: ${missingW9.size} missing`);
  } catch(e) {
    console.error('W-9 bot error:', e.message);
  }
}
 
// ══════════════════════════════════════════════════════
// BOT 6: DAILY BRIEFING BOT
// Writes AI daily briefing and saves to Firestore
// ══════════════════════════════════════════════════════
async function dailyBriefingBot() {
  console.log('\n🤖 Running Daily Briefing Bot...');
  try {
    // Gather stats
    const [dealsSnap, inquiriesSnap, paymentsSnap] = await Promise.all([
      db.collection('studio-deals').where('stage', '==', 'Live').get(),
      db.collection('studio-brand-inquiries').where('status', '==', 'new').get(),
      db.collection('studio-payments').get()
    ]);
    
    const liveDeals = dealsSnap.size;
    const newInquiries = inquiriesSnap.size;
    const totalRevenue = 0;
    
    paymentsSnap.forEach(doc => {
      const d = doc.data();
    });
 
    if (GEMINI_KEY) {
      const prompt = `Write a brief daily briefing (3 sentences max) for Bloom & Co Network talent agency. Stats today: ${liveDeals} live deals, ${newInquiries} new brand inquiries. Date: ${TODAY.toDateString()}. Motivating and professional tone. Start with "Good morning Bloom & Co —"`;
      
      const briefing = await callGemini(prompt);
      if (briefing) {
        await db.collection('studio-config').doc('daily-briefing').set({
          text: briefing,
          date: TODAY.toISOString(),
          stats: { liveDeals, newInquiries },
          _ts: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log('✅ Daily briefing written');
      }
    }
  } catch(e) {
    console.error('Daily briefing bot error:', e.message);
  }
}
 
// ══════════════════════════════════════════════════════
// RUN ALL BOTS
// ══════════════════════════════════════════════════════
async function runAllBots() {
  console.log('🚀 Bloom Studio Bots starting...');
  console.log(`📅 Date: ${TODAY.toDateString()}`);
  
  await retentionBot();
  await contractRenewalBot();
  await invoiceReminderBot();
  await brandInquiryBot();
  await w9ReminderBot();
  await dailyBriefingBot();
  
  console.log('\n✅ All bots complete!');
  process.exit(0);
}
 
runAllBots().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
 
