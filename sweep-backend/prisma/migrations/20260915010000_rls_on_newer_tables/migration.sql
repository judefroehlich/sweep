-- RLS on the three tables added since 20260817000000_enable_rls.
--
-- Same reasoning as that migration: Supabase exposes every table in `public`
-- through PostgREST, authorised by a key that ships inside the Android app.
-- Enabling RLS with no policies denies everything through that route, while
-- the backend keeps working because Prisma connects as the table owner and
-- owners bypass RLS.
--
-- Nothing here is personal — visit counts are aggregate and credit counts are
-- ours — but "not sensitive" is not the test. Writable is: an open PATCH on
-- ProviderCredit could silence the alert that says Walmart is about to stop
-- working, and an open SiteVisit could make the traffic numbers say anything.
--
-- Already enabled by hand in production; enabling twice is a no-op, and this
-- is what keeps a fresh database identical to it.
ALTER TABLE public."SiteVisit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ProviderCredit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ProviderCreditDay" ENABLE ROW LEVEL SECURITY;
