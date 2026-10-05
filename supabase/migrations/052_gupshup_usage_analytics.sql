-- Gupshup usage analytics credential
--
-- The existing gupshup_api_key is the legacy api.gupshup.io credential used
-- by the message-send provider. Gupshup's Partner Usage API is a separate
-- surface and requires a Partner App Access Token in the Authorization header.
-- Keep the two credentials distinct; both values are encrypted by the app
-- before storage.

alter table public.whatsapp_config
  add column if not exists gupshup_partner_app_token text;

comment on column public.whatsapp_config.gupshup_partner_app_token is
  'AES-256-GCM encrypted Gupshup Partner App Access Token used only for Partner Usage/Billing analytics APIs.';
