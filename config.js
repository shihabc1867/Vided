/* Vided settings. Fill these in after following SETUP-ACCOUNTS.md.
   While supabaseUrl is empty, accounts are switched off and every feature is unlocked.
   The anon key is meant to be public (it is safe in a website); never put a "service_role" key here. */
window.VIDED_CONFIG = {
  supabaseUrl: '',          // e.g. 'https://abcdxyz.supabase.co'
  supabaseKey: '',          // the "anon public" key from Supabase > Project Settings > API
  upgradeUrl: '',           // where "Upgrade to Pro" sends people: a payment link, a bKash instruction page, a WhatsApp/Messenger link...
  pay: {                    // bKash / Nagad manual payment (users send money, then submit the Transaction ID in the app)
    price: '',              // e.g. '৳199 for 30 days'
    days: 30,               // must match the days used when approving (the database uses 30 by default)
    bkash: '',              // your bKash Personal number, e.g. '01XXXXXXXXX'  (leave empty to hide)
    nagad: '',              // your Nagad Personal number
    hours: 'a few hours'    // how fast you usually approve
  },
  freeMaxRes: 720,          // highest export height (short side) on the free plan
  watermark: 'Made with Vided',
  proPerks: [
    '1080p Full HD export',
    'No watermark',
    'Cloud backup of projects on any phone'
  ]
};
