/* Vided settings. Fill these in after following SETUP-ACCOUNTS.md.
   While supabaseUrl is empty, accounts are switched off and every feature is unlocked.
   The anon key is meant to be public (it is safe in a website); never put a "service_role" key here. */
window.VIDED_CONFIG = {
  supabaseUrl: '',          // e.g. 'https://abcdxyz.supabase.co'
  supabaseKey: '',          // the "anon public" key from Supabase > Project Settings > API
  upgradeUrl: '',           // where "Upgrade to Pro" sends people: a payment link, a bKash instruction page, a WhatsApp/Messenger link...
  freeMaxRes: 720,          // highest export height (short side) on the free plan
  watermark: 'Made with Vided',
  proPerks: [
    '1080p Full HD export',
    'No watermark',
    'Cloud backup of projects on any phone'
  ]
};
