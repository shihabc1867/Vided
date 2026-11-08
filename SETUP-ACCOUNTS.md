# Vided অ্যাকাউন্ট ও Pro প্ল্যান চালু করার গাইড (ফ্রি)

কিছু না করলেও অ্যাপ আগের মতোই চলবে (সব ফিচার আনলকড)। অ্যাকাউন্ট চালু করতে নিচের ধাপগুলো করুন।

## ১. Supabase প্রজেক্ট (ফ্রি)
1. supabase.com এ সাইন আপ করে **New project** খুলুন।
2. বাম মেনুতে **SQL Editor → New query** এ যান। `supabase-setup.sql` ফাইলের পুরো লেখা পেস্ট করে **Run** চাপুন।
3. **Authentication → Email Templates → Magic Link** এ গিয়ে মেইলের লেখায় `{{ .Token }}` যোগ করুন (যেমন: `Your Vided code: {{ .Token }}`)। এতে ইউজার ৬ সংখ্যার কোড পাবে।
4. **Project Settings → API** থেকে `Project URL` ও `anon public` key কপি করুন।

## ২. config.js ভরুন
`config.js` খুলে `supabaseUrl` ও `supabaseKey` বসান। `upgradeUrl` এ পেমেন্টের লিংক বা যোগাযোগের লিংক (WhatsApp/Messenger/বিকাশ নির্দেশনার পেজ) দিন। **service_role key কখনো এখানে বসাবেন না।**

## ৩. Pro দেওয়ার উপায়
- **কোড দিয়ে (সবচেয়ে সহজ, বিকাশ/নগদের সাথে মানায়):** ইউজার টাকা পাঠালে তাকে একটি কোড দিন। SQL Editor এ চালান:
  `insert into public.codes (code, days) select upper(substr(md5(random()::text),1,10)), 30 from generate_series(1,10);`
  `select code, days from public.codes where used_by is null;`
  ইউজার Account ট্যাবে কোড বসালেই Pro (৩০ দিন)।
- **হাতে দিয়ে:** `update public.profiles set plan='pro', plan_until=now()+interval '365 days' where email='user@example.com';`
- **অটোমেটিক পেমেন্ট (পরে):** Stripe/SSLCommerz এর webhook দিয়ে একটি Supabase Edge Function ঐ `profiles` লাইন আপডেট করবে। অ্যাপের দিকে কিছু বদলাতে হবে না।

## ফ্রি লিমিট
- ফ্রি: ৭২০p পর্যন্ত এক্সপোর্ট + ছোট ওয়াটারমার্ক। Pro: ১০৮০p, ওয়াটারমার্ক নেই, ক্লাউড ব্যাকআপ।
- Supabase ফ্রি: ৫০০MB ডাটাবেস, ১GB স্টোরেজ, মাসে ৫০,০০০ সক্রিয় ইউজার, ইমেইল কোড পাঠানোর সীমা সীমিত (শুরুতে ঘণ্টায় কয়েকটি; ইউজার বাড়লে নিজের SMTP যোগ করুন, যেমন Resend ফ্রি)।
- ব্যাকআপ ফাইল ৪০MB করে টুকরো হয়ে যায় (ফ্রি প্ল্যানে ফাইলপ্রতি ৫০MB সীমা)।

## সীমাবদ্ধতা (সৎভাবে)
ভিডিও ফোনেই এডিট ও এক্সপোর্ট হয়, তাই ওয়াটারমার্ক/৭২০p সীমা কেউ ব্রাউজারের কোড বদলে এড়াতে পারে। সাধারণ ইউজারদের জন্য যথেষ্ট; কঠোর সুরক্ষা লাগলে এক্সপোর্ট সার্ভারে করতে হবে (যা খরচ বাড়ায়)। ক্লাউড ব্যাকআপ ও কোড সার্ভারে নিরাপদ (RLS)।
